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

/**
 * JSON file in .git/lcr/review.json, shared by the web server and the CLI
 * (which Claude calls to resolve comments). Writes are locked + atomic.
 */
export class Store {
  readonly file: string;
  private readonly lock: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "review.json");
    this.lock = join(dir, "review.lock");
  }

  read(): ReviewStore {
    try {
      return { ...emptyStore(), ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      return emptyStore();
    }
  }

  mutate<T>(fn: (s: ReviewStore) => T): T {
    this.acquire();
    try {
      const s = this.read();
      const result = fn(s);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, this.file);
      return result;
    } finally {
      try {
        unlinkSync(this.lock);
      } catch {}
    }
  }

  private acquire() {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        closeSync(openSync(this.lock, "wx"));
        return;
      } catch {
        try {
          if (Date.now() - statSync(this.lock).mtimeMs > 5000) unlinkSync(this.lock);
        } catch {}
        if (Date.now() > deadline) throw new Error(`Could not lock ${this.lock}`);
        Bun.sleepSync(15);
      }
    }
  }
}
