<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { DiffOptions, FileDiff, ReviewComment } from "../../src/types.ts";
import { api, usePersisted, useServer } from "./api.ts";
import Composer from "./components/Composer.vue";
import FileTree from "./components/FileTree.vue";
import FileView from "./components/FileView.vue";
import Icon from "./components/Icon.vue";
import SubmitDialog from "./components/SubmitDialog.vue";
import Thread from "./components/Thread.vue";
import { closedDirs, composer, fileDomId, notify, openComposer, timeAgo, toast, type TreeNode } from "./state.ts";

const { diff, store, connected } = useServer();
const view = usePersisted<"unified" | "split">("lcr.view", "unified");
const sidebarOpen = usePersisted("lcr.sidebarOpen", true);
const sidebarWidth = usePersisted("lcr.sidebarWidth", 320);
/** Manual collapse state; when absent a file is collapsed iff it's viewed. */
const overrides = ref<Record<string, boolean>>({});
const submitOpen = ref(false);
const helpOpen = ref(false);
const activePath = ref<string | null>(null);
const filter = ref("");
/** Files whose diff changed while the page was open. */
const updated = ref(new Set<string>());
const now = ref(Date.now());
const mainEl = ref<HTMLElement>();

let clock: ReturnType<typeof setInterval>;
onMounted(() => (clock = setInterval(() => (now.value = Date.now()), 5000)));
onUnmounted(() => clearInterval(clock));

// ---- live-update bookkeeping ----
let prevHashes: Map<string, string> | null = null;
watch(diff, (d) => {
  if (!d || !d.generatedAt) return;
  if (prevHashes) {
    const changed = d.files.filter((f) => prevHashes!.get(f.path) !== f.hash).map((f) => f.path);
    if (changed.length) {
      updated.value = new Set([...updated.value, ...changed]);
      const o = { ...overrides.value };
      changed.forEach((p) => delete o[p]);
      overrides.value = o;
    }
  }
  prevHashes = new Map(d.files.map((f) => [f.path, f.hash]));
});

// ---- derived state ----
const files = computed(() => diff.value?.files ?? []);
const viewedMap = computed(() => store.value?.viewed ?? {});
const isViewed = (f: FileDiff) => viewedMap.value[f.path] === f.hash;
const isCollapsed = (f: FileDiff) => overrides.value[f.path] ?? isViewed(f);
const visibleFiles = computed(() => {
  const q = filter.value.toLowerCase();
  return q ? files.value.filter((f) => f.path.toLowerCase().includes(q)) : files.value;
});

const comments = computed(() => store.value?.comments ?? []);
const byPath = computed(() => {
  const m = new Map<string, ReviewComment[]>();
  for (const c of comments.value) {
    if (!m.has(c.path)) m.set(c.path, []);
    m.get(c.path)!.push(c);
  }
  return m;
});
const needsAttention = (c: ReviewComment) => c.status !== "resolved" || c.resolvedBy === "agent";
const openCount = (path: string) => byPath.value.get(path)?.filter(needsAttention).length ?? 0;
const general = computed(() => byPath.value.get("") ?? []);
const orphans = computed(() => {
  const paths = new Set(files.value.map((f) => f.path));
  return [...byPath.value.entries()].filter(([p]) => p && !paths.has(p)).flatMap(([, cs]) => cs);
});
const count = (s: ReviewComment["status"]) => comments.value.filter((c) => c.status === s).length;
const drafts = computed(() => count("draft"));
const pending = computed(() => count("pending"));
const resolvedCount = computed(() => count("resolved"));
const toConfirm = computed(() => comments.value.filter((c) => c.status === "resolved" && c.resolvedBy === "agent").length);
const viewedCount = computed(() => files.value.filter(isViewed).length);
const totals = computed(() => ({
  add: files.value.reduce((a, f) => a + f.additions, 0),
  del: files.value.reduce((a, f) => a + f.deletions, 0),
}));
const liveLabel = computed(() => (now.value, diff.value ? timeAgo(diff.value.generatedAt) : ""));

const tree = computed<TreeNode>(() => {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of visibleFiles.value) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      const key = `${leaf ? "f" : "d"}:${part}`;
      if (!node.children.has(key)) node.children.set(key, { name: part, children: new Map() });
      node = node.children.get(key)!;
      if (leaf) node.file = f;
    });
  }
  // "src" > "ui" > "components" becomes "src/ui/components"
  const compress = (n: TreeNode): TreeNode => {
    for (const [k, c] of n.children) n.children.set(k, compress(c));
    if (!n.file && n.name && n.children.size === 1) {
      const only = [...n.children.values()][0]!;
      if (!only.file) return { name: `${n.name}/${only.name}`, children: only.children };
    }
    return n;
  };
  return compress(root);
});

