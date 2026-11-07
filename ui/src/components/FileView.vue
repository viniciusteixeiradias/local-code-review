<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import type { DiffLine, FileDiff, Hunk, ReviewComment, Side } from "../../../src/types.ts";
import { api } from "../api.ts";
import { computeGaps, type Gap } from "../gaps.ts";
import { escapeHtml, highlightLines, langFor } from "../highlight.ts";
import { composer, fileDomId, openComposer } from "../state.ts";
import Composer from "./Composer.vue";
import FileIcon from "./FileIcon.vue";
import Icon from "./Icon.vue";
import Thread from "./Thread.vue";

const props = defineProps<{
  file: FileDiff;
  comments: ReviewComment[];
  viewed: boolean;
  changedSinceViewed: boolean;
  updated: boolean;
  collapsed: boolean;
  active: boolean;
  view: "unified" | "split";
}>();
const emit = defineEmits<{ toggleCollapse: []; toggleViewed: []; toggleExpand: [] }>();

const LARGE_DIFF = 1500;
const STATUS_WORD: Record<FileDiff["status"], string> = { added: "added", deleted: "deleted", modified: "modified", renamed: "renamed", untracked: "new" };

const dirName = computed(() => (props.file.path.includes("/") ? props.file.path.slice(0, props.file.path.lastIndexOf("/") + 1) : ""));
const baseName = computed(() => props.file.path.split("/").pop()!);
/** GitHub-style 5-block +/- bar. */
const bars = computed(() => {
  const total = props.file.additions + props.file.deletions;
  if (!total) return Array(5).fill("n");
  const add = Math.round((props.file.additions / total) * 5);
  return [...Array(add).fill("a"), ...Array(5 - add).fill("d")];
});

const forceLarge = ref(false);
const size = computed(() => props.file.additions + props.file.deletions);
const isLarge = computed(() => size.value > LARGE_DIFF && !forceLarge.value);
const renderable = computed(() => !props.collapsed && !isLarge.value && !props.file.binary && !props.file.tooLarge && props.file.hunks.length > 0);

// ---- syntax highlighting: tokenize the whole old/new file, then look lines up by number ----
const lang = computed(() => langFor(props.file.path));
type SideData = { src: string[]; html: string[] | null; full: boolean };
const sides = shallowRef<{ old: SideData | null; new: SideData | null }>({ old: null, new: null });

/** Lines present in the diff for one side, placed at their line numbers (sparse). */
function fromHunks(side: Side): string[] {
  const src: string[] = [];
  for (const h of props.file.hunks)
    for (const l of h.lines) {
      const n = side === "old" ? (l.type !== "add" ? l.oldNo : null) : l.type !== "del" ? l.newNo : null;
      if (n !== null) src[n - 1] = l.text;
    }
  return src;
}

async function loadSide(side: Side): Promise<SideData | null> {
  const st = props.file.status;
  if ((side === "old" && (st === "added" || st === "untracked")) || (side === "new" && st === "deleted")) return null;
  let src: string[] | null = null;
  let full = false;
  if (st !== "untracked") {
    const r = await api<{ lines: string[] | null }>(`/api/content?side=${side}&path=${encodeURIComponent(props.file.path)}`).catch(() => null);
    if (r?.lines) (src = r.lines), (full = true);
  }
  if (!src) src = fromHunks(side); // untracked diffs already hold the whole file
  const dense = full ? src : src.map((l) => l ?? "");
  const html = await (highlightLines(dense, lang.value) ?? Promise.resolve(null)).catch(() => null);
  return { src, html, full };
}

let loadSeq = 0;
watch(
  () => [renderable.value, props.file.hash, props.file.path, lang.value] as const,
  async ([ok]) => {
    if (!ok) return;
    const seq = ++loadSeq;
    const [o, n] = await Promise.all([loadSide("old"), loadSide("new")]);
    if (seq === loadSeq) sides.value = { old: o, new: n };
  },
  { immediate: true },
);

