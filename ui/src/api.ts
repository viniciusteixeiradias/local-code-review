import { onUnmounted, ref, shallowRef, watch, type Ref } from "vue";
import type { DiffSnapshot, ReviewStore, ServerEvent } from "../../src/types.ts";

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

/** Live diff + review state pushed by the server over a websocket (auto-reconnects). */
export function useServer() {
  const diff = shallowRef<DiffSnapshot | null>(null);
  const store = shallowRef<ReviewStore | null>(null);
  const connected = ref(false);

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      connected.value = true;
    };
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data) as ServerEvent;
      if (ev.type === "diff") diff.value = ev.data;
      if (ev.type === "store") store.value = ev.data;
    };
    ws.onclose = () => {
      connected.value = false;
      if (!closed) timer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
    };
  };
  connect();

  onUnmounted(() => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  });

  return { diff, store, connected };
}

/** A ref mirrored to localStorage (per-browser UI preferences). */
export function usePersisted<T>(key: string, initial: T): Ref<T> {
  let start = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) start = JSON.parse(raw) as T;
  } catch {}
  const r = ref(start) as Ref<T>;
  watch(r, (v) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {}
  });
  return r;
}