// ---- sidebar ----
function allDirs(n: TreeNode, prefix = "", out: string[] = []) {
  for (const c of n.children.values()) {
    if (c.file) continue;
    const k = prefix ? `${prefix}/${c.name}` : c.name;
    out.push(k);
    allDirs(c, k, out);
  }
  return out;
}
const allClosed = computed(() => {
  const dirs = allDirs(tree.value);
  return dirs.length > 0 && dirs.every((d) => closedDirs.value.has(d));
});
const toggleAllDirs = () => (closedDirs.value = allClosed.value ? new Set() : new Set(allDirs(tree.value)));

function startResize(e: PointerEvent) {
  e.preventDefault();
  const x0 = e.clientX;
  const w0 = sidebarWidth.value;
  const move = (ev: PointerEvent) => (sidebarWidth.value = Math.max(200, Math.min(720, w0 + ev.clientX - x0)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("resizing");
  };
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- actions ----
function clearUpdated(path: string) {
  const s = new Set(updated.value);
  s.delete(path);
  updated.value = s;
}

async function toggleViewed(f: FileDiff): Promise<boolean> {
  const viewed = !isViewed(f);
  const o = { ...overrides.value };
  delete o[f.path];
  overrides.value = o;
  clearUpdated(f.path);
  await api("/api/viewed", "POST", { path: f.path, viewed }).catch((e) => notify(e.message, true));
  return viewed;
}

const setOptions = (o: Partial<DiffOptions>) => api("/api/options", "POST", o).catch((e) => notify(e.message, true));

function toggleExpand(f: FileDiff) {
  const cur = diff.value?.options.expanded ?? [];
  void setOptions({ expanded: cur.includes(f.path) ? cur.filter((p) => p !== f.path) : [...cur, f.path] });
}

function toggleCollapse(f: FileDiff) {
  overrides.value = { ...overrides.value, [f.path]: !isCollapsed(f) };
}

async function scrollToFile(path: string) {
  activePath.value = path;
  overrides.value = { ...overrides.value, [path]: false };
  await nextTick();
  document.getElementById(fileDomId(path))?.scrollIntoView({ block: "start" });
}

// Active file follows scroll position.
let raf = 0;
function onScroll() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    for (const s of document.querySelectorAll<HTMLElement>("section.file[id]")) {
      if (s.getBoundingClientRect().bottom > 90) {
        activePath.value = decodeURIComponent(s.id.slice(5));
        break;
      }
    }
  });
}

// ---- keyboard ----
const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  return ["TEXTAREA", "INPUT", "SELECT"].includes(t.tagName) || t.isContentEditable;
};

