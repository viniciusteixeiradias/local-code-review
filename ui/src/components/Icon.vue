<script setup lang="ts">
// 16px line icons drawn for lcr (stroke-based, inherit currentColor).
const PATHS = {
  "chevron-right": ["M6 3.5l4.5 4.5L6 12.5"],
  "chevron-down": ["M3.5 6L8 10.5 12.5 6"],
  file: ["M3.5 1.5h5.5l3.5 3.5v9.5h-9z", "M9 1.5V5h3.5"],
  folder: ["M1.5 3h4.5l1.5 1.5h7v9h-13z"],
  "folder-open": ["M1.5 13V3h4.5l1.5 1.5h6V7", "M1.5 13l2-6h11.5l-2 6z"],
  comment: ["M2 2.5h12v8.5H8l-3.5 3v-3H2z"],
  "comment-add": ["M2 2.5h12v8.5H8l-3.5 3v-3H2z", "M8 4.5v4.5M5.75 6.75h4.5"],
  check: ["M3 8.5l3.25 3.25L13 5"],
  "check-circle": ["M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13z", "M5.25 8.25l1.9 1.9 3.6-3.9"],
  copy: ["M5.5 5.5h8v8.5h-8z", "M10.5 5.5V2h-8v8.5h3"],
  unfold: ["M8 1.5v4.5M5.75 3.75L8 1.5l2.25 2.25", "M8 14.5V10M5.75 12.25L8 14.5l2.25-2.25", "M2 8h2M6 8h4M12 8h2"],
  fold: ["M8 1.5V6M5.75 3.75L8 6l2.25-2.25", "M8 14.5V10M5.75 12.25L8 10l2.25 2.25", "M2 8h2M6 8h4M12 8h2"],
  send: ["M2 2.5l12 5.5-12 5.5 2.25-5.5z", "M4.25 8H9"],
  x: ["M4 4l8 8M12 4l-8 8"],
  eye: ["M1.25 8S3.75 3 8 3s6.75 5 6.75 5S12.25 13 8 13 1.25 8 1.25 8z", "M8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4z"],
  branch: ["M4.5 2v12", "M11.5 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 1 0 0-3.5z", "M11.5 6v.75a2.25 2.25 0 0 1-2.25 2.25H4.5"],
  refresh: ["M13.25 8a5.25 5.25 0 1 1-1.54-3.71", "M12.5 1.75v3h-3"],
  split: ["M1.5 2.5h13v11h-13z", "M8 2.5v11"],
  sidebar: ["M1.5 2.5h13v11h-13z", "M6 2.5v11", "M3 5h1.5M3 7h1.5"],
  unified: ["M1.5 2.5h13v11h-13z", "M1.5 8h13"],
  keyboard: ["M1.5 4h13v8h-13z", "M4 6.75h.5M6.5 6.75h.5M9 6.75h.5M11.5 6.75h.5M4.75 9.5h6.5"],
  search: ["M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9z", "M10.25 10.25L14 14"],
  trash: ["M2.5 4h11", "M6 4V2.5h4V4", "M4 4l.75 9.5h6.5L12 4"],
  pencil: ["M10.5 2.25l3.25 3.25-8.25 8.25H2.25V10.5z", "M8.75 4l3.25 3.25"],
  reply: ["M6.5 3.5L2.5 7.5l4 4", "M2.5 7.5H9a4.5 4.5 0 0 1 4.5 4.5v1"],
  pilcrow: ["M7.5 13.5v-11h5.5", "M10.5 2.5v11", "M7.5 2.5a3 3 0 0 0 0 6"],
  terminal: ["M1.5 2.5h13v11h-13z", "M4.25 6l2 2-2 2", "M8 10.25h3.75"],
  plus: ["M8 3v10M3 8h10"],
  repo: ["M3 2.5A1 1 0 0 1 4 1.5h9v10.5H4a1 1 0 0 0-1 1z", "M3 13a1 1 0 0 0 1 1h9", "M5.5 4.5h1M5.5 7h1"],
  dot: ["M8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z"],
  history: ["M2.25 8a5.75 5.75 0 1 0 1.7-4.07", "M2 2v2.5h2.5", "M8 5v3.25l2 1.25"],
} as const;

export type IconName = keyof typeof PATHS;

defineProps<{ name: IconName; size?: number }>();
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.35"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in PATHS[name]" :key="i" :d="d" />
  </svg>
</template>