/** Highlighted HTML for a diff line; falls back to plain text if the file changed under us. */
function lineHtml(l: DiffLine): string {
  const side = l.type === "del" ? sides.value.old : sides.value.new;
  const n = l.type === "del" ? l.oldNo : l.newNo;
  if (side?.html && n !== null && side.src[n - 1] === l.text) return side.html[n - 1]!;
  return escapeHtml(l.text);
}

// ---- expandable gaps between hunks (GitHub-style "expand up / down") ----
const STEP = 20;
/** Lines revealed per gap: `top` = right below the previous hunk, `bottom` = right above the next. */
const reveal = ref<Record<number, { top: number; bottom: number }>>({});

const gaps = computed<Gap[]>(() => {
  const nw = sides.value.new;
  if (!nw?.full || props.file.expanded || (props.file.status !== "modified" && props.file.status !== "renamed")) return [];
  return computeGaps(props.file.hunks, nw.src.length);
});
// hunks were added/removed: old reveal counts no longer line up
watch(() => props.file.hunks.length, () => (reveal.value = {}));

interface GapView { gap: Gap; top: DiffLine[]; bottom: DiffLine[]; hidden: number }
const gapViews = computed(() => {
  const src = sides.value.new?.src ?? [];
  const mk = (g: Gap, n: number): DiffLine => ({ type: "ctx", oldNo: n - g.delta, newNo: n, text: src[n - 1] ?? "" });
  const range = (g: Gap, a: number, b: number) => (a > b ? [] : Array.from({ length: b - a + 1 }, (_, i) => mk(g, a + i)));
  const m = new Map<number, GapView>();
  for (const g of gaps.value) {
    const size = g.to - g.from + 1;
    if (size <= 0) continue;
    const r = reveal.value[g.idx] ?? { top: 0, bottom: 0 };
    if (r.top + r.bottom >= size) m.set(g.idx, { gap: g, top: range(g, g.from, g.to), bottom: [], hidden: 0 });
    else m.set(g.idx, { gap: g, top: range(g, g.from, g.from + r.top - 1), bottom: range(g, g.to - r.bottom + 1, g.to), hidden: size - r.top - r.bottom });
  }
  return m;
});

function expandGap(idx: number, dir: "up" | "down" | "all") {
  const gv = gapViews.value.get(idx);
  if (!gv) return;
  const r = { ...(reveal.value[idx] ?? { top: 0, bottom: 0 }) };
  if (dir === "all" || gv.hidden <= STEP) r.top += gv.hidden;
  else if (dir === "down") r.top += STEP; // reveal below the previous hunk
  else r.bottom += STEP; // reveal above the next hunk
  reveal.value = { ...reveal.value, [idx]: r };
}

// ---- comments: inline (anchored to a visible line) vs. shown above the diff ----
const lineKeys = computed(() => {
  const s = new Set<string>();
  for (const h of props.file.hunks)
    for (const l of h.lines) {
      if (l.oldNo !== null) s.add(`old:${l.oldNo}`);
      if (l.newNo !== null) s.add(`new:${l.newNo}`);
    }
  for (const gv of gapViews.value.values())
    for (const l of [...gv.top, ...gv.bottom]) (s.add(`old:${l.oldNo}`), s.add(`new:${l.newNo}`));
  return s;
});
const placement = computed(() => {
  const inline = new Map<string, ReviewComment[]>();
  const top: ReviewComment[] = [];
  for (const c of props.comments) {
    const key = `${c.side}:${c.endLine}`;
    // Resolved comments stay where they were even if the fix rewrote those lines.
    if (c.startLine > 0 && (!c.outdated || c.status === "resolved") && lineKeys.value.has(key)) {
      if (!inline.has(key)) inline.set(key, []);
      inline.get(key)!.push(c);
    } else top.push(c);
  }
  return { inline, top };
});
const openCount = computed(() => props.comments.filter((c) => c.status !== "resolved").length);
const myComposer = computed(() => (composer.value?.path === props.file.path ? composer.value : null));

