import { readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, normalize, relative } from "node:path";
import { reanchor } from "./anchor.ts";
import { computeDiff, readSide, type Repo } from "./git.ts";
import { devOrigins, rejectForeign } from "./guard.ts";
import { buildPrompt } from "./prompt.ts";
import { Store, currentBranch, makeComment } from "./store.ts";
import { listPanes, sendToPane } from "./tmux.ts";
import type { Delivery, DiffOptions, DiffSnapshot, DiffTarget, ReviewComment, ServerEvent, Side } from "./types.ts";

const TOPIC = "events";
export const UI_DIST = join(import.meta.dir, "..", "ui", "dist");

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(UI_DIST, rel === "/" ? "index.html" : rel));
  if (rel !== "/" && (await file.exists())) {
    // Vite fingerprints assets, so they can be cached forever.
    const immutable = rel.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : undefined;
    return new Response(file, { headers: immutable });
  }
  return new Response(Bun.file(join(UI_DIST, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}
function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

export function serverInfoPath(repo: Repo) {
  return join(repo.gitDir, "lcr", "server.json");
}

/** Fingerprint of lcr's own code + built UI, so a server started from older code can be detected. */
export function codeVersion(): string {
  const root = join(import.meta.dir, "..");
  const parts: string[] = [];
  for (const dir of [join(root, "src"), join(root, "ui", "dist")]) {
    try {
      for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        try {
          parts.push(`${f}:${statSync(join(dir, f)).mtimeMs}`);
        } catch {}
      }
    } catch {}
  }
  return Bun.hash(parts.sort().join("|")).toString(36);
}

/** A server already running for this repo, if any. */
export function runningServer(repo: Repo): { url: string; pid: number; version: string } | null {
  try {
    const info = JSON.parse(readFileSync(serverInfoPath(repo), "utf8"));
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

export async function startServer(repo: Repo, target: DiffTarget, opts: { port: number }) {
  const store = new Store(join(repo.gitDir, "lcr"), () => currentBranch(repo.gitDir));
  let storeFile = store.file;
  let options: DiffOptions = { context: 3, ignoreWhitespace: false, expanded: [] };
  let snapshot: DiffSnapshot = {
    files: [], baseRev: "", label: "", branch: "", repoName: repo.name, options, generatedAt: 0,
  };

  const publish = (ev: ServerEvent) => server.publish(TOPIC, JSON.stringify(ev));

  // ---- diff refresh (coalesced: at most one running, one queued) ----
  let running: Promise<void> | null = null;
  let queued = false;
  async function refresh(): Promise<void> {
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      do {
        queued = false;
        try {
          snapshot = await computeDiff(repo, target, options);
        } catch (e) {
          snapshot = { ...snapshot, error: String((e as Error).message ?? e), generatedAt: Date.now() };
        }
        // Branch switched (HEAD is watched): the UI must swap to that branch's comments.
        if (store.file !== storeFile) {
          storeFile = store.file;
          publish({ type: "store", data: store.read() });
        }
        await reanchorAll();
        publish({ type: "diff", data: snapshot });
      } while (queued);
    })().finally(() => (running = null));
    return running;
  }

  function oldPathFor(path: string) {
    return snapshot.files.find((f) => f.path === path)?.oldPath ?? path;
  }

  async function linesFor(side: Side, path: string) {
    return readSide(repo, target, snapshot.baseRev, side, side === "old" ? oldPathFor(path) : path);
  }

  async function reanchorAll() {
    const comments = store.read().comments.filter((c) => c.path && c.startLine > 0);
    if (!comments.length) return;
    const cache = new Map<string, string[] | null>();
    for (const c of comments) {
      const key = `${c.side}:${c.path}`;
      if (!cache.has(key)) cache.set(key, await linesFor(c.side, c.path));
    }
    const updates = new Map<string, ReturnType<typeof reanchor>>();
    for (const c of comments) {
      const r = reanchor(c, cache.get(`${c.side}:${c.path}`)!);
      if (r.startLine !== c.startLine || r.endLine !== c.endLine || r.outdated !== c.outdated) updates.set(c.id, r);
    }
    if (!updates.size) return;
    store.mutate((s) => {
      for (const c of s.comments) {
        const u = updates.get(c.id);
        if (u) Object.assign(c, u);
      }
    });
  }

  // ---- file watching ----
  const gitRel = relative(repo.root, repo.gitDir);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 200);
  };
  const relevantGitFile = (f: string) => f === "HEAD" || f === "index" || f.startsWith("refs/") || f === "packed-refs";

  const watchers: FSWatcher[] = [];
  watchers.push(
    watch(repo.root, { recursive: true }, (_ev, filename) => {
      if (!filename) return schedule();
      const f = filename.toString();
      if (!gitRel.startsWith("..") && (f === gitRel || f.startsWith(gitRel + "/"))) {
        if (relevantGitFile(f.slice(gitRel.length + 1))) schedule();
        return;
      }
      if (f.startsWith("node_modules/") || f.includes("/node_modules/")) return;
      schedule();
    }),
  );
  if (gitRel.startsWith("..")) {
    // Worktree / separate git dir: watch HEAD + index there.
    watchers.push(watch(repo.gitDir, (_ev, f) => f && relevantGitFile(f.toString()) && schedule()));
  }
  let storeTimer: ReturnType<typeof setTimeout> | null = null;
  watchers.push(
    watch(store.reviewsDir, (_ev, f) => {
      if (!f || join(store.reviewsDir, f.toString()) !== store.file) return;
      if (storeTimer) clearTimeout(storeTimer);
      storeTimer = setTimeout(() => publish({ type: "store", data: store.read() }), 30);
    }),
  );

  // ---- HTTP ----
  const body = async (req: Request) => (await req.json().catch(() => ({}))) as any;

  const routes = {
    "/api/state": {
      GET: () => json({ diff: snapshot, store: store.read() }),
    },
    "/api/options": {
      POST: async (req: Request) => {
        const b = await body(req);
        options = {
          context: typeof b.context === "number" ? Math.max(0, Math.min(1000, b.context)) : options.context,
          ignoreWhitespace: typeof b.ignoreWhitespace === "boolean" ? b.ignoreWhitespace : options.ignoreWhitespace,
          expanded: Array.isArray(b.expanded) ? b.expanded : options.expanded,
        };
        await refresh();
        return json({ ok: true });
      },
    },
    /** Full file text for one side of the diff (used for syntax highlighting). */
    "/api/content": {
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const path = u.searchParams.get("path") ?? "";
        const side: Side = u.searchParams.get("side") === "old" ? "old" : "new";
        if (!snapshot.files.some((f) => f.path === path)) return fail("Not in diff", 404);
        return json({ lines: await linesFor(side, path) });
      },
    },
    "/api/refresh": { POST: async () => (await refresh(), json({ ok: true })) },
    "/api/viewed": {
      POST: async (req: Request) => {
        const b = await body(req);
        const paths: string[] = Array.isArray(b.paths) ? b.paths : [b.path];
        store.mutate((s) => {
          for (const p of paths) {
            const f = snapshot.files.find((x) => x.path === p);
            if (b.viewed && f) s.viewed[p] = f.hash;
            else delete s.viewed[p];
          }
        });
        return json({ ok: true });
      },
    },
    "/api/comments": {
      POST: async (req: Request) => {
        const b = await body(req);
        const text = String(b.body ?? "").trim();
        if (!text) return fail("Comment is empty");
        const path = String(b.path ?? "");
        const side: Side = b.side === "old" ? "old" : "new";
        let start = Math.max(0, Number(b.startLine) || 0);
        let end = Math.max(start, Number(b.endLine) || start);
        let snippet: string[] = [];
        if (path && start > 0) {
          const lines = await linesFor(side, path);
          snippet = lines?.slice(start - 1, end) ?? [];
        }
        const c = store.mutate((s) => {
          const c = makeComment(s.comments, { path, side, startLine: start, endLine: end, snippet, body: text });
          s.comments.push(c);
          return c;
        });
        return json(c);
      },
    },
    "/api/comments/:id": {
      PATCH: async (req: Request & { params: { id: string } }) => {
        const b = await body(req);
        const r = store.mutate((s) => {
          const c = s.comments.find((x) => x.id === req.params.id);
          if (!c) return null;
          if (typeof b.body === "string" && b.body.trim()) {
            const last = [...c.thread].reverse().find((m) => m.author === "user");
            if (last) last.body = b.body.trim();
          }
          if (b.status === "draft" || b.status === "pending" || b.status === "resolved") {
            c.status = b.status;
            c.resolvedBy = b.status === "resolved" ? "user" : undefined;
          }
          c.updatedAt = new Date().toISOString();
          return c;
        });
        return r ? json(r) : fail("Not found", 404);
      },
      DELETE: (req: Request & { params: { id: string } }) => {
        store.mutate((s) => void (s.comments = s.comments.filter((c) => c.id !== req.params.id)));
        return json({ ok: true });
      },
    },
    "/api/comments/:id/reply": {
      POST: async (req: Request & { params: { id: string } }) => {
        const b = await body(req);
        const text = String(b.body ?? "").trim();
        if (!text) return fail("Reply is empty");
        const r = store.mutate((s) => {
          const c = s.comments.find((x) => x.id === req.params.id);
          if (!c) return null;
          const now = new Date().toISOString();
          c.thread.push({ author: "user", body: text, at: now });
          c.resolvedBy = undefined;
          c.status = "draft"; // re-opened: goes out with the next submit
          c.updatedAt = now;
          return c;
        });
        return r ? json(r) : fail("Not found", 404);
      },
    },
    "/api/clear-resolved": {
      POST: () => {
        store.mutate((s) => void (s.comments = s.comments.filter((c) => c.status !== "resolved")));
        return json({ ok: true });
      },
    },
    "/api/tmux/panes": {
      GET: async () => json({ panes: await listPanes(repo.root), last: store.read().lastTmuxTarget }),
    },
    "/api/preview": {
      POST: async (req: Request) => {
        const b = await body(req);
        const s = store.read();
        const drafts: ReviewComment[] = s.comments.filter((c) => c.status === "draft");
        const summary = String(b.summary ?? "").trim();
        if (summary) drafts.unshift(makeComment(s.comments, { path: "", side: "new", startLine: 0, endLine: 0, snippet: [], body: summary }));
        return json({ prompt: drafts.length ? buildPrompt(drafts, { round: s.round + 1, label: snapshot.label }) : "", count: drafts.length });
      },
    },
    "/api/submit": {
      POST: async (req: Request) => {
        const b = await body(req);
        const delivery: Delivery = b.delivery ?? { kind: "clipboard" };
        const summary = String(b.summary ?? "").trim();
        let ids: string[] = [];
        const result = store.mutate((s) => {
          if (summary) s.comments.unshift(makeComment(s.comments, { path: "", side: "new", startLine: 0, endLine: 0, snippet: [], body: summary }));
          const drafts = s.comments.filter((c) => c.status === "draft");
          if (!drafts.length) return null;
          s.round += 1;
          s.label = snapshot.label;
          const now = new Date().toISOString();
          for (const c of drafts) Object.assign(c, { status: "pending", round: s.round, updatedAt: now });
          if (delivery.kind === "tmux") s.lastTmuxTarget = delivery.target;
          ids = drafts.map((c) => c.id);
          return { prompt: buildPrompt(drafts, { round: s.round, label: snapshot.label }), count: drafts.length };
        });
        if (!result) return fail("Nothing to submit: add some comments first");

        try {
          if (delivery.kind === "tmux") await sendToPane(delivery.target, result.prompt);
          if (delivery.kind === "clipboard" && process.platform === "darwin") {
            const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
            p.stdin.write(result.prompt);
            await p.stdin.end();
            await p.exited;
          }
        } catch (e) {
          // Delivery failed: put the comments back to draft so nothing is lost.
          store.mutate((s) => {
            s.round -= 1;
            for (const c of s.comments) if (ids.includes(c.id)) Object.assign(c, { status: "draft", round: null });
          });
          return fail(String((e as Error).message ?? e), 500);
        }
        return json(result);
      },
    },
  } as const;

  // Every request goes through the same-origin check first (see guard.ts). Bun runs `routes`
  // before `fetch`, so the routes are wrapped here and `fetch` checks on its own.
  const allowedDevOrigins = devOrigins();
  const guard = (req: Request): Response | null => {
    const why = rejectForeign(req, server.port!, allowedDevOrigins);
    return why ? fail(why, 403) : null;
  };
  const guardedRoutes = Object.fromEntries(
    Object.entries(routes).map(([path, methods]) => [
      path,
      Object.fromEntries(
        Object.entries(methods).map(([method, handler]) => [method, (req: any) => guard(req) ?? (handler as (r: any) => unknown)(req)]),
      ),
    ]),
  );

  let server: ReturnType<typeof Bun.serve>;
  let port = opts.port;
  for (let attempt = 0; ; attempt++) {
    try {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        routes: guardedRoutes as any,
        fetch(req, srv) {
          const denied = guard(req);
          if (denied) return denied;
          const { pathname } = new URL(req.url);
          if (pathname === "/ws") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("Expected websocket", { status: 400 });
          if (pathname.startsWith("/api/")) return fail("Not found", 404);
          return serveStatic(pathname);
        },
        websocket: {
          open(ws) {
            ws.subscribe(TOPIC);
            ws.send(JSON.stringify({ type: "diff", data: snapshot } satisfies ServerEvent));
            ws.send(JSON.stringify({ type: "store", data: store.read() } satisfies ServerEvent));
          },
          message() {},
        },
      });
      break;
    } catch (e) {
      if (attempt > 20) throw e;
      port++;
    }
  }

  const url = `http://127.0.0.1:${server.port}`;
  writeFileSync(serverInfoPath(repo), JSON.stringify({ pid: process.pid, url, version: codeVersion() }));
  /** Stop serving and watching, and remove server.json if it's ours. Ctrl+C goes through here too. */
  const stop = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      const info = JSON.parse(readFileSync(serverInfoPath(repo), "utf8"));
      if (info.pid === process.pid) unlinkSync(serverInfoPath(repo));
    } catch {}
    watchers.forEach((w) => w.close());
    if (timer) clearTimeout(timer);
    if (storeTimer) clearTimeout(storeTimer);
    server.stop(true);
  };
  const onSignal = () => {
    stop();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await refresh();
  return { url, stop };
}
