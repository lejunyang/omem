<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post, put } from "../api";
import { promptDialog } from "../lib/dialog";
import { state, toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
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
  /** A knowledge base Feishu will not name (not a member): titled by a page in it, the owner can name it. */
  unnamed?: boolean;
  /** A knowledge-base directory filed under a space of its own. */
  home?: string;
  /** A repository folder (kind "repo") and the “仓库” folder holding them (kind "repos"). */
  repo?: { id: string; name: string; rootPath?: string | null };
  repoCount?: number;
};

/**
 * A business space's repositories (spaces of their own underneath) are folders of this tree: each
 * is a top-level folder with its directory tree below (more than REPO_GROUP_AT go into one “仓库”
 * folder). Their nodes carry the repository in the key — `@<space>@<node>` — and load from that space.
 */
type Repo = { id: string; name: string; rootPath?: string | null };
const props = defineProps<{ space: string; repos?: Repo[]; kind?: string; level?: string; q?: string; current?: string }>();
const emit = defineEmits<{ total: [n: number]; "open-space": [space: string] }>();
const REPO_GROUP_AT = 6;
const REPOS = "@repos";
/** Which space a tree key belongs to and its key there. */
function locate(key: string) {
  const m = /^@([^@]+)@(.*)$/s.exec(key);
  return m ? { space: m[1], node: m[2], prefix: `@${m[1]}@` } : { space: props.space, node: key, prefix: "" };
}
const filtering = computed(() => !!(props.kind || props.level || props.q));
/** Each repository's top level, as loaded (total and levels under the filter). */
const repoTotals = ref(new Map<string, { total: number; levels: Record<Level, number> }>());
const repoEntries = computed<TreeEntry[]>(() =>
  [...(props.repos ?? [])].sort((a, b) => a.name.localeCompare(b.name, "zh")).flatMap((r) => {
    const t = repoTotals.value.get(r.id);
    if (filtering.value && !t?.total) return [];
    return [{ key: `@${r.id}@`, title: r.name, kind: "repo", count: t?.total ?? 0, levels: t?.levels ?? { focus: 0, normal: 0, reference: 0, ignore: 0 }, notes: 0, hasChildren: !!t?.total, repo: r }];
  }),
);
function childrenOf(key: string): TreeEntry[] {
  if (key === REPOS) return repoEntries.value;
  const own = children.value.get(key) ?? [];
  if (key !== "") return own;
  const repos = repoEntries.value;
  if (repos.length < REPO_GROUP_AT) return [...own, ...repos];
  const levels = { focus: 0, normal: 0, reference: 0, ignore: 0 };
  for (const r of repos) for (const l of Object.keys(levels) as Level[]) levels[l] += r.levels[l];
  return [...own, { key: REPOS, title: "仓库", kind: "repos", count: repos.reduce((a, r) => a + r.count, 0), levels, notes: 0, hasChildren: true, repoCount: repos.length }];
}

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
/** Loads a folder's children; returns the total under the filter at the top of a space (or null). */
async function load(key: string, s = seq): Promise<number | null> {
  if (key === REPOS) return null;
  const at = locate(key);
  const p = new URLSearchParams({ space: at.space, node: at.node });
  if (props.kind) p.set("kind", props.kind);
  if (props.level) p.set("level", props.level);
  if (props.q) p.set("q", props.q);
  loading.value = new Set(loading.value).add(key);
  try {
    const r = await get<{ nodes: TreeEntry[]; total: number }>(`/api/sources/tree?${p}`);
    if (s !== seq) return null;
    const next = new Map(children.value);
    next.set(key, at.prefix ? r.nodes.map((n) => ({ ...n, key: at.prefix + n.key })) : r.nodes);
    children.value = next;
    if (at.prefix && !at.node) {
      const levels = { focus: 0, normal: 0, reference: 0, ignore: 0 };
      for (const n of r.nodes) for (const l of Object.keys(levels) as Level[]) levels[l] += n.levels[l];
      repoTotals.value = new Map(repoTotals.value).set(at.space, { total: r.total, levels });
    }
    return key === "" || (at.prefix && !at.node) ? r.total : null;
  } catch (e) {
    toast((e as Error).message, "error");
    return null;
  } finally {
    const l = new Set(loading.value);
    l.delete(key);
    loading.value = l;
  }
}
/** Reload the top (the space's own and each repository's) and every open folder (after a filter or a level changed). */
async function reload() {
  const s = ++seq;
  rootLoading.value = !children.value.size;
  // Repository tops are loaded below; a folder of a repository no longer under this space is skipped.
  const repoIds = new Set((props.repos ?? []).map((r) => r.id));
  const keep = [...expanded.value].filter((k) => {
    if (k === REPOS) return false;
    const at = locate(k);
    return !at.prefix || (!!at.node && repoIds.has(at.space));
  });
  const totals = await Promise.all(["", ...(props.repos ?? []).map((r) => `@${r.id}@`)].map((k) => load(k, s)));
  if (s !== seq) return;
  rootLoading.value = false;
  emit("total", totals.reduce<number>((a, n) => a + (n ?? 0), 0));
  await Promise.all(keep.map((k) => load(k, s)));
}
watch(() => [props.space, props.kind, props.level, props.q, (props.repos ?? []).map((r) => r.id).join(",")] as const, (now, prev) => {
  if (now[0] !== prev?.[0] || now[4] !== prev?.[4]) {
    expanded.value = readExpanded();
    children.value = new Map();
    repoTotals.value = new Map();
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
    for (const e of childrenOf(key)) {
      out.push({ type: "node", entry: e, depth });
      if (menuFor.value === e.key) out.push({ type: "menu", entry: e, depth });
      if (e.hasChildren && expanded.value.has(e.key)) {
        if (e.key === REPOS || children.value.has(e.key)) walk(e.key, depth + 1);
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
    const at = locate(e.key);
    if (e.kind === "source" && e.sourceId) await put(`/api/sources/${e.sourceId}/attention`, { level: level === "normal" ? null : level });
    else await put("/api/sources/node-level", { space: at.space, node: at.node, level });
    menuFor.value = null;
    toast(e.kind === "source" ? "已设置" : `已设置「${e.title}」及其下面的原件`, "ok");
    await reload();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}
async function nameSpace(e: TreeEntry) {
  const name = (await promptDialog("给这个知识库起个名字", { message: "你不是这个知识库的成员，飞书不给它的名字；这里先按里面的页面起了一个。加入知识库后飞书给的名字会替换它。", placeholder: "知识库名称", okText: "保存" }))?.trim();
  if (!name) return;
  try {
    await put("/api/sources/wiki-space-name", { id: e.key.slice("wiki:".length), name });
    menuFor.value = null;
    toast("已命名", "ok");
    await reload();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}
// A knowledge-base directory that belongs to another business: it and what is below go to that space.
const FOLLOW = "";
const homeOptions = computed(() => [{ value: FOLLOW, label: "跟随知识库" }, ...state.spaces.filter((s) => !["personal", "repo", "worktree"].includes(s.kind)).map((s) => ({ value: s.id, label: s.name }))]);
async function setHome(e: TreeEntry, space: string) {
  try {
    const r = await put<{ moved: { moved: number; merged: number } | null }>("/api/lark/kb-home/dir", { token: e.key.slice("wn:".length), space: space || null });
    menuFor.value = null;
    const n = (r.moved?.moved ?? 0) + (r.moved?.merged ?? 0);
    toast(space ? `「${e.title}」下的文档以后放到那个空间${n ? `，已移过去 ${n} 篇` : ""}` : `「${e.title}」跟随知识库${n ? `，已移回 ${n} 篇` : ""}`, "ok");
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
const nodeIcon = (e: TreeEntry) => (e.sourceId && !e.hasChildren ? (kindIcon[e.sourceKind ?? ""] ?? "file") : e.kind === "chat" || e.kind === "chat-type" ? "chat" : e.kind === "site" ? "link" : e.kind === "wiki-space" ? "book" : e.kind === "repo" || e.kind === "repos" ? "code" : "folder");
/** What a row's title says on hover: a repository's directory on disk. */
const rowTitle = (e: TreeEntry) => (e.repo ? `${e.title}${e.repo.rootPath ? ` · ${e.repo.rootPath}` : ""}` : e.kind === "repos" ? `这个空间的 ${e.repoCount} 个仓库` : e.title);
/** Rows with a menu: levels for folders and sources; a repository's own (open it alone). The “仓库” folder has none. */
const hasMenu = (e: TreeEntry) => !e.uncaptured && e.kind !== "repos";
defineExpose({ reload });
</script>

<template>
  <Skeleton v-if="rootLoading && !children.size" :rows="8" />
  <div v-else-if="!childrenOf('').length" class="empty small">
    <p>{{ q || kind || level ? "没有符合筛选的原件。" : "这个空间还没有原件。" }}</p>
  </div>
  <VirtualList v-else :items="rows" :item-key="rowKey" :estimate="30">
    <template #default="{ item: r }">
      <div v-if="r.type === 'loading'" class="tree-row muted small" :style="{ paddingLeft: 28 + r.depth * 14 + 'px' }">加载中…</div>
      <div v-else-if="r.type === 'menu' && r.entry.repo" class="tree-menu small" :style="{ paddingLeft: 28 + r.depth * 14 + 'px' }">
        <span class="muted path" :title="r.entry.repo.rootPath ?? ''">{{ r.entry.repo.rootPath || "仓库空间" }}</span>
        <button class="btn ghost sm" type="button" title="切到这个仓库空间：同步目录、看它自己的原件" @click="menuFor = null; emit('open-space', r.entry.repo.id)"><Icon name="right" :size="13" />单独打开</button>
        <button class="btn ghost sm icon" type="button" title="收起" aria-label="收起" @click="menuFor = null"><Icon name="x" :size="13" /></button>
      </div>
      <div v-else-if="r.type === 'menu'" class="tree-menu small" :style="{ paddingLeft: 28 + r.depth * 14 + 'px' }">
        <span class="muted">{{ r.entry.kind === "source" ? "这份原件" : "这个目录和以后进来的" }}</span>
        <UiSegmented :model-value="ownLevel(r.entry)" size="sm" aria-label="关注程度" :options="levelOptions" @change="(v) => setLevel(r.entry, v)" />
        <button v-if="r.entry.level && !r.entry.level.inherited" class="btn ghost sm" type="button" @click="setLevel(r.entry, null)">清除</button>
        <button v-if="r.entry.kind === 'wiki-space' && r.entry.unnamed" class="btn ghost sm" type="button" @click="nameSpace(r.entry)">命名</button>
        <template v-if="r.entry.kind === 'wiki-node' && r.entry.hasChildren">
          <span class="muted" title="知识库的文档默认都放在知识库归入的空间；个别目录属于别的业务时，在这里单独指定">放在</span>
          <UiSelect :model-value="r.entry.home ?? FOLLOW" size="sm" width="150px" aria-label="这个目录放在哪个空间" :options="homeOptions" @change="(v) => setHome(r.entry, String(v))" />
        </template>
        <button class="btn ghost sm icon" type="button" title="收起" @click="menuFor = null"><Icon name="x" :size="13" /></button>
      </div>
      <div v-else class="tree-row" :class="{ on: r.entry.sourceId && r.entry.sourceId === current, grey: r.entry.uncaptured }" :style="{ paddingLeft: 6 + r.depth * 14 + 'px' }">
        <button v-if="r.entry.hasChildren" class="twisty" type="button" :aria-expanded="expanded.has(r.entry.key)" :aria-label="expanded.has(r.entry.key) ? '收起' : '展开'" @click="toggle(r.entry)">
          <Icon :name="expanded.has(r.entry.key) ? 'down' : 'right'" :size="12" />
        </button>
        <span v-else class="twisty-pad" />
        <Icon :name="nodeIcon(r.entry)" :size="14" class="ico" />
        <router-link v-if="r.entry.sourceId" :to="`/sources/${r.entry.sourceId}`" class="name ellipsis" :title="r.entry.title">{{ r.entry.title }}</router-link>
        <button v-else-if="!r.entry.uncaptured" class="name ellipsis plain" type="button" :title="rowTitle(r.entry)" @click="r.entry.hasChildren && toggle(r.entry)">{{ r.entry.title }}</button>
        <span v-else class="name ellipsis" :title="`${r.entry.title}（未采集）`">{{ r.entry.title }}</span>
        <span v-if="r.entry.level" class="lv" :class="[r.entry.level.level, { inherited: r.entry.level.inherited }]" :title="levelNote(r.entry)">{{ LEVEL_LABEL[r.entry.level.level] }}</span>
        <span class="dots" :title="dotsOf(r.entry).map((d) => `${LEVEL_LABEL[d.level]} ${d.n}`).join('，')">
          <i v-for="d in dotsOf(r.entry)" :key="d.level" :class="['dot', d.level]" />
        </span>
        <button v-if="r.entry.uncaptured && r.entry.url" class="btn ghost sm" type="button" :disabled="capturing.has(r.entry.key)" @click="capture(r.entry)">{{ capturing.has(r.entry.key) ? "采集中" : "采集" }}</button>
        <span v-else-if="!r.entry.sourceId || r.entry.hasChildren" class="muted small count">{{ r.entry.count }}</span>
        <button v-if="hasMenu(r.entry)" class="btn ghost sm icon more" type="button" :aria-expanded="menuFor === r.entry.key" :title="r.entry.repo ? '仓库' : r.entry.kind === 'source' ? '关注程度' : '设关注程度（含子树）'" :aria-label="r.entry.repo ? '仓库' : '关注程度'" @click="menuFor = menuFor === r.entry.key ? null : r.entry.key">
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
.tree-menu .path {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
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
