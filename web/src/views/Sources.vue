<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, post, type Source } from "../api";
import ChatView from "../components/ChatView.vue";
import CodeView from "../components/CodeView.vue";
import Skeleton from "../components/Skeleton.vue";
import VirtualList from "../components/VirtualList.vue";
import UiSelect from "../components/UiSelect.vue";
import Icon from "../components/Icon.vue";
import { confirmDialog, promptDialog } from "../lib/dialog";
import Markdown from "../components/Markdown.vue";
import { currentSpace, fmtTime, relTime, state, toast } from "../store";

type Detail = {
  source: Source & { lines: number; hash: string };
  lineStart: number;
  lineEnd: number;
  text: string;
  outline: { symbols: { name: string; qname: string; kind: string; line_start: number; line_end: number; exported: number }[]; sections: { title: string; path: string; line_start: number; line_end: number; kind: string }[] };
  citedBy: { page_id: string; title: string }[];
};

const route = useRoute();
const router = useRouter();
const list = ref<Source[]>([]);
const total = ref(0);
const PAGE = 1000;
const loadingMore = ref(false);
const q = ref("");
const kind = ref("");
const detail = ref<Detail | null>(null);
const raw = ref(false);
const archive = ref<{ route?: { reason: string } | null; history: { from_space: string; to_space: string; reason: string; at: string }[] } | null>(null);
const moveTarget = ref("");
const moveReason = ref("");
const moving = ref(false);
async function moveOriginal() {
  const s = detail.value?.source;
  if (!s || !moveTarget.value || !moveReason.value.trim()) return toast("选择目标空间并写明依据", "error");
  if (!(await confirmDialog("确认这份材料的空间归属？", { message: "保留原件 ID 和引用，后续自动归档不会覆盖本次手动指定。", okText: "确认归属" }))) return;
  moving.value = true;
  try {
    await post(`/api/sources/${s.id}/move`, { space: moveTarget.value, hash: s.hash, reason: moveReason.value });
    await Promise.all([load(), loadDetail()]);
    toast("已更新原件归属", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { moving.value = false; }
}
const collapsed = ref(new Set<string>());
/** Folders start collapsed; once the user expands one, keep it expanded across loads. */
const expandedOnce = ref(new Set<string>());
const listLoading = ref(true);
const detailLoading = ref(false);
const space = computed(() => currentSpace());
const id = computed(() => route.params.id as string | undefined);
const hl = computed(() => (route.query.from ? { from: Number(route.query.from), to: Number(route.query.to ?? route.query.from) } : null));

let loadSeq = 0;
const itemsEl = ref<HTMLElement | null>(null);
async function load() {
  const seq = ++loadSeq;
  listLoading.value = true;
  try {
    // A repository is shown as a tree: it needs every path at once (a page of a collapsed tree
    // has wrong folder counts and nothing to scroll). The path list is light, no line counts.
    if (space.value?.kind === "repo") {
      const p = new URLSearchParams({ space: state.space });
      if (q.value) p.set("q", q.value);
      if (kind.value) p.set("kind", kind.value);
      const paths = await get<Source[]>(`/api/sources/paths?${p}`);
      if (seq !== loadSeq) return;
      list.value = paths;
      total.value = paths.length;
      return;
    }
    const r = await loadPage(0);
    if (seq !== loadSeq) return;
    list.value = r.sources;
    total.value = r.total;
  } finally {
    if (seq === loadSeq) listLoading.value = false;
  }
  void fillScreen();
}
/** Keep loading while the list does not fill its column: there is nothing to scroll yet. */
async function fillScreen() {
  await nextTick();
  const el = itemsEl.value;
  if (el && list.value.length < total.value && el.scrollHeight - el.clientHeight < 500) {
    await loadMore();
    void fillScreen();
  }
}
async function loadPage(offset: number) {
  const p = new URLSearchParams({ space: state.space, limit: String(PAGE), offset: String(offset) });
  if (q.value) p.set("q", q.value);
  if (kind.value) p.set("kind", kind.value);
  return get<{ total: number; sources: Source[] }>(`/api/sources?${p}`);
}
async function loadMore() {
  if (loadingMore.value || list.value.length >= total.value) return;
  loadingMore.value = true;
  try {
    const r = await loadPage(list.value.length);
    list.value.push(...r.sources);
    total.value = r.total;
  } finally {
    loadingMore.value = false;
  }
}
function onListScroll(ev: Event) {
  const el = ev.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 500) void loadMore();
}
async function loadDetail() {
  if (!id.value) return void (detail.value = null);
  detailLoading.value = true;
  try {
    const d = await get<Detail>(`/api/sources/${id.value}?from=1&to=1000000`);
    if (d.source.id !== id.value) return;
    detail.value = d;
    moveTarget.value = d.source.spaceId;
    archive.value = await get(`/api/sources/${d.source.id}/archive`);
    moveReason.value = "";
    // Chats open as a chat even from a citation; the highlighted message is scrolled to.
    raw.value = d.source.kind === "code" || (!!hl.value && d.source.kind !== "chat");
  } finally {
    detailLoading.value = false;
  }
}
let qTimer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  void load();
  void loadDetail();
});
watch(kind, load);
watch(q, () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(load, 200);
});
watch(id, loadDetail);

