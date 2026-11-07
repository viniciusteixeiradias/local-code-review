<script setup lang="ts">
import { computed } from "vue";

// Language-tinted file badge, in the spirit of editor file-icon themes.
const LANGS: Record<string, [label: string, color: string]> = {
  go: ["GO", "#00add8"], ts: ["TS", "#3178c6"], tsx: ["TSX", "#3178c6"], mts: ["TS", "#3178c6"], cts: ["TS", "#3178c6"],
  js: ["JS", "#e8d44d"], jsx: ["JSX", "#e8d44d"], mjs: ["JS", "#e8d44d"], cjs: ["JS", "#e8d44d"], vue: ["VUE", "#41b883"],
  svelte: ["SV", "#ff3e00"], py: ["PY", "#4b8bbe"], rb: ["RB", "#cc342d"], rs: ["RS", "#dea584"], java: ["JV", "#e76f00"],
  kt: ["KT", "#a97bff"], swift: ["SW", "#f05138"], c: ["C", "#a8b9cc"], h: ["H", "#a8b9cc"], cpp: ["C++", "#f34b7d"],
  cs: ["C#", "#68217a"], php: ["PHP", "#777bb4"], sh: ["SH", "#89e051"], bash: ["SH", "#89e051"], zsh: ["SH", "#89e051"],
  lua: ["LUA", "#6c7bd6"], sql: ["SQL", "#e38c00"], json: ["{}", "#cbcb41"], yaml: ["YML", "#cb4b4b"], yml: ["YML", "#cb4b4b"],
  toml: ["TML", "#9c4221"], md: ["MD", "#519aba"], mdx: ["MDX", "#519aba"], html: ["<>", "#e34c26"], css: ["CSS", "#563d7c"],
  scss: ["SCS", "#c6538c"], graphql: ["GQL", "#e10098"], proto: ["PB", "#6a9fb5"], ex: ["EX", "#a074c4"], exs: ["EX", "#a074c4"],
  dart: ["DRT", "#00b4ab"], zig: ["ZIG", "#f7a41d"], nix: ["NIX", "#7e7eff"], tf: ["TF", "#844fba"], lock: ["LCK", "#8a8a8a"],
  env: ["ENV", "#ecd53f"], txt: ["TXT", "#8a8a8a"], svg: ["SVG", "#ffb13b"], png: ["IMG", "#a074c4"], jpg: ["IMG", "#a074c4"],
};
const NAMES: Record<string, [string, string]> = {
  dockerfile: ["DKR", "#2496ed"], makefile: ["MK", "#6d8086"], "go.mod": ["GO", "#00add8"], "go.sum": ["GO", "#00add8"],
  "package.json": ["NPM", "#cb3837"], ".gitignore": ["GIT", "#f05033"], license: ["LIC", "#cbcb41"],
};

const props = defineProps<{ path: string }>();
const info = computed(() => {
  const base = props.path.split("/").pop()!.toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return NAMES[base] ?? LANGS[ext] ?? [ext.slice(0, 3).toUpperCase() || "—", "#8a8a8a"];
});
</script>

<template>
  <span class="file-icon" :style="{ '--fi': info[1] }" :title="path">{{ info[0] }}</span>
</template>
