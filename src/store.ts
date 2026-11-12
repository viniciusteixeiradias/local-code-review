import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewComment, ReviewStore, Side } from "./types.ts";

export function emptyStore(): ReviewStore {
  return { version: 1, round: 0, comments: [], viewed: {}, lastTmuxTarget: null, label: "" };
}

export function newId(existing: ReviewComment[]): string {
  const ids = new Set(existing.map((c) => c.id));
  for (;;) {
    const id = "c" + Math.random().toString(36).slice(2, 6);
    if (!ids.has(id)) return id;
  }
}

export function makeComment(
  existing: ReviewComment[],
  p: { path: string; side: Side; startLine: number; endLine: number; snippet: string[]; body: string },
): ReviewComment {
  const now = new Date().toISOString();
  return {
    id: newId(existing),
    path: p.path,
    side: p.side,
    startLine: p.startLine,
    endLine: p.endLine,
    snippet: p.snippet,
    status: "draft",
    outdated: false,
    thread: [{ author: "user", body: p.body, at: now }],
    round: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Current branch name read straight from HEAD (cheap enough to call on every store access). */
export function currentBranch(gitDir: string): string {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1]! : "(detached)";
  } catch {
    return "(unknown)";
  }
}

/**
 * JSON file per branch in .git/lcr/reviews/<branch>.json, shared by the web server and the CLI
 * (which Claude calls to resolve comments). Each branch is its own review, so starting work on a
 * new branch (a new PR) starts with a clean slate. Writes are locked + atomic.
 */
export class Store {
  readonly reviewsDir: string;

  constructor(
    readonly dir: string,
    private readonly branch: () => string = () => "default",
  ) {
    this.reviewsDir = join(dir, "reviews");
    mkdirSync(this.reviewsDir, { recursive: true });
  }

  /** Review file for the branch that's checked out right now. */
  get file(): string {
    return join(this.reviewsDir, `${encodeURIComponent(this.branch())}.json`);
  }

  private readFile(file: string): ReviewStore {
    try {
      return { ...emptyStore(), ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return emptyStore();
    }
  }

  read(): ReviewStore {
    return this.readFile(this.file);
  }

  mutate<T>(fn: (s: ReviewStore) => T): T {
    const file = this.file; // pin it: a checkout mid-mutation must not split the read and the write
    const lock = `${file}.lock`;
    this.acquire(lock);
    try {
      const s = this.readFile(file);
      const result = fn(s);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, file);
      return result;
    } finally {
      try {
        unlinkSync(lock);
      } catch {}
    }
  }

  private acquire(lock: string) {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx"));
        return;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
        } catch {}
        if (Date.now() > deadline) throw new Error(`Could not lock ${lock}`);
        Bun.sleepSync(15);
      }
    }
  }
}
