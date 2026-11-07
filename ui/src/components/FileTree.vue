<script setup lang="ts">
import { computed } from "vue";
import type { FileDiff } from "../../../src/types.ts";
import { closedDirs, type TreeNode } from "../state.ts";
import FileIcon from "./FileIcon.vue";
import Icon from "./Icon.vue";

const props = defineProps<{
  node: TreeNode;
  depth: number;
  prefix?: string;
  activePath: string | null;
  isViewed: (f: FileDiff) => boolean;
  updated: Set<string>;
  openCount: (path: string) => number;
}>();
const emit = defineEmits<{ select: [path: string]; toggleViewed: [f: FileDiff] }>();

const STATUS_LETTER: Record<FileDiff["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R", untracked: "U" };

const key = (name: string) => (props.prefix ? `${props.prefix}/${name}` : name);
const isClosed = (name: string) => closedDirs.value.has(key(name));
const toggleDir = (name: string) => {
  const s = new Set(closedDirs.value);
  s.has(key(name)) ? s.delete(key(name)) : s.add(key(name));
  closedDirs.value = s;
};

const children = computed(() =>
  [...props.node.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name)),
);
const pad = (extra = 0) => ({ paddingLeft: `${10 + props.depth * 14 + extra}px` });
</script>

<template>
  <template v-for="c in children" :key="(c.file ? 'f:' : 'd:') + c.name">
    <div
      v-if="c.file"
      class="tree-row tree-file"
      :class="[`st-${c.file.status}`, { active: c.file.path === activePath, viewed: isViewed(c.file) }]"
      :style="pad(18)"
      :title="c.file.path"
      @click="emit('select', c.file.path)"
    >
      <FileIcon :path="c.file.path" />
      <span class="tree-name">{{ c.name }}</span>
      <span v-if="updated.has(c.file.path)" class="tree-updated" title="Changed since you opened the page" />
      <span v-if="openCount(c.file.path)" class="tree-count" title="Open comments"><Icon name="comment" :size="12" />{{ openCount(c.file.path) }}</span>
      <span class="tree-status">{{ STATUS_LETTER[c.file.status] }}</span>
      <input type="checkbox" class="cb" title="Viewed (v)" :checked="isViewed(c.file)" @click.stop @change="emit('toggleViewed', c.file)" />
    </div>
    <template v-else>
      <div class="tree-row tree-dir" :style="pad()" @click="toggleDir(c.name)">
        <Icon :name="isClosed(c.name) ? 'chevron-right' : 'chevron-down'" :size="14" class="tree-chev" />
        <Icon :name="isClosed(c.name) ? 'folder' : 'folder-open'" :size="15" class="tree-folder" />
        <span class="tree-name">{{ c.name }}</span>
      </div>
      <div v-if="!isClosed(c.name)" class="tree-group" :style="{ '--guide': `${10 + depth * 14 + 7}px` }">
        <FileTree
          :node="c"
          :depth="depth + 1"
          :prefix="key(c.name)"
          :active-path="activePath"
          :is-viewed="isViewed"
          :updated="updated"
          :open-count="openCount"
          @select="emit('select', $event)"
          @toggle-viewed="emit('toggleViewed', $event)"
        />
      </div>
    </template>
  </template>
</template>