function jumpComment(dir: 1 | -1) {
  const els = [...document.querySelectorAll<HTMLElement>("[data-comment]")];
  if (!els.length) return;
  const y = 100;
  const target = dir === 1 ? (els.find((el) => el.getBoundingClientRect().top > y + 5) ?? els[0]) : ([...els].reverse().find((el) => el.getBoundingClientRect().top < y - 5) ?? els[els.length - 1]);
  target?.scrollIntoView({ block: "center" });
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isTyping(e)) {
    e.preventDefault();
    submitOpen.value = true;
    return;
  }
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || submitOpen.value) return;
  const list = visibleFiles.value;
  const idx = list.findIndex((f) => f.path === activePath.value);
  const cur = list[idx];
  const go = (d: number) => {
    const next = list[Math.max(0, Math.min(list.length - 1, (idx < 0 ? -1 : idx) + d))];
    if (next) void scrollToFile(next.path);
  };
  switch (e.key) {
    case "j": go(1); break;
    case "k": go(-1); break;
    case "v":
      if (cur)
        void toggleViewed(cur).then((nowViewed) => {
          const next = nowViewed && list.slice(idx + 1).find((f) => !isViewed(f));
          if (next) void scrollToFile(next.path);
        });
      break;
    case "x":
    case "o":
      if (cur) toggleCollapse(cur);
      break;
    case "n": jumpComment(1); break;
    case "p": jumpComment(-1); break;
    case "b": sidebarOpen.value = !sidebarOpen.value; break;
    case "u": view.value = view.value === "unified" ? "split" : "unified"; break;
    case "r": void api("/api/refresh", "POST"); break;
    case "s": submitOpen.value = true; break;
    case "/":
      e.preventDefault();
      document.querySelector<HTMLInputElement>(".filter")?.focus();
      break;
    case "?": helpOpen.value = !helpOpen.value; break;
    case "Escape": helpOpen.value = false; break;
    default: return;
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

const shortcuts = [
  ["j / k", "Next / previous file"],
  ["v", "Toggle viewed (and jump to next unviewed)"],
  ["x / o", "Collapse / expand file"],
  ["n / p", "Next / previous comment"],
  ["b", "Show / hide the file tree"],
  ["u", "Toggle unified / split"],
  ["/", "Filter files"],
  ["r", "Refresh diff"],
  ["s  or  ⌘↵", "Submit review"],
  ["click line number", "Comment on a line (drag or shift-click for a range)"],
  ["⌘↵ / Esc", "Save / cancel a comment"],
];

function onSubmitted(msg: string) {
  submitOpen.value = false;
  notify(msg);
}
</script>

<template>
  <div v-if="!diff || !store" class="loading"><Icon name="refresh" class="spin" />{{ connected ? "loading diff…" : "connecting to lcr…" }}</div>

  <div v-else class="app">
    <header class="topbar">
      <button class="icon-btn sidebar-btn" :class="{ on: sidebarOpen }" :title="`${sidebarOpen ? 'Hide' : 'Show'} file tree (b)`" @click="sidebarOpen = !sidebarOpen"><Icon name="sidebar" /></button>
      <div class="crumbs">
        <Icon name="repo" class="muted" />
        <span class="repo">{{ diff.repoName }}</span>
        <span class="sep">/</span>
        <span class="branch"><Icon name="branch" :size="14" />{{ diff.branch }}</span>
        <span class="label">{{ diff.label }}</span>
      </div>
      <div class="actions">
        <div class="seg" role="group" aria-label="Diff layout">
          <button :class="{ on: view === 'unified' }" title="Unified (u)" @click="view = 'unified'"><Icon name="unified" :size="14" />unified</button>
          <button :class="{ on: view === 'split' }" title="Split (u)" @click="view = 'split'"><Icon name="split" :size="14" />split</button>
        </div>
        <label class="select" title="Context lines around changes">
          <Icon name="unfold" :size="14" />
          <select :value="diff.options.context" @change="setOptions({ context: +($event.target as HTMLSelectElement).value })">
            <option v-for="n in [0, 3, 10, 25, 100]" :key="n" :value="n">{{ n }} lines</option>
          </select>
        </label>
        <button class="toggle" :class="{ on: diff.options.ignoreWhitespace }" title="Hide whitespace-only changes" @click="setOptions({ ignoreWhitespace: !diff.options.ignoreWhitespace })">
          <Icon name="pilcrow" :size="14" />hide whitespace
        </button>
      </div>
      <span class="spacer" />
      <div class="viewed-progress" :class="{ done: files.length > 0 && viewedCount === files.length }" :title="`${files.length - viewedCount} file${files.length - viewedCount === 1 ? '' : 's'} left to review`">
        <span>{{ viewedCount }} / {{ files.length }} files viewed</span>
        <div class="bar"><div :style="{ width: files.length ? `${(viewedCount / files.length) * 100}%` : '0' }" /></div>
      </div>
      <button class="btn primary submit" :disabled="!drafts" title="Submit review (s)" @click="submitOpen = true">
        <Icon name="send" :size="14" />Submit review<span v-if="drafts" class="count">{{ drafts }}</span>
      </button>
    </header>

    <div class="layout">
      <aside v-if="sidebarOpen" class="sidebar" :style="{ width: `${sidebarWidth}px` }">
        <div class="side-title">
          <span>changes</span>
          <span class="side-stats"><span class="add">+{{ totals.add }}</span> <span class="del">−{{ totals.del }}</span></span>
          <span class="spacer" />
          <button class="icon-btn" :title="allClosed ? 'Expand all folders' : 'Collapse all folders'" @click="toggleAllDirs"><Icon :name="allClosed ? 'unfold' : 'fold'" :size="14" /></button>
          <button class="icon-btn" title="Hide file tree (b)" @click="sidebarOpen = false"><Icon name="sidebar" :size="14" /></button>
        </div>
        <label class="filter">
          <Icon name="search" :size="14" />
          <input v-model="filter" placeholder="filter files" @keydown.esc="($event.target as HTMLElement).blur()" />
          <kbd>/</kbd>
        </label>
        <div class="tree">
          <FileTree
            :node="tree"
            :depth="0"
            :active-path="activePath"
            :is-viewed="isViewed"
            :updated="updated"
            :open-count="openCount"
            @select="scrollToFile"
            @toggle-viewed="toggleViewed"
          />
        </div>
        <div v-if="resolvedCount" class="sidebar-foot">
          <button class="btn ghost small" @click="api('/api/clear-resolved', 'POST')"><Icon name="trash" :size="13" />delete {{ resolvedCount }} resolved</button>
        </div>
      </aside>
      <div v-if="sidebarOpen" class="resizer" title="Drag to resize" @pointerdown="startResize" @dblclick="sidebarWidth = 320" />

      <main ref="mainEl" @scroll.passive="onScroll">
        <div v-if="diff.error" class="banner error">{{ diff.error }}</div>

        <div class="general">
          <Thread v-for="c in general" :key="c.id" :c="c" />
          <Composer v-if="composer?.path === ''" path="" side="new" :start="0" :end="0" />
          <button v-else class="btn ghost small" @click="openComposer({ path: '', side: 'new', start: 0, end: 0 })"><Icon name="comment-add" :size="14" />General comment</button>
        </div>

        <div v-if="!files.length && !diff.error" class="empty-state">
          <Icon name="check-circle" :size="28" />
          <div>No changes. Edit some files and they'll show up here.</div>
        </div>

        <FileView
          v-for="f in visibleFiles"
          :key="f.path"
          :file="f"
          :comments="byPath.get(f.path) ?? []"
          :viewed="isViewed(f)"
          :changed-since-viewed="!!viewedMap[f.path] && viewedMap[f.path] !== f.hash"
          :updated="updated.has(f.path)"
          :collapsed="isCollapsed(f)"
          :active="f.path === activePath"
          :view="view"
          @toggle-collapse="toggleCollapse(f)"
          @toggle-viewed="toggleViewed(f)"
          @toggle-expand="toggleExpand(f)"
        />

        <section v-if="orphans.length" class="file orphans">
          <header class="file-head"><Icon name="history" /><span class="path">comments on files no longer in the diff</span></header>
          <div class="file-comments">
            <div v-for="c in orphans" :key="c.id">
              <div class="orphan-path">{{ c.path }}</div>
              <Thread :c="c" show-snippet />
            </div>
          </div>
        </section>
        <div class="bottom-pad" />
      </main>
    </div>

    <footer class="statusbar">
      <span class="spacer" />
      <span class="sb-item" :class="connected ? 'live' : 'offline'" :title="connected ? 'Watching for file changes' : 'Disconnected: is lcr still running?'">
        <span class="pulse" />{{ connected ? `live · ${liveLabel}` : "offline" }}
      </span>
      <span class="sb-item"><Icon name="branch" :size="13" />{{ diff.branch }}</span>
      <span class="sb-item"><Icon name="file" :size="13" />{{ files.length }} files</span>
      <span class="sb-item"><Icon name="eye" :size="13" />{{ viewedCount }}/{{ files.length }} viewed</span>
      <span v-if="drafts" class="sb-item"><Icon name="pencil" :size="13" />{{ drafts }} draft{{ drafts === 1 ? "" : "s" }}</span>
      <span v-if="toConfirm" class="sb-item"><Icon name="check" :size="13" />{{ toConfirm }} fixed, to confirm</span>
      <span v-if="pending" class="sb-item"><Icon name="send" :size="13" />{{ pending }} awaiting claude</span>
      <button class="sb-item sb-btn" title="Refresh (r)" @click="api('/api/refresh', 'POST')"><Icon name="refresh" :size="13" /></button>
      <button class="sb-item sb-btn" @click="helpOpen = true"><Icon name="keyboard" :size="13" />shortcuts <kbd>?</kbd></button>
    </footer>

    <SubmitDialog v-if="submitOpen" :draft-count="drafts" @close="submitOpen = false" @done="onSubmitted" />

    <div v-if="helpOpen" class="modal-backdrop" @mousedown.self="helpOpen = false">
      <div class="modal help">
        <div class="modal-head"><Icon name="keyboard" /><h2>Keyboard shortcuts</h2><span class="spacer" /><button class="icon-btn" @click="helpOpen = false"><Icon name="x" /></button></div>
        <table>
          <tbody>
            <tr v-for="[k, d] in shortcuts" :key="k">
              <td><kbd>{{ k }}</kbd></td>
              <td>{{ d }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="toast" class="toast" :class="{ error: toast.error }"><Icon :name="toast.error ? 'x' : 'check'" :size="14" />{{ toast.msg }}</div>
  </div>
</template>
