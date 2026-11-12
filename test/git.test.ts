import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeDiff, EMPTY_TREE, findRepo, readSide, type Repo } from "../src/git.ts";
import type { DiffOptions, DiffTarget, FileDiff } from "../src/types.ts";

// ---- helpers: a throwaway git repo per test ----

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GIT_CFG = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function run(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...GIT_CFG, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lcr-git-")));
  dirs.push(root);
  run(root, "init", "-q");
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (msg = "commit") => {
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", msg);
  };
  return { root, repo: findRepo(root), write, commit, git: (...args: string[]) => run(root, ...args) };
}

const OPTS: DiffOptions = { context: 3, ignoreWhitespace: false, expanded: [] };
const WORKTREE: DiffTarget = { kind: "worktree", includeUntracked: true };
const STAGED: DiffTarget = { kind: "staged", includeUntracked: false };
const base = (ref: string): DiffTarget => ({ kind: "base", ref, includeUntracked: true });

const diff = (repo: Repo, target: DiffTarget, opts: Partial<DiffOptions> = {}) => computeDiff(repo, target, { ...OPTS, ...opts });
const byPath = (files: FileDiff[]) => Object.fromEntries(files.map((f) => [f.path, f]));
const summary = (files: FileDiff[]) => files.map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`);
const added = (f: FileDiff | undefined) => f?.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.text));

// ---- tests ----

describe("findRepo", () => {
  test("finds the repo root from a subdirectory", () => {
    const r = makeRepo();
    r.write("a/b/c.txt", "x\n");
    const repo = findRepo(join(r.root, "a", "b"));
    expect(repo.root).toBe(r.root);
    expect(repo.gitDir).toBe(join(r.root, ".git"));
  });

  test("throws outside a git repository", () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "lcr-nogit-")));
    dirs.push(d);
    expect(() => findRepo(d)).toThrow("Not inside a git repository");
  });
});

describe("worktree target (lcr)", () => {
  test("shows staged, unstaged and untracked changes against HEAD", async () => {
    const r = makeRepo();
    r.write("staged.txt", "one\n");
    r.write("unstaged.txt", "one\n");
    r.commit();
    r.write("staged.txt", "one\ntwo\n");
    r.git("add", "staged.txt");
    r.write("unstaged.txt", "one\nthree\n");
    r.write("new.txt", "hello\n");

    const d = await diff(r.repo, WORKTREE);
    expect(summary(d.files)).toEqual(["untracked new.txt", "modified staged.txt", "modified unstaged.txt"]);
    expect(d.label).toBe("HEAD → working tree");
    expect(d.baseRev).toBe(r.git("rev-parse", "HEAD").trim());
    expect(added(byPath(d.files)["new.txt"])).toEqual(["hello"]);
  });

  test("--no-untracked leaves untracked files out", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit();
    r.write("new.txt", "hello\n");
    expect((await diff(r.repo, { kind: "worktree", includeUntracked: false })).files).toEqual([]);
  });

  test("respects .gitignore for untracked files", async () => {
    const r = makeRepo();
    r.write(".gitignore", "build/\n");
    r.commit();
    r.write("build/out.js", "x\n");
    r.write("src.ts", "y\n");
    expect(summary((await diff(r.repo, WORKTREE)).files)).toEqual(["untracked src.ts"]);
  });

  test("no changes means no files", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit();
    expect((await diff(r.repo, WORKTREE)).files).toEqual([]);
  });

  test("works in a repo with no commits yet", async () => {
    const r = makeRepo();
    r.write("staged.txt", "s\n");
    r.git("add", "staged.txt");
    r.write("untracked.txt", "u\n");

    const d = await diff(r.repo, WORKTREE);
    expect(d.baseRev).toBe(EMPTY_TREE);
    expect(summary(d.files)).toEqual(["added staged.txt", "untracked untracked.txt"]);
  });

  test("reports renamed, deleted and added files", async () => {
    const r = makeRepo();
    r.write("old-name.txt", "line 1\nline 2\nline 3\nline 4\n");
    r.write("gone.txt", "bye\n");
    r.commit();
    r.git("mv", "old-name.txt", "new-name.txt");
    r.git("rm", "-q", "gone.txt");
    r.write("fresh.txt", "hi\n");
    r.git("add", "fresh.txt");

    const d = await diff(r.repo, WORKTREE);
    expect(summary(d.files)).toEqual(["added fresh.txt", "deleted gone.txt", "renamed old-name.txt -> new-name.txt"]);
  });

  test("handles paths with spaces and non-ASCII characters", async () => {
    const r = makeRepo();
    r.write("dir with space/café.txt", "a\n");
    r.commit();
    r.write("dir with space/café.txt", "b\n");
    r.write("naïve new.txt", "c\n");
    expect(summary((await diff(r.repo, WORKTREE)).files)).toEqual(["modified dir with space/café.txt", "untracked naïve new.txt"]);
  });

  test("marks binary files", async () => {
    const r = makeRepo();
    r.write("img.bin", new Uint8Array([0, 1, 2, 3]));
    r.commit();
    r.write("img.bin", new Uint8Array([0, 9, 9, 9]));
    r.write("new.bin", new Uint8Array([0, 0, 0]));

    const f = byPath((await diff(r.repo, WORKTREE)).files);
    expect(f["img.bin"]?.binary).toBe(true);
    expect(f["new.bin"]?.binary).toBe(true);
    expect(f["new.bin"]?.hunks).toEqual([]);
  });

  test("ignoreWhitespace drops files whose only changes are whitespace", async () => {
    const r = makeRepo();
    r.write("a.ts", "if (x) {\n  y();\n}\n");
    r.write("b.ts", "z();\n");
    r.commit();
    r.write("a.ts", "if (x) {\n    y();\n}\n");
    r.write("b.ts", "w();\n");

    expect(summary((await diff(r.repo, WORKTREE)).files)).toEqual(["modified a.ts", "modified b.ts"]);
    expect(summary((await diff(r.repo, WORKTREE, { ignoreWhitespace: true })).files)).toEqual(["modified b.ts"]);
  });

  test("expanded files get the whole file as context, with the same hash", async () => {
    const r = makeRepo();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    r.write("long.txt", lines.join("\n") + "\n");
    r.commit();
    lines[14] = "changed";
    r.write("long.txt", lines.join("\n") + "\n");

    const normal = (await diff(r.repo, WORKTREE)).files[0]!;
    const full = (await diff(r.repo, WORKTREE, { expanded: ["long.txt"] })).files[0]!;
    expect(normal.hunks[0]!.lines).toHaveLength(8); // 3 context + del + add + 3 context
    expect(full.expanded).toBe(true);
    expect(full.hunks[0]!.lines).toHaveLength(31);
    expect(full.hash).toBe(normal.hash);
  });
});

describe("staged target (lcr --staged)", () => {
  test("shows only staged changes and never untracked files", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit();
    r.write("a.txt", "a2\n");
    r.git("add", "a.txt");
    r.write("b.txt", "b2\n");
    r.write("new.txt", "n\n");

    const d = await diff(r.repo, STAGED);
    expect(summary(d.files)).toEqual(["modified a.txt"]);
    expect(d.label).toBe("HEAD → staged");
  });
});

describe("base target (lcr <ref>)", () => {
  test("diffs from the merge-base, so new commits on the base branch don't show", async () => {
    const r = makeRepo();
    r.write("shared.txt", "v1\n");
    r.commit("base");
    const mergeBase = r.git("rev-parse", "HEAD").trim();

    r.git("switch", "-q", "-c", "feature");
    r.write("feature.txt", "committed on feature\n");
    r.commit("feature work");

    r.git("switch", "-q", "main");
    r.write("main-only.txt", "later on main\n");
    r.commit("main moves on");
    r.git("switch", "-q", "feature");
    r.write("wip.txt", "uncommitted\n");

    const d = await diff(r.repo, base("main"));
    expect(summary(d.files)).toEqual(["added feature.txt", "untracked wip.txt"]);
    expect(d.baseRev).toBe(mergeBase);
    expect(d.label).toBe(`main (${mergeBase.slice(0, 7)}) → working tree`);
    expect(d.branch).toBe("feature");
  });

  test("an unknown ref is an error", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit();
    await expect(diff(r.repo, base("does-not-exist"))).rejects.toThrow();
  });
});

describe("readSide", () => {
  test("reads the old version from the base and the new one from the right place", async () => {
    const r = makeRepo();
    r.write("a.txt", "old 1\nold 2\n");
    r.commit();
    r.write("a.txt", "staged\n");
    r.git("add", "a.txt");
    r.write("a.txt", "working tree\n");
    const head = r.git("rev-parse", "HEAD").trim();

    expect(await readSide(r.repo, WORKTREE, head, "old", "a.txt")).toEqual(["old 1", "old 2"]);
    expect(await readSide(r.repo, WORKTREE, head, "new", "a.txt")).toEqual(["working tree"]);
    expect(await readSide(r.repo, STAGED, head, "new", "a.txt")).toEqual(["staged"]);
  });

  test("returns null for a file that doesn't exist on that side", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit();
    const head = r.git("rev-parse", "HEAD").trim();
    r.write("new.txt", "n\n");
    unlinkSync(join(r.root, "a.txt"));

    expect(await readSide(r.repo, WORKTREE, head, "old", "new.txt")).toBeNull();
    expect(await readSide(r.repo, WORKTREE, head, "new", "a.txt")).toBeNull();
  });

  test("keeps a last line without a trailing newline", async () => {
    const r = makeRepo();
    r.write("a.txt", "one\ntwo");
    expect(await readSide(r.repo, WORKTREE, EMPTY_TREE, "new", "a.txt")).toEqual(["one", "two"]);
  });
});