/** Directory tree for repo-like spaces; flat list otherwise. */
const tree = computed(() => {
  type Node = { name: string; path: string; dirs: Map<string, Node>; files: Source[] };
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const s of list.value) {
    // URLs and conversation identifiers are individual sources, not file paths.
    if (/^[a-z][a-z\d+.-]*:/i.test(s.uri) && !/^[a-z]:[\\/]/i.test(s.uri)) {
      root.files.push(s);
      continue;
    }
    const parts = s.uri.replace(/\\/g, "/").split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push(s);
  }
  type Row =
    | { kind: "dir"; depth: number; dir: string; path: string; count: number }
    | { kind: "file"; depth: number; source: Source };
  const rows: Row[] = [];
  const count = (n: Node): number => n.files.length + [...n.dirs.values()].reduce((a, d) => a + count(d), 0);
  const expanded = (path: string) => q.value ? true : expandedOnce.value.has(path);
  const walk = (n: Node, depth: number) => {
    for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ kind: "dir", depth, dir: d.name, path: d.path, count: count(d) });
      if (expanded(d.path)) walk(d, depth + 1);
    }
    for (const f of n.files.sort((a, b) => a.uri.localeCompare(b.uri))) rows.push({ kind: "file", depth, source: f });
  };
  walk(root, 0);
  return rows;
});
const isTree = computed(() => space.value?.kind === "repo" && list.value.length > 12 && list.value.some((s) => /[\\/]/.test(s.uri) && (!/^[a-z][a-z\d+.-]*:/i.test(s.uri) || /^[a-z]:[\\/]/i.test(s.uri))));
function toggle(path: string) {
  const next = new Set(expandedOnce.value);
  next.has(path) ? next.delete(path) : next.add(path);
  expandedOnce.value = next;
}
function expandedInView(path: string) {
  return q.value || expandedOnce.value.has(path) ? "down" : "right";
}
const isChat = computed(() => detail.value?.source.kind === "chat");
const larkChatId = computed(() => (detail.value && /^lark:oc_[\w-]+$/.test(detail.value.source.uri) ? detail.value.source.uri.slice(5) : null));
async function backfill() {
  if (!larkChatId.value) return;
  const days = await promptDialog("回溯这个会话更早的消息", { message: "往前多少天？0 表示全部历史。后台每次采集读几页，按月存成“历史”原件，只保存可检索，不交给整理。", value: "90", okText: "开始回溯" });
  if (days === null) return;
  const n = Math.max(0, Math.floor(Number(days) || 0));
  try {
    const r = await post<{ reachedAt: string | null }>(`/api/lark/chats/${larkChatId.value}/backfill`, { days: n });
    toast(`已安排回溯${n ? `最近 ${n} 天` : "全部历史"}；目前覆盖到 ${r.reachedAt ? fmtTime(r.reachedAt, false) : "首次采集时"}，随飞书采集逐步补齐`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const isMarkdown = computed(() => detail.value && /\.(md|markdown|mdx)$/i.test(detail.value.source.uri) || detail.value?.source.kind === "note" || detail.value?.source.kind === "web" || detail.value?.source.kind === "doc" || detail.value?.source.kind === "image" || detail.value?.source.kind === "conversation" || detail.value?.source.kind === "work");
const outline = computed(() => {
  if (!detail.value) return [];
  const o = detail.value.outline;
  if (o.symbols.length) return o.symbols.filter((s) => !s.qname.includes(".") || s.line_end - s.line_start > 3).map((s) => ({ label: s.qname, qname: s.qname, kind: s.kind, line: s.line_start, end: s.line_end }));
  const seen = new Set<string>();
  return o.sections.filter((s) => s.path && !seen.has(s.path) && seen.add(s.path)).map((s) => ({ label: s.path.split(" / ").pop()!, kind: "", line: s.line_start, end: s.line_end, depth: s.path.split(" / ").length }));
});
type Relations = {
  callers: { sourceId: string; uri: string; fromQname: string; line: number }[];
  callees: { sourceId: string | null; uri: string | null; qname: string | null; name: string; line: number }[];
};
const symbol = ref<string | null>(null);
const relations = ref<Relations | null>(null);
async function goLine(line: number, end: number, qname?: string) {
  raw.value = true;
  router.replace({ query: { from: String(line), to: String(end) } });
  if (!qname || !detail.value || detail.value.source.kind !== "code") return;
  symbol.value = qname;
  relations.value = await get<Relations>(`/api/sources/${detail.value.source.id}/relations?qname=${encodeURIComponent(qname)}`);
}
watch(id, () => {
  symbol.value = null;
  relations.value = null;
});
const resolvedCallees = computed(() => relations.value?.callees.filter((c) => c.qname) ?? []);
const otherCallees = computed(() => [...new Set(relations.value?.callees.filter((c) => !c.qname).map((c) => c.name) ?? [])]);
async function openSymbol(sourceId: string, qname: string) {
  const o = await get<{ outline: Detail["outline"] }>(`/api/sources/${sourceId}?from=1&to=1`);
  const s = o.outline.symbols.find((x) => x.qname === qname);
  await router.push({ path: `/sources/${sourceId}`, query: s ? { from: String(s.line_start), to: String(s.line_end) } : {} });
  symbol.value = qname;
  relations.value = await get<Relations>(`/api/sources/${sourceId}/relations?qname=${encodeURIComponent(qname)}`);
}
async function remove() {
  if (!detail.value || !(await confirmDialog(`移除原件「${detail.value.source.title}」？`, { message: "引用它的页面会提示原件已移除。", okText: "移除", danger: true }))) return;
  await del(`/api/sources/${detail.value.source.id}`);
  router.push("/sources");
  void load();
}
async function makeCards() {
  if (!detail.value) return;
  await post("/api/learn/generate", { space: detail.value.source.spaceId, sourceIds: [detail.value.source.id] });
  toast("正在生成复习卡片", "ok", "#/learn");
}
async function sync() {
  await post(`/api/spaces/${state.space}/sync`);
  toast("开始同步目录", "ok");
}
const kindIcon: Record<string, string> = { code: "code", doc: "file", chat: "chat", note: "edit", web: "link", image: "eye", conversation: "chat", work: "layers" };
</script>

<template>
  <div class="sources">
    <aside class="list-col">
      <div class="head">
        <div class="row">
          <strong>原件</strong>
          <span class="muted small">{{ listLoading && !list.length ? "" : total }}</span>
          <span class="spacer" />
          <button v-if="space?.rootPath" class="btn ghost sm icon" title="同步关联目录" @click="sync"><Icon name="refresh" :size="15" /></button>
          <button class="btn ghost sm icon" title="保存材料" @click="state.capture = true"><Icon name="plus" :size="15" /></button>
        </div>
        <input v-model="q" class="input" placeholder="按标题或路径筛选" />
        <div class="kinds row wrap">
          <button v-for="k in ['', 'doc', 'code', 'chat', 'note', 'web', 'image', 'conversation', 'work']" :key="k" class="kind" :class="{ on: kind === k }" @click="kind = k">{{ { "": "全部", doc: "文档", code: "代码", chat: "聊天", note: "笔记", web: "网页", image: "图片", conversation: "对话", work: "工作文件" }[k] }}</button>
        </div>
      </div>
      <div ref="itemsEl" class="items" @scroll.passive="onListScroll">
        <Skeleton v-if="listLoading && !list.length" :rows="8" />
        <VirtualList v-else-if="isTree" :items="tree" :item-key="(r) => (r.kind === 'dir' ? `d:${r.path}` : r.source.id)" :estimate="28">
          <template #default="{ item: r }">
            <button v-if="r.kind === 'dir'" class="row-btn dir" :style="{ paddingLeft: 8 + r.depth * 14 + 'px' }" @click="toggle(r.path)">
              <Icon :name="expandedInView(r.path)" :size="13" /><Icon name="folder" :size="14" /><span class="ellipsis">{{ r.dir }}</span><span class="muted small">{{ r.count }}</span>
            </button>
            <router-link v-else :to="`/sources/${r.source.id}`" class="row-btn" :class="{ on: r.source.id === id }" :style="{ paddingLeft: 26 + r.depth * 14 + 'px' }">
              <span class="ellipsis">{{ r.source.uri.split("/").pop() }}</span>
            </router-link>
          </template>
        </VirtualList>
        <VirtualList v-else :items="list" :item-key="(s) => s.id" :estimate="52">
          <template #default="{ item: s }">
            <router-link :to="`/sources/${s.id}`" class="row-btn flat" :class="{ on: s.id === id }">
              <Icon :name="kindIcon[s.kind] ?? 'file'" :size="15" />
              <div class="grow"><div class="ellipsis">{{ s.title }}</div><div class="muted small">{{ relTime(s.updatedAt) }}<template v-if="s.lines !== undefined"> · {{ s.lines }} 行</template></div></div>
            </router-link>
          </template>
        </VirtualList>
        <div v-if="!list.length && !listLoading" class="empty small">
          <p>这个空间还没有原件。</p>
          <button class="btn sm" @click="state.capture = true"><Icon name="plus" :size="14" />保存材料</button>
        </div>
        <div v-else-if="loadingMore" class="list-foot">加载中…</div>
      </div>
    </aside>

    <main class="detail">
      <div v-if="detailLoading && (!detail || detail.source.id !== id)" class="loading-detail"><Skeleton variant="text" :rows="10" /></div>
      <div v-else-if="!detail" class="empty">
        <Icon name="file" :size="34" />
        <h3>选择一份原件</h3>
        <p>原件是知识库的依据：文档、代码、聊天记录、笔记和网页。Wiki、记忆和回答都引用它们。</p>
      </div>
      <template v-else>
        <header class="dh">
          <div class="muted small mono ellipsis">{{ detail.source.spaceId }} / {{ detail.source.uri }}</div>
          <h1>{{ detail.source.kind === "code" ? detail.source.title.split("/").pop() : detail.source.title }}</h1>
          <div class="row wrap meta">
            <span class="badge">{{ detail.source.kind }}</span>
            <span class="muted small">{{ detail.source.lines }} 行 · 更新于 {{ fmtTime(detail.source.updatedAt) }} · 首次保存 {{ fmtTime(detail.source.capturedAt, false) }}</span>
            <span v-if="detail.source.kind === 'work'" class="muted small">{{ detail.source.meta?.expiresAt ? `${fmtTime(String(detail.source.meta.expiresAt))} 过期` : "永久保留" }}</span>
            <span class="spacer" />
            <button v-if="isMarkdown || isChat" class="btn ghost sm" @click="raw = !raw">{{ raw ? (isChat ? "聊天视图" : "排版视图") : "原文行号" }}</button>
            <button v-if="larkChatId" class="btn ghost sm" title="把更早的消息也读进来" @click="backfill"><Icon name="history" :size="14" />回溯历史</button>
            <button class="btn ghost sm" @click="makeCards"><Icon name="cap" :size="14" />生成卡片</button>
            <button class="btn ghost sm icon danger" title="移除" @click="remove"><Icon name="trash" :size="14" /></button>
          </div>
          <div v-if="detail.citedBy.length" class="cited small">
            被引用：<router-link v-for="p in detail.citedBy" :key="p.page_id" :to="`/wiki/${p.page_id.split('/')[0]}/${p.page_id.split('/').slice(1).join('/')}`" class="badge accent">{{ p.title }}</router-link>
          </div>
          <details v-if="!detail.source.deletedAt && !['code','conversation','activity','work'].includes(detail.source.kind)" class="archive-info">
            <summary>空间归属 · {{ archive?.route?.reason ?? '采集或导入时指定' }}</summary>
            <div class="row wrap" style="margin-top: 12px">
              <UiSelect v-model="moveTarget" :options="state.spaces.map(s => ({ value: s.id, label: s.name }))" aria-label="原件目标空间" />
              <input v-model="moveReason" class="input" style="flex: 1; min-width: 140px" placeholder="归属依据" aria-label="归属依据" />
              <button class="btn sm" :disabled="moving || !moveReason.trim()" @click="moveOriginal">确认归属</button>
            </div>
            <p v-for="(h, i) in archive?.history" :key="i" class="muted small">{{ fmtTime(h.at) }} · {{ h.from_space }} → {{ h.to_space }} · {{ h.reason }}</p>
          </details>
        </header>
        <div v-if="detail.source.deletedAt" class="card pad muted">这份原件已于 {{ fmtTime(detail.source.deletedAt) }} 移除，只保留了身份记录。</div>
        <div v-else class="body">
          <div class="text">
            <ChatView v-if="isChat && !raw" :source-id="detail.source.id" :text="detail.text" :space="detail.source.spaceId" :from="hl?.from" :to="hl?.to" />
            <CodeView v-else-if="raw || !isMarkdown" :text="detail.text" :start="1" :path="detail.source.uri" :from="hl?.from" :to="hl?.to" :wrap="isMarkdown || isChat" />
            <div v-else class="card pad doc"><Markdown :source="detail.text" :space="detail.source.spaceId" /></div>
          </div>
          <aside v-if="outline.length" class="outline">
            <div class="section-title">结构</div>
            <a v-for="(o, i) in outline" :key="i" href="#" class="ol" :class="{ on: symbol && (o as any).qname === symbol }" :style="{ paddingLeft: ((o as any).depth ?? 1) * 8 - 8 + 'px' }" @click.prevent="goLine(o.line, o.end, (o as any).qname)">
              <span v-if="o.kind" class="k">{{ o.kind.slice(0, 2) }}</span><span class="ellipsis">{{ o.label }}</span>
            </a>
            <div v-if="relations && symbol" class="rel">
              <div class="section-title">{{ symbol }} 被调用 · {{ relations.callers.length }}</div>
              <a v-for="(c, i) in relations.callers" :key="'c' + i" href="#" class="ol" :title="`${c.uri}:${c.line}`" @click.prevent="openSymbol(c.sourceId, c.fromQname)">
                <span class="ellipsis">{{ c.fromQname || "(顶层)" }}</span><span class="muted small ellipsis file">{{ c.uri.split("/").pop() }}</span>
              </a>
              <p v-if="!relations.callers.length" class="muted small">没有解析到调用方（可能是入口、动态调用或外部使用）。</p>
              <div class="section-title">调用 · {{ resolvedCallees.length }}</div>
              <a v-for="(c, i) in resolvedCallees" :key="'e' + i" href="#" class="ol" :title="`${c.uri}`" @click.prevent="openSymbol(c.sourceId!, c.qname!)">
                <span class="ellipsis">{{ c.qname }}</span><span class="muted small ellipsis file">{{ c.uri?.split("/").pop() }}</span>
              </a>
              <p v-if="otherCallees.length" class="muted small ext">外部/未解析：{{ otherCallees.slice(0, 30).join("、") }}</p>
            </div>
          </aside>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.archive-info { margin-top: 12px; overflow-wrap: anywhere; }
.loading-detail {
  max-width: 760px;
  padding-top: 8px;
}
.rel {
  min-width: 0;
  margin-top: 14px;
  border-top: 1px solid var(--line);
  padding-top: 6px;
}
.rel .ol > .ellipsis:first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.rel .file {
  margin-left: auto;
  flex: none;
  max-width: 45%;
}
.rel .ext {
  word-break: break-all;
  margin: 4px 0 0;
}
.ol.on {
  color: var(--accent);
}
.sources {
  display: flex;
  height: 100%;
}
.list-col {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 14px 12px 10px;
  display: grid;
  gap: 8px;
  border-bottom: 1px solid var(--line);
}
.kinds {
  gap: 4px;
}
.kind {
  border: 1px solid var(--line);
  background: none;
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 12px;
  cursor: pointer;
  color: var(--ink-2);
}
.kind.on {
  background: var(--ink);
  color: var(--bg);
  border-color: var(--ink);
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
}
.row-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  background: none;
  text-align: left;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--ink-2);
  font-size: 13px;
  cursor: pointer;
  min-width: 0;
}
.row-btn:hover {
  background: var(--hover);
  text-decoration: none;
}
.row-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.row-btn.flat {
  padding: 8px 10px;
  align-items: flex-start;
}
.dir {
  color: var(--ink);
  font-weight: 500;
}
.dir .muted {
  margin-left: auto;
}
.grow {
  flex: 1;
  min-width: 0;
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 28px 60px;
}
.dh {
  margin-bottom: 16px;
  display: grid;
  gap: 6px;
}
.dh h1 {
  font-size: 22px;
}
.meta {
  gap: 6px;
}
.cited {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.body {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.text {
  flex: 1;
  min-width: 0;
}
.doc {
  max-width: 820px;
}
.outline {
  width: 220px;
  flex: none;
  position: sticky;
  top: 0;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 1px;
}
.ol {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--ink-2);
  padding: 2px 0;
  font-family: var(--mono);
  min-width: 0;
}
.k {
  font-size: 10px;
  color: var(--muted);
  width: 16px;
  flex: none;
}
@media (max-width: 1100px) {
  .outline {
    display: none;
  }
}
@media (max-width: 760px) {
  .sources {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 40vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .detail {
    padding: 16px;
  }
}
</style>
