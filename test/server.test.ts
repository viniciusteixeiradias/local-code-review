import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, type Repo } from "../src/git.ts";
import { serverInfoPath, startServer } from "../src/server.ts";
import type { DiffSnapshot, ReviewComment, ReviewStore, ServerEvent } from "../src/types.ts";

// A real server on a random port, against a throwaway repo with one modified and one untracked file.

const GIT_CFG = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...GIT_CFG, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
};

let root: string;
let repo: Repo;
let url: string;
let stop: () => void;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lcr-server-")));
  git(root, "init", "-q");
  writeFileSync(join(root, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  writeFileSync(join(root, "app.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\n");
  writeFileSync(join(root, "new.ts"), "export {};\n");
  repo = findRepo(root);
  ({ url, stop } = await startServer(repo, { kind: "worktree", includeUntracked: true }, { port: 0 }));
});

afterEach(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

/** Same-origin request, like the UI makes. */
async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(url + path, {
    method,
    headers: { origin: url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json().catch(() => null)) as T };
}
const state = async () => (await call<{ diff: DiffSnapshot; store: ReviewStore }>("/api/state")).data;
const comment = async (body: Partial<ReviewComment> & { body: string }) => (await call<ReviewComment>("/api/comments", "POST", body)).data;

describe("startServer", () => {
  test("serves the current diff and records itself in server.json", async () => {
    const { diff, store } = await state();
    expect(diff.files.map((f) => `${f.status} ${f.path}`)).toEqual(["modified app.ts", "untracked new.ts"]);
    expect(store.comments).toEqual([]);
    expect(existsSync(serverInfoPath(repo))).toBe(true);
  });

  test("stop() removes server.json and stops serving", async () => {
    stop();
    expect(existsSync(serverInfoPath(repo))).toBe(false);
    await expect(fetch(url + "/api/state")).rejects.toThrow();
    stop = () => {}; // already stopped
  });

  test("serves the UI and 404s unknown API paths", async () => {
    const page = await fetch(url + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect((await call("/api/nope")).status).toBe(404);
  });
});

describe("comments", () => {
  test("a line comment stores the commented lines as its snippet", async () => {
    const c = await comment({ path: "app.ts", side: "new", startLine: 2, endLine: 3, body: "  why 20?  " });
    expect(c.status).toBe("draft");
    expect(c.snippet).toEqual(["const b = 20;", "const c = 3;"]);
    expect(c.thread).toEqual([{ author: "user", body: "why 20?", at: expect.any(String) }]);

    const old = await comment({ path: "app.ts", side: "old", startLine: 2, endLine: 2, body: "was 2" });
    expect(old.snippet).toEqual(["const b = 2;"]);
    expect((await state()).store.comments).toHaveLength(2);
  });

  test("rejects an empty comment or reply", async () => {
    expect((await call("/api/comments", "POST", { path: "", body: "   " })).status).toBe(400);
    const c = await comment({ path: "", body: "general" });
    expect((await call(`/api/comments/${c.id}/reply`, "POST", { body: "" })).status).toBe(400);
  });

  test("edit, resolve, reply (re-opens as draft) and delete", async () => {
    const c = await comment({ path: "", body: "first" });

    let r = await call<ReviewComment>(`/api/comments/${c.id}`, "PATCH", { body: "edited", status: "resolved" });
    expect(r.data.thread[0]!.body).toBe("edited");
    expect(r.data.status).toBe("resolved");
    expect(r.data.resolvedBy).toBe("user");

    r = await call<ReviewComment>(`/api/comments/${c.id}/reply`, "POST", { body: "not quite" });
    expect(r.data.status).toBe("draft");
    expect(r.data.resolvedBy).toBeUndefined();
    expect(r.data.thread.map((m) => m.body)).toEqual(["edited", "not quite"]);

    expect((await call(`/api/comments/${c.id}`, "DELETE")).status).toBe(200);
    expect((await state()).store.comments).toEqual([]);
    expect((await call("/api/comments/missing", "PATCH", { status: "resolved" })).status).toBe(404);
  });

  test("clear-resolved removes only resolved comments", async () => {
    const a = await comment({ path: "", body: "keep" });
    const b = await comment({ path: "", body: "done" });
    await call(`/api/comments/${b.id}`, "PATCH", { status: "resolved" });
    await call("/api/clear-resolved", "POST");
    expect((await state()).store.comments.map((c) => c.id)).toEqual([a.id]);
  });
});

describe("viewed", () => {
  test("stores the file's current hash, and can be undone", async () => {
    const hash = (await state()).diff.files.find((f) => f.path === "app.ts")!.hash;
    await call("/api/viewed", "POST", { path: "app.ts", viewed: true });
    expect((await state()).store.viewed).toEqual({ "app.ts": hash });
    await call("/api/viewed", "POST", { path: "app.ts", viewed: false });
    expect((await state()).store.viewed).toEqual({});
  });
});

describe("content", () => {
  test("returns a file's lines only for files in the diff", async () => {
    expect((await call("/api/content?path=app.ts&side=old")).data).toEqual({ lines: ["const a = 1;", "const b = 2;", "const c = 3;"] });
    expect((await call("/api/content?path=../../etc/passwd")).status).toBe(404);
  });
});

describe("submit", () => {
  test("sends drafts as one prompt, marks them pending and starts a new round", async () => {
    const c = await comment({ path: "app.ts", side: "new", startLine: 2, endLine: 2, body: "why 20?" });

    const preview = await call<{ prompt: string; count: number }>("/api/preview", "POST", { summary: "Overall fine" });
    expect(preview.data.count).toBe(2);
    expect((await state()).store.comments).toHaveLength(1); // preview changes nothing

    const r = await call<{ prompt: string; count: number }>("/api/submit", "POST", { delivery: { kind: "queue" }, summary: "Overall fine" });
    expect(r.status).toBe(200);
    expect(r.data.count).toBe(2);
    expect(r.data.prompt).toContain(`[${c.id}] app.ts:2`);
    expect(r.data.prompt).toContain("Overall fine");

    const { store } = await state();
    expect(store.round).toBe(1);
    expect(store.comments.map((x) => [x.status, x.round])).toEqual([["pending", 1], ["pending", 1]]);
  });

  test("with no drafts there's nothing to submit", async () => {
    expect((await call("/api/submit", "POST", { delivery: { kind: "queue" } })).status).toBe(400);
  });
});

describe("only lcr's own page gets in (guard wiring)", () => {
  test("API routes, the page and the websocket reject a foreign origin", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await fetch(url + "/api/state", { headers: evil })).status).toBe(403);
    expect((await fetch(url + "/api/comments", { method: "POST", headers: evil, body: '{"body":"x"}' })).status).toBe(403);
    expect((await fetch(url + "/", { headers: evil })).status).toBe(403);
    expect((await fetch(url + "/ws", { headers: { ...evil, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } })).status).toBe(403);
    expect((await state()).store.comments).toEqual([]);
  });

  test("the websocket sends the diff and the review state on connect", async () => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers: { origin: url } } as any);
    const events: ServerEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        events.push(JSON.parse(String(e.data)));
        if (events.length === 2) resolve();
      };
      ws.onerror = () => reject(new Error("websocket error"));
    });
    ws.close();
    expect(events.map((e) => e.type)).toEqual(["diff", "store"]);
  });
});
