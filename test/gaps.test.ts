import { expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";
import { computeGaps } from "../ui/src/gaps.ts";

/** Real git diffs at -U0/-U2, checked against the actual old/new file contents. */
async function check(oldLines: string[], newLines: string[], ctx: number) {
  const dir = `${import.meta.dir}/../node_modules/.cache/gaptest-${Math.random().toString(36).slice(2)}`;
  await Bun.write(`${dir}/a`, oldLines.join("\n") + "\n");
  await Bun.write(`${dir}/b`, newLines.join("\n") + "\n");
  const p = Bun.spawnSync(["git", "diff", "--no-index", `-U${ctx}`, "--src-prefix=a/", "--dst-prefix=b/", `${dir}/a`, `${dir}/b`]);
  const file = parseDiff(p.stdout.toString())[0]!;
  for (const g of computeGaps(file.hunks, newLines.length)) {
    for (let n = g.from; n <= g.to; n++) {
      // every hidden line must be unchanged and map to the right old line
      expect(newLines[n - 1]).toBe(oldLines[n - g.delta - 1]);
    }
  }
  // gaps + hunks must cover every new line exactly once
  const covered = new Set<number>();
  for (const h of file.hunks) for (const l of h.lines) if (l.newNo) covered.add(l.newNo);
  for (const g of computeGaps(file.hunks, newLines.length)) for (let n = g.from; n <= g.to; n++) {
    expect(covered.has(n)).toBe(false);
    covered.add(n);
  }
  expect(covered.size).toBe(newLines.length);
}

const base = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);

for (const ctx of [0, 2, 3]) {
  test(`edits, insertions and deletions (U${ctx})`, async () => {
    const next = [...base];
    next.splice(70, 3); // delete
    next[40] = "changed 41"; // modify
    next.splice(10, 0, "ins a", "ins b"); // insert
    next.unshift("top"); // insert at very top
    await check(base, next, ctx);
  });
  test(`pure deletion at the top and append at the end (U${ctx})`, async () => {
    await check(base, [...base.slice(2), "tail 1", "tail 2"], ctx);
  });
}
