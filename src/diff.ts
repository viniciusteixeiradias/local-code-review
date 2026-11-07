import type { DiffLine, FileDiff, Hunk } from "./types.ts";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Undo git's C-style path quoting ("a/caf\303\251.txt"). */
export function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = inner[++i]!;
    if (/[0-7]/.test(next)) {
      const oct = inner.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
      bytes.push(...new TextEncoder().encode(map[next] ?? next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(p: string): string | null {
  p = unquotePath(p.replace(/\t.*$/, ""));
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Parse "diff --git a/X b/Y". Ambiguous with spaces, so prefer the same-path case. */
function parseGitHeader(line: string): { a: string; b: string } {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*") (.*)$/);
    if (m) return { a: stripPrefix(m[1]!) ?? "", b: stripPrefix(m[2]!) ?? "" };
  }
  if ((rest.length - 5) % 2 === 0) {
    const len = (rest.length - 5) / 2;
    const a = rest.slice(2, 2 + len);
    const b = rest.slice(len + 5);
    if (a === b && rest.slice(2 + len, len + 5) === " b/") return { a, b };
  }
  const idx = rest.indexOf(" b/");
  if (idx > 0) return { a: rest.slice(2, idx), b: rest.slice(idx + 3) };
  return { a: rest, b: rest };
}

export function hashFile(f: Pick<FileDiff, "status" | "path" | "oldPath" | "hunks" | "binary">): string {
  const parts: string[] = [f.status, f.oldPath ?? "", f.path, f.binary ? "bin" : ""];
  for (const h of f.hunks) for (const l of h.lines) if (l.type !== "ctx") parts.push(l.type + l.text);
  return Bun.hash(parts.join("\n")).toString(36);
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let remOld = 0;
  let remNew = 0;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (hunk && (remOld > 0 || remNew > 0)) {
      const c = line[0];
      let dl: DiffLine | null = null;
      if (c === "+") {
        dl = { type: "add", oldNo: null, newNo: newNo++, text: line.slice(1) };
        remNew--;
        cur!.additions++;
      } else if (c === "-") {
        dl = { type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) };
        remOld--;
        cur!.deletions++;
      } else if (c === " " || line === "") {
        dl = { type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) };
        remOld--;
        remNew--;
      } else if (c === "\\") {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewline = true;
        continue;
      }
      if (dl) {
        hunk.lines.push(dl);
        continue;
      }
    }

    if (line.startsWith("diff --git ")) {
      const { a, b } = parseGitHeader(line);
      cur = { path: b, oldPath: a !== b ? a : null, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0, hash: "", expanded: false };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("\\")) {
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (line.startsWith("@@")) {
      const m = line.match(HUNK_RE);
      if (!m) continue;
      hunk = {
        header: line,
        oldStart: +m[1]!,
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3]!,
        newLines: m[4] === undefined ? 1 : +m[4],
        lines: [],
      };
      remOld = hunk.oldLines;
      remNew = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      cur.hunks.push(hunk);
    } else if (line.startsWith("new file mode")) {
      cur.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      cur.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      cur.oldPath = unquotePath(line.slice(12));
      cur.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      cur.path = unquotePath(line.slice(10));
      cur.status = "renamed";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      cur.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4));
      if (p === null) cur.status = "added";
      else if (cur.status !== "renamed") cur.oldPath = p !== cur.path ? p : null;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p === null) {
        cur.status = "deleted";
      } else {
        cur.path = p;
      }
    }
  }

  for (const f of files) {
    if (f.status === "deleted" && f.oldPath) {
      f.path = f.oldPath;
      f.oldPath = null;
    }
    if (f.status === "added" || f.status === "deleted") f.oldPath = null;
    f.hash = hashFile(f);
  }
  return files;
}

/** Build a FileDiff for an untracked file: every line is an addition. */
export function untrackedDiff(path: string, content: string | null, opts: { binary?: boolean; tooLarge?: boolean } = {}): FileDiff {
  const f: FileDiff = { path, oldPath: null, status: "untracked", binary: !!opts.binary, tooLarge: opts.tooLarge, hunks: [], additions: 0, deletions: 0, hash: "", expanded: true };
  if (content && !opts.binary && !opts.tooLarge) {
    const lines = content.split("\n");
    const noNewline = !content.endsWith("\n");
    if (!noNewline) lines.pop();
    if (lines.length) {
      const hunk: Hunk = { header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: [] };
      lines.forEach((text, i) => hunk.lines.push({ type: "add", oldNo: null, newNo: i + 1, text }));
      if (noNewline) hunk.lines[hunk.lines.length - 1]!.noNewline = true;
      f.hunks.push(hunk);
      f.additions = lines.length;
    }
  }
  f.hash = hashFile(f);
  return f;
}
