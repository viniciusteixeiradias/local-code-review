import { describe, expect, test } from "bun:test";
import { reanchor } from "../src/anchor.ts";
import { parseDiff, unquotePath, untrackedDiff } from "../src/diff.ts";
import { buildPrompt } from "../src/prompt.ts";
import { emptyStore, makeComment } from "../src/store.ts";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+-- not a header
 const c = 4;
 const d = 5;
diff --git a/old name.txt b/new name.txt
similarity 90%
rename from old name.txt
rename to new name.txt
index 333..444 100644
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-hello
+hello!
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 555..000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/img.png b/img.png
new file mode 100644
index 000..666
Binary files /dev/null and b/img.png differ
`;

describe("parseDiff", () => {
  const files = parseDiff(SAMPLE);

  test("finds every file with the right status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/a.ts", "modified"],
      ["new name.txt", "renamed"],
      ["gone.txt", "deleted"],
      ["img.png", "added"],
    ]);
    expect(files[1]!.oldPath).toBe("old name.txt");
    expect(files[3]!.binary).toBe(true);
  });

  test("tracks line numbers and treats '--' lines inside a hunk as content", () => {
    const h = files[0]!.hunks[0]!;
    expect(h.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
      ["ctx", 4, 5],
    ]);
    expect(h.lines[3]!.text).toBe("-- not a header");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);
  });

  test("marks missing trailing newline", () => {
    expect(files[1]!.hunks[0]!.lines.at(-1)!.noNewline).toBe(true);
  });

  test("hash ignores context lines", () => {
    const more = SAMPLE.replace(" const d = 5;\n", " const d = 5;\n const e = 6;\n").replace("@@ -1,4 +1,5 @@", "@@ -1,5 +1,6 @@");
    expect(parseDiff(more)[0]!.hash).toBe(files[0]!.hash);
    const changed = SAMPLE.replace("+const b = 3;", "+const b = 30;");
    expect(parseDiff(changed)[0]!.hash).not.toBe(files[0]!.hash);
  });

  test("unquotes git paths", () => {
    expect(unquotePath('"caf\\303\\251 \\"x\\".txt"')).toBe('café "x".txt');
  });
});

describe("untrackedDiff", () => {
  test("every line is an addition", () => {
    const f = untrackedDiff("n.ts", "a\nb\n");
    expect(f.hunks[0]!.lines.map((l) => [l.type, l.newNo, l.text])).toEqual([
      ["add", 1, "a"],
      ["add", 2, "b"],
    ]);
  });
});

describe("reanchor", () => {
  const base = makeComment([], { path: "a.ts", side: "new", startLine: 3, endLine: 4, snippet: ["foo()", "bar()"], body: "x" });

  test("stays put when lines are unchanged", () => {
    expect(reanchor(base, ["1", "2", "foo()", "bar()"])).toEqual({ startLine: 3, endLine: 4, outdated: false });
  });
  test("follows lines that moved", () => {
    expect(reanchor(base, ["new", "new", "1", "2", "foo()", "bar()"])).toEqual({ startLine: 5, endLine: 6, outdated: false });
  });
  test("is outdated when lines changed", () => {
    expect(reanchor(base, ["1", "2", "foo(1)", "bar()"]).outdated).toBe(true);
  });
  test("is outdated when the file is gone", () => {
    expect(reanchor(base, null).outdated).toBe(true);
  });
  test("doesn't jump to an unrelated trivial line", () => {
    const brace = { ...base, snippet: ["}"], startLine: 2, endLine: 2 };
    expect(reanchor(brace, ["x", "y", "}"]).outdated).toBe(true);
  });
});

describe("buildPrompt", () => {
  test("includes ids, locations, code and resolve instructions", () => {
    const s = emptyStore();
    const c = makeComment(s.comments, { path: "src/a.ts", side: "new", startLine: 2, endLine: 2, snippet: ["const b = 3;"], body: "Why 3?" });
    const g = makeComment([c], { path: "", side: "new", startLine: 0, endLine: 0, snippet: [], body: "Looks good overall" });
    const p = buildPrompt([c, g], { round: 1, label: "HEAD → working tree" });
    expect(p).toContain(`### [${c.id}] src/a.ts:2`);
    expect(p).toContain("2  const b = 3;");
    expect(p).toContain("Why 3?");
    expect(p).toContain(`### [${g.id}] General`);
    expect(p).toContain("lcr resolve <id>");
    expect(p.indexOf(g.id)).toBeLessThan(p.indexOf(c.id + "] src")); // general first
  });
});
