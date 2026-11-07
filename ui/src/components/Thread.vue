<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ReviewComment } from "../../../src/types.ts";
import { api } from "../api.ts";
import { notify, rangeLabel, timeAgo } from "../state.ts";
import Editor from "./Editor.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ c: ReviewComment; showSnippet?: boolean }>();

const mode = ref<"view" | "reply" | "edit">("view");
/** Claude marked it fixed; it stays open until you confirm with Resolve. */
const agentFixed = computed(() => props.c.status === "resolved" && props.c.resolvedBy === "agent");
const collapsedByDefault = () => props.c.status === "resolved" && props.c.resolvedBy !== "agent";
const open = ref(!collapsedByDefault());
watch(
  () => [props.c.status, props.c.resolvedBy],
  () => (open.value = !collapsedByDefault()),
);

const lastUser = computed(() => [...props.c.thread].reverse().find((m) => m.author === "user"));
const lastAgent = computed(() => [...props.c.thread].reverse().find((m) => m.author === "agent"));
const agentReplied = computed(() => props.c.status !== "resolved" && props.c.thread[props.c.thread.length - 1]?.author === "agent");

/** Plain text with inline `code` spans. */
function parts(text: string) {
  return text.split(/(`[^`\n]+`)/g).map((p) => (p.length > 2 && p.startsWith("`") && p.endsWith("`") ? { code: true, t: p.slice(1, -1) } : { code: false, t: p }));
}

const run = (p: Promise<unknown>) => p.catch((e) => notify(e.message, true));
const del = () => run(api(`/api/comments/${props.c.id}`, "DELETE"));
const setStatus = (status: string) => run(api(`/api/comments/${props.c.id}`, "PATCH", { status }));

async function saveEdit(body: string) {
  await api(`/api/comments/${props.c.id}`, "PATCH", { body });
  mode.value = "view";
}
async function saveReply(body: string) {
  await api(`/api/comments/${props.c.id}/reply`, "POST", { body });
  mode.value = "view";
}
</script>

<template>
  <div v-if="!open" class="thread collapsed" :class="`status-${c.status}`" :id="`comment-${c.id}`" @click="open = true">
    <Icon name="check-circle" :size="14" class="resolved-icon" />
    <span class="loc">{{ rangeLabel(c) }}</span>
    <span class="collapsed-text">{{ c.thread[0]?.body.split("\n")[0] }}</span>
    <span v-if="lastAgent" class="collapsed-note">→ {{ lastAgent.body.split("\n")[0] }}</span>
  </div>

  <div v-else class="thread" :class="`status-${c.status}`" :id="`comment-${c.id}`" :data-comment="c.id">
    <div class="thread-head">
      <Icon name="comment" :size="14" class="thread-icon" />
      <span v-if="c.status === 'draft'" class="pill draft">draft</span>
      <span v-if="c.status === 'pending' && !agentReplied" class="pill pending">sent{{ c.round ? ` · r${c.round}` : "" }}</span>
      <span v-if="agentReplied" class="pill replied">claude replied</span>
      <span v-if="agentFixed" class="pill replied">claude fixed · confirm</span>
      <span v-else-if="c.status === 'resolved'" class="pill resolved">resolved</span>
      <span v-if="c.outdated && c.status !== 'resolved'" class="pill outdated" title="The commented lines changed since">outdated</span>
      <span class="loc">{{ rangeLabel(c) }}</span>
      <span class="cid" title="Comment id (used by lcr resolve)">#{{ c.id }}</span>
      <span class="spacer" />
      <button v-if="c.status === 'resolved' && !agentFixed" class="icon-btn" title="Collapse" @click="open = false"><Icon name="x" :size="14" /></button>
    </div>

    <pre v-if="(showSnippet || c.outdated) && c.snippet.length" class="snippet"><div v-for="(l, i) in c.snippet" :key="i"><span class="snum">{{ c.startLine + i }}</span>{{ l }}</div></pre>

    <div class="messages">
      <template v-for="(m, i) in c.thread" :key="i">
        <div v-if="!(mode === 'edit' && m === lastUser)" class="msg" :class="m.author">
          <div class="msg-meta">
            <span class="avatar" :class="m.author">{{ m.author === "user" ? "Y" : "C" }}</span>
            <span class="author">{{ m.author === "user" ? "@you" : "@claude" }}</span>
            <span class="time">{{ timeAgo(m.at) }}</span>
          </div>
          <div class="msg-body"><template v-for="(p, j) in parts(m.body)" :key="j"><code v-if="p.code">{{ p.t }}</code><template v-else>{{ p.t }}</template></template></div>
        </div>
      </template>
    </div>

    <Editor v-if="mode === 'edit'" :initial="lastUser?.body" submit-label="Save" :submit="saveEdit" @cancel="mode = 'view'" />
    <Editor
      v-else-if="mode === 'reply'"
      placeholder="Reply… (re-opens the comment so it goes out with the next submit)"
      submit-label="Reply"
      :submit="saveReply"
      @cancel="mode = 'view'"
    />
    <div v-else class="thread-actions">
      <button v-if="c.status === 'draft'" class="btn small" @click="mode = 'edit'"><Icon name="pencil" :size="13" />Edit</button>
      <button v-else class="btn small" @click="mode = 'reply'"><Icon name="reply" :size="13" />{{ c.status === "resolved" && !agentFixed ? "Reopen…" : "Reply" }}</button>
      <button v-if="c.status === 'pending' || agentFixed" class="btn small" :class="{ primary: agentFixed }" @click="setStatus('resolved')"><Icon name="check" :size="13" />Resolve</button>
      <button v-if="c.status === 'resolved' && !agentFixed" class="btn small" @click="setStatus('draft')"><Icon name="history" :size="13" />Reopen as draft</button>
      <span class="spacer" />
      <button class="btn small ghost danger" title="Delete comment" @click="del"><Icon name="trash" :size="13" />Delete</button>
    </div>
  </div>
</template>