// ---- rows ----
type Row =
  | { kind: "hunk"; key: string; header: string; gap: number | null; hidden: number; up: boolean; down: boolean }
  | { kind: "line"; key: string; l: DiffLine; html: string; side: Side; n: number | null }
  | { kind: "split"; key: string; left: DiffLine | null; right: DiffLine | null; lh: string; rh: string }
  | { kind: "thread"; key: string; c: ReviewComment }
  | { kind: "composer"; key: string };

function pairs(h: Hunk) {
  const out: { left: DiffLine | null; right: DiffLine | null; lh: string; rh: string }[] = [];
  const L = h.lines;
  let i = 0;
  while (i < L.length) {
    if (L[i]!.type === "ctx") {
      out.push({ left: L[i]!, right: L[i]!, lh: lineHtml(L[i]!), rh: lineHtml(L[i]!) });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < L.length && L[i]!.type === "del") dels.push(i++);
    while (i < L.length && L[i]!.type === "add") adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({
        left: d === undefined ? null : L[d]!,
        right: a === undefined ? null : L[a]!,
        lh: d === undefined ? "" : lineHtml(L[d]!),
        rh: a === undefined ? "" : lineHtml(L[a]!),
      });
    }
  }
  return out;
}

const rows = computed<Row[]>(() => {
  if (!renderable.value) return [];
  const out: Row[] = [];
  const extras = (keys: string[], at: string) => {
    for (const k of keys) {
      for (const c of placement.value.inline.get(k) ?? []) out.push({ kind: "thread", key: `t-${c.id}`, c });
      const cm = myComposer.value;
      if (cm && cm.start > 0 && `${cm.side}:${cm.end}` === k) out.push({ kind: "composer", key: `composer-${at}` });
    }
  };
  const pushLine = (l: DiffLine, key: string) => {
    if (props.view === "unified") {
      const side: Side = l.type === "del" ? "old" : "new";
      out.push({ kind: "line", key, l, html: lineHtml(l), side, n: side === "old" ? l.oldNo : l.newNo });
    } else {
      const h = lineHtml(l);
      out.push({ kind: "split", key, left: l, right: l, lh: h, rh: h });
    }
    extras([`old:${l.oldNo}`, `new:${l.newNo}`], key);
  };
  const pushGap = (idx: number, header: string | null) => {
    const gv = gapViews.value.get(idx);
    gv?.top.forEach((l) => pushLine(l, `g${idx}-${l.newNo}`));
    if (gv && gv.hidden > 0) {
      const g = gv.gap;
      out.push({ kind: "hunk", key: `h${idx}`, header: header ?? "", gap: idx, hidden: gv.hidden, up: !g.last, down: !g.first });
    } else if (header !== null && !gv && !props.file.expanded) {
      out.push({ kind: "hunk", key: `h${idx}`, header, gap: null, hidden: 0, up: false, down: false });
    }
    gv?.bottom.forEach((l) => pushLine(l, `g${idx}-${l.newNo}`));
  };

  props.file.hunks.forEach((h, hi) => {
    pushGap(hi, h.header);
    if (props.view === "unified") {
      h.lines.forEach((l, li) => {
        const side: Side = l.type === "del" ? "old" : "new";
        out.push({ kind: "line", key: `l${hi}-${li}`, l, html: lineHtml(l), side, n: side === "old" ? l.oldNo : l.newNo });
        extras([l.oldNo !== null ? `old:${l.oldNo}` : "", l.newNo !== null ? `new:${l.newNo}` : ""].filter(Boolean), `${hi}-${li}`);
      });
    } else {
      pairs(h).forEach((p, pi) => {
        out.push({ kind: "split", key: `s${hi}-${pi}`, ...p });
        extras([p.left?.oldNo != null ? `old:${p.left.oldNo}` : "", p.right?.newNo != null ? `new:${p.right.newNo}` : ""].filter(Boolean), `${hi}-${pi}`);
      });
    }
  });
  pushGap(props.file.hunks.length, null);
  return out;
});

