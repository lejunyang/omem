<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post, put } from "../api";
import { toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import VirtualList from "./VirtualList.vue";

/**
 * The catalog of a space (src/sources/catalog.ts), one level at a time: knowledge bases and their
 * nodes, Feishu docs by the doc that linked them, chats by type and month, sites, meetings by month.
 * Counts and level dots follow the filters. A level set on a folder holds for everything below it,
 * including what arrives later. Knowledge-base nodes nobody captured are greyed out; capture on click.
 */
type Level = "focus" | "normal" | "reference" | "ignore";
export type TreeEntry = {
  key: string;
  title: string;
  kind: string;
  sourceId?: string;
  sourceKind?: string;
  count: number;
  levels: Record<Level, number>;
  notes: number;
  hasChildren: boolean;
  level?: { level: Level; by: string | null; status?: string; inherited?: boolean };
  uncaptured?: boolean;
  url?: string;
};

const props = defineProps<{ space: string; kind?: string; level?: string; q?: string; current?: string }>();
const emit = defineEmits<{ total: [n: number] }>();

const children = ref(new Map<string, TreeEntry[]>());
const loading = ref(new Set<string>());
const rootLoading = ref(true);
const storeKey = computed(() => `omem.sourceTree.${props.space}`);
function readExpanded() {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(storeKey.value) ?? "[]"));
  } catch {
    return new Set<string>();
  }
}
const expanded = ref(readExpanded());
function saveExpanded() {
  try {
    localStorage.setItem(storeKey.value, JSON.stringify([...expanded.value].slice(-300)));
  } catch {}
}

let seq = 0;
async function load(key: string, s = seq) {
  const p = new URLSearchParams({ space: props.space, node: key });
  if (props.kind) p.set("kind", props.kind);
  if (props.level) p.set("level", props.level);
  if (props.q) p.set("q", props.q);
  loading.value = new Set(loading.value).add(key);
  try {
    const r = await get<{ nodes: TreeEntry[]; total: number }>(`/api/sources/tree?${p}`);
    if (s !== seq) return;
    const next = new Map(children.value);
    next.set(key, r.nodes);
    children.value = next;
    if (key === "") emit("total", r.total);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    const l = new Set(loading.value);
    l.delete(key);
    loading.value = l;
  }
}
/** Reload the top and every open folder (after a filter or a level changed). */
async function reload() {
  const s = ++seq;
  rootLoading.value = !children.value.size;
  const keep = [...expanded.value];
  await load("", s);
  rootLoading.value = false;
  await Promise.all(keep.map((k) => load(k, s)));
}
watch(() => [props.space, props.kind, props.level, props.q] as const, (now, prev) => {
  if (now[0] !== prev?.[0]) {
    expanded.value = readExpanded();
    children.value = new Map();
  }
  void reload();
}, { immediate: true });

function toggle(e: TreeEntry) {
  const next = new Set(expanded.value);
  if (next.has(e.key)) next.delete(e.key);
  else {
    next.add(e.key);
    if (!children.value.has(e.key)) void load(e.key);
  }
  expanded.value = next;
  saveExpanded();
}

type Row = { type: "node"; entry: TreeEntry; depth: number } | { type: "loading"; key: string; depth: number } | { type: "menu"; entry: TreeEntry; depth: number };
const menuFor = ref<string | null>(null);
const rows = computed(() => {
  const out: Row[] = [];
  const walk = (key: string, depth: number) => {
    for (const e of children.value.get(key) ?? []) {
      out.push({ type: "node", entry: e, depth });
      if (menuFor.value === e.key) out.push({ type: "menu", entry: e, depth });
      if (e.hasChildren && expanded.value.has(e.key)) {
        if (children.value.has(e.key)) walk(e.key, depth + 1);
        else out.push({ type: "loading", key: e.key, depth: depth + 1 });
      }
    }
  };
  walk("", 0);
  return out;
});
const rowKey = (r: Row) => (r.type === "node" ? r.entry.key : `${r.type}:${r.type === "loading" ? r.key : r.entry.key}`);

