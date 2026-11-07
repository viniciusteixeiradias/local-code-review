<script setup lang="ts">
import type { Side } from "../../../src/types.ts";
import { api } from "../api.ts";
import { openComposer, rangeLabel } from "../state.ts";
import Editor from "./Editor.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ path: string; side: Side; start: number; end: number }>();

async function submit(body: string) {
  await api("/api/comments", "POST", { path: props.path, side: props.side, startLine: props.start, endLine: props.end, body });
  openComposer(null);
}
</script>

<template>
  <div class="thread composer">
    <div class="thread-head">
      <Icon name="comment-add" :size="14" class="thread-icon" />
      <span class="loc">{{ rangeLabel({ path, side, startLine: start, endLine: end }) }}</span>
    </div>
    <Editor submit-label="Add to review" :submit="submit" @cancel="openComposer(null)" />
  </div>
</template>