// ---- line selection (click / drag / shift-click on line numbers) ----
const drag = ref<{ side: Side; anchor: number; current: number } | null>(null);

const selection = computed(() => {
  if (drag.value) {
    const d = drag.value;
    return { side: d.side, start: Math.min(d.anchor, d.current), end: Math.max(d.anchor, d.current) };
  }
  const c = myComposer.value;
  return c && c.start > 0 ? { side: c.side, start: c.start, end: c.end } : null;
});
const isSel = (side: Side, n: number | null | undefined) => {
  const s = selection.value;
  return !!s && n != null && s.side === side && n >= s.start && n <= s.end;
};

function finishDrag() {
  const d = drag.value;
  if (d) openComposer({ path: props.file.path, side: d.side, start: Math.min(d.anchor, d.current), end: Math.max(d.anchor, d.current) });
  drag.value = null;
}
onUnmounted(() => window.removeEventListener("mouseup", finishDrag));

function down(side: Side, n: number | null | undefined, e: MouseEvent) {
  if (n == null || e.button !== 0) return;
  e.preventDefault();
  const c = myComposer.value;
  if (e.shiftKey && c && c.start > 0 && c.side === side) {
    openComposer({ ...c, start: Math.min(c.start, n), end: Math.max(c.end, n) });
    return;
  }
  drag.value = { side, anchor: n, current: n };
  window.addEventListener("mouseup", finishDrag, { once: true });
}
function enter(side: Side, n: number | null | undefined) {
  if (drag.value && n != null && drag.value.side === side) drag.value = { ...drag.value, current: n };
}

