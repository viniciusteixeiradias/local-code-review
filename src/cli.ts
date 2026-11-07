import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepo, type Repo } from "./git.ts";
import { buildPrompt, location } from "./prompt.ts";
import { Store } from "./store.ts";
import type { DiffTarget, ReviewComment } from "./types.ts";

const HELP = `lcr - local code review for AI-assisted development

Usage:
  lcr [base-ref] [options]      Start the review UI (default: HEAD vs working tree)
  lcr feedback [--all]          Print sent-but-unresolved comments as a prompt
  lcr resolve <id...> [-m msg]  Mark comment(s) resolved, optionally with a note
  lcr reply <id> -m msg         Reply to a comment without resolving it
  lcr list                      List comments and their status
  lcr clear [--all]             Delete resolved comments (--all: every comment)

Options (UI):
  base-ref         Compare the working tree with merge-base(base-ref, HEAD), e.g. "main"
  --staged         Review only staged changes
  --no-untracked   Don't include untracked files
  --port <n>       Port to listen on (default 4747)
  --no-open        Don't open the browser
`;

function storeFor(repo: Repo) {
  return new Store(join(repo.gitDir, "lcr"));
}

function takeFlag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

function takeOption(args: string[], ...names: string[]): string | undefined {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) {
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    }
  }
  return undefined;
}

function findComments(all: ReviewComment[], ids: string[]): ReviewComment[] {
  return ids.map((id) => {
    const c = all.find((x) => x.id === id) ?? (all.filter((x) => x.id.startsWith(id)).length === 1 ? all.find((x) => x.id.startsWith(id)) : undefined);
    if (!c) throw new Error(`No comment with id "${id}". Run \`lcr list\` to see ids.`);
    return c;
  });
}

async function main(argv: string[]) {
  const args = [...argv];
  const cmd = args[0];

  if (cmd === "-h" || cmd === "--help" || cmd === "help") return console.log(HELP);

  const repo = findRepo();

  if (cmd === "feedback") {
    const all = takeFlag(args, "--all");
    const s = storeFor(repo).read();
    const pending = s.comments.filter((c) => c.status === "pending" || (all && c.status === "draft"));
    if (!pending.length) return console.log("No pending review feedback.");
    return process.stdout.write(buildPrompt(pending, { round: s.round, label: s.label }));
  }

  if (cmd === "resolve" || cmd === "reply") {
    args.shift();
    const msg = takeOption(args, "-m", "--message");
    if (cmd === "reply" && !msg) throw new Error('Usage: lcr reply <id> -m "message"');
    if (!args.length) throw new Error(`Usage: lcr ${cmd} <id...>${cmd === "resolve" ? ' [-m "note"]' : ' -m "message"'}`);
    const done = storeFor(repo).mutate((s) => {
      const targets = findComments(s.comments, args);
      const now = new Date().toISOString();
      for (const c of targets) {
        if (msg) c.thread.push({ author: "agent", body: msg, at: now });
        if (cmd === "resolve") {
          c.status = "resolved";
          c.resolvedBy = "agent";
        }
        c.updatedAt = now;
      }
      return targets;
    });
    for (const c of done) console.log(`${cmd === "resolve" ? "Resolved" : "Replied to"} [${c.id}] ${location(c)}`);
    return;
  }

  if (cmd === "list") {
    const s = storeFor(repo).read();
    if (!s.comments.length) return console.log("No comments.");
    for (const c of s.comments) {
      const first = c.thread[0]?.body.split("\n")[0] ?? "";
      console.log(`[${c.id}] ${c.status.padEnd(8)}${c.outdated ? " (outdated)" : ""}  ${location(c)}  ${first.slice(0, 80)}`);
    }
    return;
  }

  if (cmd === "clear") {
    const all = takeFlag(args, "--all");
    const n = storeFor(repo).mutate((s) => {
      const before = s.comments.length;
      s.comments = all ? [] : s.comments.filter((c) => c.status !== "resolved");
      if (all) s.round = 0;
      return before - s.comments.length;
    });
    return console.log(`Deleted ${n} comment(s).`);
  }

  // ---- serve ----
  const staged = takeFlag(args, "--staged", "--cached");
  const noUntracked = takeFlag(args, "--no-untracked");
  const noOpen = takeFlag(args, "--no-open");
  const port = Number(takeOption(args, "--port", "-p") ?? 4747);
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}\n\n${HELP}`);
  const ref = args[0];
  const target: DiffTarget = staged
    ? { kind: "staged", includeUntracked: false }
    : ref
      ? { kind: "base", ref, includeUntracked: !noUntracked }
      : { kind: "worktree", includeUntracked: !noUntracked };

  const { codeVersion, runningServer, startServer, UI_DIST } = await import("./server.ts");
  if (!existsSync(join(UI_DIST, "index.html"))) {
    console.log("Building the UI (first run)…");
    const root = join(import.meta.dir, "..");
    const b = Bun.spawnSync(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) throw new Error(`UI build failed. Try: cd ${root} && bun install && bun run build`);
  }
  const existing = runningServer(repo);
  if (existing) {
    if (existing.version === codeVersion() && !ref && !staged) {
      console.log(`lcr is already running for this repo at ${existing.url}`);
      if (!noOpen) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", existing.url]);
      return;
    }
    // Different options or an older lcr build: replace it.
    console.log(`Restarting the lcr server for this repo (pid ${existing.pid})…`);
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 40 && runningServer(repo); i++) await Bun.sleep(50);
  }
  const { url } = await startServer(repo, target, { port });
  console.log(`lcr reviewing ${repo.name} at ${url}  (Ctrl+C to stop)`);
  if (!noOpen) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`lcr: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
