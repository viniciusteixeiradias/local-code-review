import { basename, join } from "node:path";
import { statSync } from "node:fs";
import { parseDiff, untrackedDiff } from "./diff.ts";
import type { DiffOptions, DiffSnapshot, DiffTarget, FileDiff, Side } from "./types.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const FULL_CONTEXT = 1_000_000;

export interface Repo {
  root: string;
  gitDir: string;
  name: string;
}

const BASE_ARGS = ["-c", "core.quotePath=false", "-c", "color.ui=false"];

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; okCodes?: number[] } = {}): Promise<string> {
  const p = Bun.spawn(["git", ...BASE_ARGS, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.okCodes?.includes(code)) {
    if (opts.allowFail) return "";
    throw new Error(`git ${args.join(" ")}: ${err.trim() || `exit ${code}`}`);
  }
  return out;
}

export function gitSync(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...BASE_ARGS, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

export function findRepo(cwd = process.cwd()): Repo {
  const top = gitSync(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error("Not inside a git repository.");
  const root = top.out.trim();
  const gitDir = gitSync(root, ["rev-parse", "--absolute-git-dir"]).out.trim();
  return { root, gitDir, name: basename(root) };
}

async function resolveBase(repo: Repo, target: DiffTarget): Promise<{ rev: string; label: string }> {
  const head = (await git(repo.root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim();
  if (target.kind === "base" && target.ref) {
    const mb = (await git(repo.root, ["merge-base", target.ref, head || target.ref], { allowFail: true })).trim();
    const rev = mb || (await git(repo.root, ["rev-parse", "--verify", target.ref])).trim();
    return { rev, label: `${target.ref} (${rev.slice(0, 7)}) → working tree` };
  }
  const rev = head || EMPTY_TREE;
  return { rev, label: target.kind === "staged" ? "HEAD → staged" : "HEAD → working tree" };
}

function diffArgs(target: DiffTarget, base: string, options: DiffOptions, context: number): string[] {
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-M",
    `-U${context}`,
    ...(options.ignoreWhitespace ? ["-w"] : []),
    ...(target.kind === "staged" ? ["--cached"] : []),
    base,
  ];
}

export async function computeDiff(repo: Repo, target: DiffTarget, options: DiffOptions): Promise<DiffSnapshot> {
  const branch = (await git(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })).trim() || "(no branch)";
  const base = await resolveBase(repo, target);
  const files = parseDiff(await git(repo.root, diffArgs(target, base.rev, options, options.context)));

  // Re-fetch the files the user expanded with "infinite" context.
  const expanded = new Set(options.expanded);
  await Promise.all(
    files.map(async (f, i) => {
      if (!expanded.has(f.path) || f.binary) return;
      const paths = f.oldPath ? [f.oldPath, f.path] : [f.path];
      const full = parseDiff(await git(repo.root, [...diffArgs(target, base.rev, options, FULL_CONTEXT), "--", ...paths]));
      const match = full.find((x) => x.path === f.path);
      if (match) files[i] = { ...match, hash: f.hash, expanded: true };
    }),
  );

  if (target.kind !== "staged" && target.includeUntracked) {
    const list = (await git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const path of list.slice(0, 500)) files.push(await readUntracked(repo, path));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, baseRev: base.rev, label: base.label, branch, repoName: repo.name, options, generatedAt: Date.now() };
}

async function readUntracked(repo: Repo, path: string): Promise<FileDiff> {
  const abs = join(repo.root, path);
  let size = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return untrackedDiff(path, null, { binary: true });
    size = st.size;
  } catch {
    return untrackedDiff(path, null, { binary: true });
  }
  if (size > MAX_UNTRACKED_BYTES) {
    const f = untrackedDiff(path, null, { tooLarge: true });
    f.hash += size.toString(36);
    return f;
  }
  const buf = new Uint8Array(await Bun.file(abs).arrayBuffer());
  if (buf.subarray(0, 8000).includes(0)) {
    const f = untrackedDiff(path, null, { binary: true });
    f.hash += Bun.hash(buf).toString(36);
    return f;
  }
  return untrackedDiff(path, new TextDecoder().decode(buf));
}

/** Content of a file on one side of the diff, split into lines (null if it doesn't exist). */
export async function readSide(repo: Repo, target: DiffTarget, baseRev: string, side: Side, path: string): Promise<string[] | null> {
  let text: string | null = null;
  if (side === "old") {
    const out = await git(repo.root, ["show", `${baseRev}:${path}`], { allowFail: true });
    text = out || null;
  } else if (target.kind === "staged") {
    const out = await git(repo.root, ["show", `:${path}`], { allowFail: true });
    text = out || null;
  } else {
    const f = Bun.file(join(repo.root, path));
    text = (await f.exists()) ? await f.text() : null;
  }
  if (text === null) return null;
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
