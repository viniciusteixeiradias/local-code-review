<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { Delivery, TmuxPane } from "../../../src/types.ts";
import { api, usePersisted } from "../api.ts";
import Icon from "./Icon.vue";

const props = defineProps<{ draftCount: number }>();
const emit = defineEmits<{ close: []; done: [msg: string] }>();

const summary = ref("");
const panes = ref<TmuxPane[] | null>(null);
const kind = usePersisted<Delivery["kind"]>("lcr.delivery", "tmux");
const target = ref("");
const preview = ref<{ prompt: string; count: number } | null>(null);
const showPreview = usePersisted("lcr.showPreview", false);
const busy = ref(false);
const error = ref<string | null>(null);

async function loadPanes() {
  const r = await api<{ panes: TmuxPane[]; last: string | null }>("/api/tmux/panes");
  panes.value = r.panes;
  const has = (id: string | null) => !!id && r.panes.some((p) => p.id === id);
  target.value = has(target.value) ? target.value : has(r.last) ? r.last! : (r.panes[0]?.id ?? "");
}
onMounted(loadPanes);

let t: ReturnType<typeof setTimeout> | undefined;
watch(
  [summary, () => props.draftCount],
  () => {
    clearTimeout(t);
    t = setTimeout(async () => (preview.value = await api("/api/preview", "POST", { summary: summary.value })), 150);
  },
  { immediate: true },
);

const noTmux = computed(() => panes.value !== null && panes.value.length === 0);
const effectiveKind = computed<Delivery["kind"]>(() => (kind.value === "tmux" && noTmux.value ? "clipboard" : kind.value));
const count = computed(() => preview.value?.count ?? props.draftCount);
const canSubmit = computed(() => count.value > 0 && !busy.value && (effectiveKind.value !== "tmux" || !!target.value));
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const plural = (n: number) => `${n} comment${n === 1 ? "" : "s"}`;

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = null;
  const k = effectiveKind.value;
  const delivery: Delivery = k === "tmux" ? { kind: "tmux", target: target.value } : { kind: k };
  try {
    const r = await api<{ prompt: string; count: number }>("/api/submit", "POST", { summary: summary.value, delivery });
    if (k === "clipboard") await navigator.clipboard?.writeText(r.prompt).catch(() => {});
    const pane = panes.value?.find((p) => p.id === target.value);
    emit(
      "done",
      k === "tmux"
        ? `Sent ${plural(r.count)} to ${pane?.name ?? target.value}`
        : k === "clipboard"
          ? `Copied ${plural(r.count)} to the clipboard`
          : `Queued ${plural(r.count)}: ask Claude to run \`lcr feedback\``,
    );
  } catch (e) {
    error.value = (e as Error).message;
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal" @keydown="onKey">
      <div class="modal-head"><Icon name="send" /><h2>Submit review</h2><span class="spacer" /><button class="icon-btn" @click="emit('close')"><Icon name="x" /></button></div>
      <textarea v-model="summary" autofocus class="summary" rows="3" placeholder="Overall comment (optional)" />

      <div class="delivery">
        <div class="delivery-title">Send to</div>

        <label class="opt" :class="{ on: effectiveKind === 'tmux', disabled: noTmux }">
          <input type="radio" :checked="effectiveKind === 'tmux'" :disabled="noTmux" @change="kind = 'tmux'" />
          <div>
            <div class="opt-title"><Icon name="terminal" :size="14" />tmux pane <button class="link" @click.prevent="loadPanes">refresh</button></div>
            <div v-if="panes === null" class="opt-desc">Looking for panes…</div>
            <div v-else-if="noTmux" class="opt-desc">No tmux server found.</div>
            <select v-else v-model="target" @change="kind = 'tmux'">
              <option v-for="p in panes" :key="p.id" :value="p.id">
                {{ p.isClaude ? "✳ " : "" }}{{ p.name }} · {{ p.command }} · {{ home(p.path) }}{{ p.sameRepo ? " (this repo)" : "" }}
              </option>
            </select>
            <div class="opt-desc">Pastes the review into the pane and presses Enter. Claude resolves comments as it fixes them.</div>
          </div>
        </label>

        <label class="opt" :class="{ on: effectiveKind === 'clipboard' }">
          <input type="radio" :checked="effectiveKind === 'clipboard'" @change="kind = 'clipboard'" />
          <div>
            <div class="opt-title"><Icon name="copy" :size="14" />Clipboard</div>
            <div class="opt-desc">Copy the prompt and paste it wherever you like.</div>
          </div>
        </label>

        <label class="opt" :class="{ on: effectiveKind === 'queue' }">
          <input type="radio" :checked="effectiveKind === 'queue'" @change="kind = 'queue'" />
          <div>
            <div class="opt-title"><Icon name="history" :size="14" />Queue only</div>
            <div class="opt-desc">Mark as sent; Claude picks it up with <code>lcr feedback</code> (e.g. via the <code>/review-feedback</code> command).</div>
          </div>
        </label>
      </div>

      <button class="link" @click="showPreview = !showPreview">{{ showPreview ? "Hide" : "Show" }} prompt preview</button>
      <pre v-if="showPreview" class="preview">{{ preview?.prompt || "Nothing to send yet." }}</pre>

      <div v-if="error" class="error-text">{{ error }}</div>
      <div class="modal-actions">
        <span class="hint"><kbd>⌘↵</kbd> send</span>
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="!canSubmit" @click="submit"><Icon name="send" :size="14" />{{ busy ? "Sending…" : `Send ${plural(count)}` }}</button>
      </div>
    </div>
  </div>
</template>