const LEVEL_LABEL: Record<Level, string> = { focus: "重点", normal: "一般", reference: "仅检索", ignore: "忽略" };
const levelOptions = (["focus", "normal", "reference", "ignore"] as Level[]).map((v) => ({ value: v, label: LEVEL_LABEL[v] }));
const ownLevel = (e: TreeEntry): Level => (e.level && !e.level.inherited ? e.level.level : "normal");
function dotsOf(e: TreeEntry) {
  return (["focus", "reference", "ignore"] as Level[]).filter((l) => e.levels[l]).map((l) => ({ level: l, n: e.levels[l] }));
}
function levelNote(e: TreeEntry) {
  const l = e.level;
  if (!l) return "";
  const who = l.by === "owner" ? "你定的" : l.by === "agent" ? "Agent 定的" : l.by === "rule" ? "规则定的" : "";
  return `${LEVEL_LABEL[l.level]}${l.inherited ? "（随上级目录）" : ""}${who ? ` · ${who}` : ""}${l.status === "rejected" ? " · 已否定" : l.by === "agent" && l.status === "active" ? " · 待复核" : ""}`;
}

async function setLevel(e: TreeEntry, level: Level | null) {
  try {
    if (e.kind === "source" && e.sourceId) await put(`/api/sources/${e.sourceId}/attention`, { level: level === "normal" ? null : level });
    else await put("/api/sources/node-level", { space: props.space, node: e.key, level });
    menuFor.value = null;
    toast(e.kind === "source" ? "已设置" : `已设置「${e.title}」及其下面的原件`, "ok");
    await reload();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}
const capturing = ref(new Set<string>());
async function capture(e: TreeEntry) {
  if (!e.url) return;
  capturing.value = new Set(capturing.value).add(e.key);
  try {
    await post("/api/sources/url", { space: props.space, url: e.url });
    toast(`已采集《${e.title}》，交给整理`, "ok");
    await reload();
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    const c = new Set(capturing.value);
    c.delete(e.key);
    capturing.value = c;
  }
}
const kindIcon: Record<string, string> = { code: "code", doc: "file", chat: "chat", note: "edit", web: "link", image: "eye", conversation: "chat", work: "layers", meeting: "clock", event: "clock" };
const nodeIcon = (e: TreeEntry) => (e.sourceId && !e.hasChildren ? (kindIcon[e.sourceKind ?? ""] ?? "file") : e.kind === "chat" || e.kind === "chat-type" ? "chat" : e.kind === "site" ? "link" : e.kind === "wiki-space" ? "book" : "folder");
defineExpose({ reload });
</script>

<template>
  <Skeleton v-if="rootLoading && !children.size" :rows="8" />
  <div v-else-if="!(children.get('') ?? []).length" class="empty small">
    <p>{{ q || kind || level ? "没有符合筛选的原件。" : "这个空间还没有原件。" }}</p>
  </div>
  <VirtualList v-else :items="rows" :item-key="rowKey" :estimate="30">
    <template #default="{ item: r }">
      <div v-if="r.type === 'loading'" class="tree-row muted small" :style="{ paddingLeft: 28 + r.depth * 14 + 'px' }">加载中…</div>
      <div v-else-if="r.type === 'menu'" class="tree-menu small" :style="{ paddingLeft: 28 + r.depth * 14 + 'px' }">
        <span class="muted">{{ r.entry.kind === "source" ? "这份原件" : "这个目录和以后进来的" }}</span>
        <UiSegmented :model-value="ownLevel(r.entry)" size="sm" aria-label="关注程度" :options="levelOptions" @change="(v) => setLevel(r.entry, v)" />
        <button v-if="r.entry.level && !r.entry.level.inherited" class="btn ghost sm" type="button" @click="setLevel(r.entry, null)">清除</button>
        <button class="btn ghost sm icon" type="button" title="收起" @click="menuFor = null"><Icon name="x" :size="13" /></button>
      </div>
      <div v-else class="tree-row" :class="{ on: r.entry.sourceId && r.entry.sourceId === current, grey: r.entry.uncaptured }" :style="{ paddingLeft: 6 + r.depth * 14 + 'px' }">
        <button v-if="r.entry.hasChildren" class="twisty" type="button" :aria-expanded="expanded.has(r.entry.key)" :aria-label="expanded.has(r.entry.key) ? '收起' : '展开'" @click="toggle(r.entry)">
          <Icon :name="expanded.has(r.entry.key) ? 'down' : 'right'" :size="12" />
        </button>
        <span v-else class="twisty-pad" />
        <Icon :name="nodeIcon(r.entry)" :size="14" class="ico" />
        <router-link v-if="r.entry.sourceId" :to="`/sources/${r.entry.sourceId}`" class="name ellipsis" :title="r.entry.title">{{ r.entry.title }}</router-link>
        <button v-else-if="!r.entry.uncaptured" class="name ellipsis plain" type="button" :title="r.entry.title" @click="r.entry.hasChildren && toggle(r.entry)">{{ r.entry.title }}</button>
        <span v-else class="name ellipsis" :title="`${r.entry.title}（未采集）`">{{ r.entry.title }}</span>
        <span v-if="r.entry.level" class="lv" :class="[r.entry.level.level, { inherited: r.entry.level.inherited }]" :title="levelNote(r.entry)">{{ LEVEL_LABEL[r.entry.level.level] }}</span>
        <span class="dots" :title="dotsOf(r.entry).map((d) => `${LEVEL_LABEL[d.level]} ${d.n}`).join('，')">
          <i v-for="d in dotsOf(r.entry)" :key="d.level" :class="['dot', d.level]" />
        </span>
        <button v-if="r.entry.uncaptured && r.entry.url" class="btn ghost sm" type="button" :disabled="capturing.has(r.entry.key)" @click="capture(r.entry)">{{ capturing.has(r.entry.key) ? "采集中" : "采集" }}</button>
        <span v-else-if="!r.entry.sourceId || r.entry.hasChildren" class="muted small count">{{ r.entry.count }}</span>
        <button v-if="!r.entry.uncaptured" class="btn ghost sm icon more" type="button" :aria-expanded="menuFor === r.entry.key" :title="r.entry.kind === 'source' ? '关注程度' : '设关注程度（含子树）'" @click="menuFor = menuFor === r.entry.key ? null : r.entry.key">
          <Icon name="menu" :size="13" />
        </button>
      </div>
    </template>
  </VirtualList>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 4px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--ink-2);
}
.tree-row:hover {
  background: var(--hover);
}
.tree-row.on {
  background: var(--accent-soft);
}
.tree-row.on .name {
  color: var(--accent);
}
.tree-row.grey .name,
.tree-row.grey .ico {
  color: var(--muted);
  opacity: 0.7;
}
.twisty,
.twisty-pad {
  width: 18px;
  height: 18px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.twisty {
  border: 0;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--muted);
  border-radius: 4px;
}
.ico {
  flex: none;
  color: var(--muted);
}
.name {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ink);
  text-decoration: none;
}
.name.plain {
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.count {
  flex: none;
}
.lv {
  flex: none;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--ink-2);
}
.lv.focus {
  color: var(--accent);
  border-color: var(--accent);
}
.lv.reference {
  color: var(--warn);
}
.lv.ignore {
  color: var(--muted);
  text-decoration: line-through;
}
.lv.inherited {
  border-style: dashed;
}
.dots {
  display: inline-flex;
  gap: 2px;
  flex: none;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line-strong);
}
.dot.focus {
  background: var(--accent);
}
.dot.reference {
  background: var(--warn);
}
.dot.ignore {
  background: var(--muted);
}
.more {
  flex: none;
  opacity: 0.55;
}
.more:hover,
.more[aria-expanded="true"] {
  opacity: 1;
}
.tree-menu {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 8px;
  min-width: 0;
}
</style>
