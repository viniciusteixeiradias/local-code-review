import { describe, expect, test } from "bun:test";
import { devOrigins, rejectForeign } from "../src/guard.ts";

const PORT = 4747;
const req = (headers: Record<string, string>) => new Request(`http://127.0.0.1:${PORT}/api/state`, { headers });

describe("rejectForeign", () => {
  test("allows lcr's own page", () => {
    expect(rejectForeign(req({ host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747" }), PORT)).toBeNull();
    expect(rejectForeign(req({ host: "localhost:4747", origin: "http://localhost:4747" }), PORT)).toBeNull();
  });

  test("allows clients that send no Origin (same-origin GETs, curl, scripts)", () => {
    expect(rejectForeign(req({ host: "127.0.0.1:4747" }), PORT)).toBeNull();
  });

  test("rejects other websites (CSRF, cross-origin websockets)", () => {
    expect(rejectForeign(req({ host: "127.0.0.1:4747", origin: "https://evil.example" }), PORT)).toContain("Origin");
    expect(rejectForeign(req({ host: "127.0.0.1:4747", origin: "null" }), PORT)).toContain("Origin");
  });

  test("rejects lcr's address on a different port", () => {
    expect(rejectForeign(req({ host: "127.0.0.1:4747", origin: "http://127.0.0.1:5000" }), PORT)).toContain("Origin");
  });

  test("rejects a foreign Host (DNS rebinding)", () => {
    expect(rejectForeign(req({ host: "evil.example:4747" }), PORT)).toContain("Host");
    expect(rejectForeign(req({ host: "127.0.0.1:9999" }), PORT)).toContain("Host");
  });

  test("allows configured dev origins only", () => {
    const dev = devOrigins("http://localhost:5173/, http://127.0.0.1:5173");
    expect(dev).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
    expect(rejectForeign(req({ host: "127.0.0.1:4747", origin: "http://localhost:5173" }), PORT, dev)).toBeNull();
    expect(rejectForeign(req({ host: "127.0.0.1:4747", origin: "http://localhost:5173" }), PORT)).toContain("Origin");
    expect(devOrigins(undefined)).toEqual([]);
  });
});