const sign = (l: DiffLine) => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ");
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyPath() {
  await navigator.clipboard?.writeText(props.file.path).catch(() => {});
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <section :id="fileDomId(file.path)" class="file" :class="{ active, viewed }">
    <header class="file-head" @dblclick.self="emit('toggleCollapse')">
      <button class="icon-btn chev" :title="collapsed ? 'Expand (x)' : 'Collapse (x)'" @click="emit('toggleCollapse')">
        <Icon :name="collapsed ? 'chevron-right' : 'chevron-down'" />
      </button>
      <FileIcon :path="file.path" />
      <span class="path" :title="file.path" @click="emit('toggleCollapse')">
        <template v-if="file.oldPath"><span class="old-path">{{ file.oldPath }}</span><span class="arrow">→</span></template>
        <span class="dir">{{ dirName }}</span><span class="base">{{ baseName }}</span>
      </span>
      <button class="icon-btn copy-btn" :class="{ copied }" :title="copied ? 'Copied!' : 'Copy path'" @click.stop="copyPath"><Icon :name="copied ? 'check' : 'copy'" :size="14" /></button>
      <span class="status-tag" :class="`st-${file.status}`">{{ STATUS_WORD[file.status] }}</span>
      <span class="stat">
        <span v-if="file.additions" class="add">+{{ file.additions }}</span>
        <span v-if="file.deletions" class="del">−{{ file.deletions }}</span>
        <span class="bars" aria-hidden="true"><i v-for="(b, i) in bars" :key="i" :class="b" /></span>
      </span>
      <span v-if="changedSinceViewed" class="badge warn"><Icon name="history" :size="12" />changed since viewed</span>
      <span v-else-if="updated" class="badge info"><Icon name="refresh" :size="12" />updated</span>
      <span v-if="openCount" class="badge comments" title="Open comments"><Icon name="comment" :size="12" />{{ openCount }}</span>
      <span class="spacer" />
      <button v-if="file.status !== 'untracked' && !file.binary" class="btn ghost small" title="Show the whole file" @click="emit('toggleExpand')">
        <Icon :name="file.expanded ? 'fold' : 'unfold'" :size="14" />{{ file.expanded ? "Fold" : "Expand" }}
      </button>
      <button class="btn ghost small" title="Comment on the whole file" @click="openComposer({ path: file.path, side: 'new', start: 0, end: 0 })">
        <Icon name="comment-add" :size="14" />Comment
      </button>
      <label class="viewed-toggle" :class="{ on: viewed }" title="Mark as viewed (v)">
        <input type="checkbox" class="cb" :checked="viewed" @change="emit('toggleViewed')" />
        Viewed
      </label>
    </header>

    <div v-if="placement.top.length || (myComposer && myComposer.start === 0)" class="file-comments">
      <Composer v-if="myComposer && myComposer.start === 0" :path="file.path" side="new" :start="0" :end="0" />
      <Thread v-for="c in placement.top" :key="c.id" :c="c" show-snippet />
    </div>

    <div v-if="!collapsed" class="file-body">
      <div v-if="file.binary" class="placeholder">Binary file</div>
      <div v-else-if="file.tooLarge" class="placeholder">File too large to display</div>
      <div v-else-if="isLarge" class="placeholder">
        Large diff ({{ size }} lines) hidden. <button class="link" @click="forceLarge = true">Load diff</button>
      </div>
      <div v-else-if="!file.hunks.length" class="placeholder">{{ file.status === "renamed" ? "File renamed without changes" : "Empty file" }}</div>

      <table v-else-if="view === 'unified'" class="diff unified">
        <colgroup><col class="c-num" /><col class="c-num" /><col /></colgroup>
        <tbody>
          <template v-for="r in rows" :key="r.key">
            <tr v-if="r.kind === 'hunk'" class="hunk-header" :class="{ expandable: r.gap !== null }">
              <td class="expander" :colspan="2">
                <template v-if="r.gap !== null">
                  <button v-if="r.hidden <= STEP" class="exp-btn" :title="`Show ${r.hidden} hidden line${r.hidden === 1 ? '' : 's'}`" @click="expandGap(r.gap, 'all')"><Icon name="unfold" :size="14" /></button>
                  <template v-else>
                    <button v-if="r.down" class="exp-btn" :title="`Show ${STEP} more lines below`" @click="expandGap(r.gap, 'down')"><Icon name="chevron-down" :size="14" /></button>
                    <button v-if="r.up" class="exp-btn" :title="`Show ${STEP} more lines above`" @click="expandGap(r.gap, 'up')"><Icon name="chevron-down" :size="14" class="flip" /></button>
                  </template>
                </template>
              </td>
              <td :colspan="1" class="hunk-text" @click="r.gap !== null && expandGap(r.gap, 'all')">
                {{ r.header }}<span v-if="r.gap !== null" class="hidden-count">{{ r.hidden }} hidden line{{ r.hidden === 1 ? "" : "s" }} · click to expand all</span>
              </td>
            </tr>
            <tr v-else-if="r.kind === 'line'" class="line" :class="[r.l.type, { selected: isSel(r.side, r.n) }]">
              <td class="num clickable" @mousedown="down(r.side, r.n, $event)" @mouseenter="enter(r.side, r.n)">{{ r.l.oldNo ?? "" }}</td>
              <td class="num clickable" @mousedown="down(r.side, r.n, $event)" @mouseenter="enter(r.side, r.n)">{{ r.l.newNo ?? "" }}</td>
              <td class="code" @mouseenter="enter(r.side, r.n)"><button class="add-btn" title="Comment on this line (drag for a range)" @mousedown="down(r.side, r.n, $event)"><Icon name="comment-add" :size="14" /></button><span class="sign">{{ sign(r.l) }}</span><span v-html="r.html || '&#8203;'" /><span v-if="r.l.noNewline" class="nonl" title="No newline at end of file">∅⏎</span></td>
            </tr>
            <tr v-else-if="r.kind === 'thread'" class="thread-row"><td colspan="3"><Thread :c="r.c" /></td></tr>
            <tr v-else-if="r.kind === 'composer' && myComposer" class="thread-row"><td colspan="3"><Composer v-bind="myComposer" /></td></tr>
          </template>
        </tbody>
      </table>

      <table v-else class="diff split">
        <colgroup><col class="c-num" /><col /><col class="c-num" /><col /></colgroup>
        <tbody>
          <template v-for="r in rows" :key="r.key">
            <tr v-if="r.kind === 'hunk'" class="hunk-header" :class="{ expandable: r.gap !== null }">
              <td class="expander" :colspan="1">
                <template v-if="r.gap !== null">
                  <button v-if="r.hidden <= STEP" class="exp-btn" :title="`Show ${r.hidden} hidden line${r.hidden === 1 ? '' : 's'}`" @click="expandGap(r.gap, 'all')"><Icon name="unfold" :size="14" /></button>
                  <template v-else>
                    <button v-if="r.down" class="exp-btn" :title="`Show ${STEP} more lines below`" @click="expandGap(r.gap, 'down')"><Icon name="chevron-down" :size="14" /></button>
                    <button v-if="r.up" class="exp-btn" :title="`Show ${STEP} more lines above`" @click="expandGap(r.gap, 'up')"><Icon name="chevron-down" :size="14" class="flip" /></button>
                  </template>
                </template>
              </td>
              <td :colspan="3" class="hunk-text" @click="r.gap !== null && expandGap(r.gap, 'all')">
                {{ r.header }}<span v-if="r.gap !== null" class="hidden-count">{{ r.hidden }} hidden line{{ r.hidden === 1 ? "" : "s" }} · click to expand all</span>
              </td>
            </tr>
            <tr v-else-if="r.kind === 'split'" class="line">
              <td class="num" :class="[r.left?.type ?? 'blank', { clickable: r.left, selected: isSel('old', r.left?.oldNo) }]" @mousedown="down('old', r.left?.oldNo, $event)" @mouseenter="enter('old', r.left?.oldNo)">{{ r.left?.oldNo ?? "" }}</td>
              <td class="code half" :class="[r.left?.type ?? 'blank', { selected: isSel('old', r.left?.oldNo) }]" @mouseenter="enter('old', r.left?.oldNo)"><template v-if="r.left"><button class="add-btn" title="Comment on this line (drag for a range)" @mousedown="down('old', r.left.oldNo, $event)"><Icon name="comment-add" :size="14" /></button><span class="sign">{{ sign(r.left) }}</span><span v-html="r.lh || '&#8203;'" /></template></td>
              <td class="num" :class="[r.right?.type ?? 'blank', { clickable: r.right, selected: isSel('new', r.right?.newNo) }]" @mousedown="down('new', r.right?.newNo, $event)" @mouseenter="enter('new', r.right?.newNo)">{{ r.right?.newNo ?? "" }}</td>
              <td class="code half" :class="[r.right?.type ?? 'blank', { selected: isSel('new', r.right?.newNo) }]" @mouseenter="enter('new', r.right?.newNo)"><template v-if="r.right"><button class="add-btn" title="Comment on this line (drag for a range)" @mousedown="down('new', r.right.newNo, $event)"><Icon name="comment-add" :size="14" /></button><span class="sign">{{ sign(r.right) }}</span><span v-html="r.rh || '&#8203;'" /></template></td>
            </tr>
            <tr v-else-if="r.kind === 'thread'" class="thread-row split">
              <td colspan="2" :class="r.c.side === 'old' ? 'side-cell' : 'blank-cell'"><Thread v-if="r.c.side === 'old'" :c="r.c" /></td>
              <td colspan="2" :class="r.c.side === 'new' ? 'side-cell' : 'blank-cell'"><Thread v-if="r.c.side === 'new'" :c="r.c" /></td>
            </tr>
            <tr v-else-if="r.kind === 'composer' && myComposer" class="thread-row split">
              <td colspan="2" :class="myComposer.side === 'old' ? 'side-cell' : 'blank-cell'"><Composer v-if="myComposer.side === 'old'" v-bind="myComposer" /></td>
              <td colspan="2" :class="myComposer.side === 'new' ? 'side-cell' : 'blank-cell'"><Composer v-if="myComposer.side === 'new'" v-bind="myComposer" /></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
