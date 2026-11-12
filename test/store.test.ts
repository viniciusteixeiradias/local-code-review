import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, makeComment, parseStore } from "../src/store.ts";

let dir: string;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcr-store-"));
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const backups = (store: Store) => readdirSync(store.reviewsDir).filter((f) => f.includes(".corrupt-"));
const addComment = (store: Store, body: string) =>
  store.mutate((s) => void s.comments.push(makeComment(s.comments, { path: "", side: "new", startLine: 0, endLine: 0, snippet: [], body })));

describe("parseStore", () => {
  test("accepts a review file and fills in missing fields", () => {
    const s = parseStore(JSON.stringify({ comments: [], viewed: {} }));
    expect(s?.round).toBe(0);
    expect(s?.lastTmuxTarget).toBeNull();
  });

  test("rejects invalid JSON and the wrong shape", () => {
    expect(parseStore("{ not json")).toBeNull();
    expect(parseStore("")).toBeNull();
    expect(parseStore("[]")).toBeNull();
    expect(parseStore("null")).toBeNull();
    expect(parseStore(JSON.stringify({ comments: "nope" }))).toBeNull();
    expect(parseStore(JSON.stringify({ comments: [], viewed: null }))).toBeNull();
  });
});

describe("Store with a missing or corrupt file", () => {
  test("a missing file is an empty review, with no backup", () => {
    const store = new Store(dir);
    expect(store.read().comments).toEqual([]);
    expect(backups(store)).toEqual([]);
  });

  test("a corrupt file is moved aside, not overwritten", () => {
    const store = new Store(dir);
    addComment(store, "first");
    const broken = readFileSync(store.file, "utf8").slice(0, -10); // e.g. a truncated write
    writeFileSync(store.file, broken);

    expect(store.read().comments).toEqual([]);
    const [backup] = backups(store);
    expect(backup).toBeDefined();
    expect(readFileSync(join(store.reviewsDir, backup!), "utf8")).toBe(broken);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("writing after a corrupt read keeps the backup and starts fresh", () => {
    const store = new Store(dir);
    writeFileSync(store.file, "{ not json");
    addComment(store, "after");

    expect(store.read().comments.map((c) => c.thread[0]!.body)).toEqual(["after"]);
    const [backup] = backups(store);
    expect(readFileSync(join(store.reviewsDir, backup!), "utf8")).toBe("{ not json");
  });
});
