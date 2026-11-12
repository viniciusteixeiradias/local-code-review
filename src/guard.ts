/**
 * Only lcr's own page may talk to the server.
 *
 * The server listens on 127.0.0.1, but that alone doesn't keep other websites out: any page open
 * in the browser can send "simple" cross-origin POSTs (no CORS preflight), open a websocket to it
 * (websockets aren't covered by the same-origin policy), or reach it through DNS rebinding. Through
 * the API that means reading uncommitted code and typing into tmux panes, so every request is
 * checked here before it reaches a handler.
 *
 * - Host must be the address lcr is serving on. A DNS-rebinding page sends its own hostname.
 * - Origin, when present, must be lcr's own page. Browsers always send it on cross-origin requests
 *   and on websocket handshakes. Non-browser clients (curl, scripts) usually don't send one.
 *
 * `extraOrigins` allows the Vite dev server (see LCR_DEV_ORIGIN in CONTRIBUTING.md).
 */
export function rejectForeign(req: Request, port: number, extraOrigins: string[] = []): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.get("host");
  if (!host || !hosts.includes(host.toLowerCase())) return `Host not allowed: ${host ?? "(none)"}`;

  const origin = req.headers.get("origin");
  if (origin !== null) {
    const origins = [...hosts.map((h) => `http://${h}`), ...extraOrigins];
    if (!origins.includes(origin.toLowerCase())) return `Origin not allowed: ${origin}`;
  }
  return null;
}

/** Origins from LCR_DEV_ORIGIN (comma-separated), e.g. "http://localhost:5173". */
export function devOrigins(env: string | undefined = process.env.LCR_DEV_ORIGIN): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}
