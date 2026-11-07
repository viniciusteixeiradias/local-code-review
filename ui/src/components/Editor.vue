<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";

const props = defineProps<{
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  submit: (text: string) => Promise<void>;
}>();
const emit = defineEmits<{ cancel: [] }>();

const text = ref(props.initial ?? "");
const busy = ref(false);
const error = ref<string | null>(null);
const ta = ref<HTMLTextAreaElement>();
const rows = computed(() => Math.min(14, Math.max(3, text.value.split("\n").length + 1)));

onMounted(async () => {
  await nextTick();
  ta.value?.focus();
  ta.value?.setSelectionRange(text.value.length, text.value.length);
});

async function save() {
  if (!text.value.trim() || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await props.submit(text.value);
  } catch (e) {
    error.value = (e as Error).message;
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void save();
  } else if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  }
}
</script>

<template>
  <div class="editor">
    <textarea ref="ta" v-model="text" :rows="rows" :placeholder="placeholder ?? 'Leave a comment'" @keydown="onKey" />
    <div v-if="error" class="error-text">{{ error }}</div>
    <div class="editor-actions">
      <span class="hint"><kbd>⌘↵</kbd> save <kbd>esc</kbd> cancel</span>
      <button class="btn" @click="emit('cancel')">Cancel</button>
      <button class="btn primary" :disabled="!text.trim() || busy" @click="save">{{ submitLabel }}</button>
    </div>
  </div>
</template>
