import type { Hunk } from "../../src/types.ts";

/** A run of unchanged lines hidden between hunks (new-side line numbers, inclusive). */
export interface Gap {
  idx: number;
  from: number;
  to: number;
  /** newNo - oldNo for every line in the gap. */
  delta: number;
  first: boolean;
  last: boolean;
}

// git uses "the line before" as the start when a side has 0 lines; normalise to the first line touched.
const ns = (h: Hunk) => (h.newLines === 0 ? h.newStart + 1 : h.newStart);
const os = (h: Hunk) => (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart);

export function computeGaps(hunks: Hunk[], newLength: number): Gap[] {
  const out: Gap[] = [];
  hunks.forEach((h, i) => {
    const prev = hunks[i - 1];
    const from = prev ? ns(prev) + prev.newLines : 1;
    const delta = prev ? ns(prev) + prev.newLines - (os(prev) + prev.oldLines) : 0;
    out.push({ idx: i, from, to: ns(h) - 1, delta, first: i === 0, last: false });
  });
  const last = hunks[hunks.length - 1];
  if (last) {
    const end = ns(last) + last.newLines;
    out.push({ idx: hunks.length, from: end, to: newLength, delta: end - (os(last) + last.oldLines), first: false, last: true });
  }
  return out;
}
