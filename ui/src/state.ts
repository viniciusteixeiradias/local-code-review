import { ref } from "vue";
import type { FileDiff, Side } from "../../src/types.ts";

export interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file?: FileDiff;
}

/** The single open "new comment" box. start = 0 means a file-level comment; path "" a general one. */
export interface ComposerState {
  path: string;
  side: Side;
  start: number;
  end: number;
}

export const composer = ref<ComposerState | null>(null);

export function openComposer(c: ComposerState | null) {
  // Don't throw away a half-written comment.
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (c && composer.value && ta?.value.trim()) {
    ta.focus();
    return;
  }
  composer.value = c;
}

/** Closed folders in the file tree, keyed by full folder path. */
export const closedDirs = ref(new Set<string>());

export const toast = ref<{ msg: string; error: boolean } | null>(null);

export function notify(msg: string, error = false) {
  toast.value = { msg, error };
  setTimeout(() => {
    if (toast.value?.msg === msg) toast.value = null;
  }, 4000);
}

export function fileDomId(path: string) {
  return "file-" + encodeURIComponent(path);
}

export function timeAgo(when: string | number) {
  const s = Math.round((Date.now() - new Date(when).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function rangeLabel(c: { path: string; startLine: number; endLine: number; side: Side }) {
  if (!c.path) return "General comment";
  if (c.startLine === 0) return "File comment";
  const r = c.startLine === c.endLine ? `Line ${c.startLine}` : `Lines ${c.startLine}–${c.endLine}`;
  return c.side === "old" ? `${r} (original)` : r;
}
