import type { ReviewComment } from "./types.ts";

function matchesAt(lines: string[], snippet: string[], start: number): boolean {
  if (start < 0 || start + snippet.length > lines.length) return false;
  for (let i = 0; i < snippet.length; i++) if (lines[start + i] !== snippet[i]) return false;
  return true;
}

/**
 * Find where a comment's lines are now. If the exact lines are still at the same
 * spot, nothing changes; if they moved, follow them (nearest match wins); if they
 * are gone, the comment is outdated (like GitHub).
 */
export function reanchor(c: ReviewComment, lines: string[] | null): Pick<ReviewComment, "startLine" | "endLine" | "outdated"> {
  const keep = { startLine: c.startLine, endLine: c.endLine };
  if (c.startLine === 0 || !c.path) return { ...keep, outdated: false };
  if (!lines || !c.snippet.length) return { ...keep, outdated: true };

  const start = c.startLine - 1;
  if (matchesAt(lines, c.snippet, start)) return { ...keep, outdated: false };

  let best = -1;
  for (let i = 0; i + c.snippet.length <= lines.length; i++) {
    if (matchesAt(lines, c.snippet, i) && (best < 0 || Math.abs(i - start) < Math.abs(best - start))) best = i;
  }
  // A single blank / brace line matching somewhere else is not meaningful.
  const trivial = c.snippet.every((l) => l.trim().length <= 2);
  if (best >= 0 && !trivial) {
    return { startLine: best + 1, endLine: best + c.snippet.length, outdated: false };
  }
  return { ...keep, outdated: true };
}
