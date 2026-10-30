<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, post } from "../api";
import Icon from "../components/Icon.vue";
import Markdown from "../components/Markdown.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { fmtTime, relTime, state, toast } from "../store";

/**
 * A space's requirement tree (src/items/requirements.ts, docs/v2/requirements.md): system → module →
 * page → feature, test points under features. Each node shows its history (corrections and business
 * changes with their reasons), links to other businesses, and its state in the latest review. What an
 * Agent wrote waits here for the owner's confirmation.
 */
type Kind = "system" | "module" | "page" | "feature" | "test";
type State = { runId: string; round: number; status: string; locations: { file: string; start?: number; end?: number }[]; note: string; at: string };
type Node = { id: string; spaceId: string; parentId: string | null; kind: Kind; title: string; body: string; acceptance: string; refs: string[]; tests: { file?: string; name?: string }[]; confirmed: boolean; status: "active" | "deleted" | "removed"; version: number; createdBy: string; updatedAt: string; depth: number; state: State | null; links: number };
type Version = { id: string; version: number; change: string; title: string; reason: string; sourceRefs: string[]; by: string; runId: string | null; at: string };
type Link = { id: string; direction: "in" | "out"; note: string; other: { id: string; spaceId: string; kind: Kind; title: string; status: string } | null };
type Detail = { node: Node; path: { id: string; kind: Kind; title: string }[]; children: Node[]; versions: Version[]; links: Link[]; state: State | null };

const KIND: Record<Kind, string> = { system: "系统", module: "模块", page: "页面", feature: "功能", test: "测试点" };
const CHANGE: Record<string, string> = { create: "新建", correct: "更正", change: "业务变更", delete: "删除（写错了）", remove: "移除（业务不要了）", confirm: "本人确认", restore: "恢复" };
const STATE: Record<string, { text: string; cls: string }> = { done: { text: "已实现", cls: "ok" }, partial: { text: "部分实现", cls: "warn" }, missing: { text: "没实现", cls: "danger" }, extra: { text: "需求外", cls: "" } };
const CHILD_KINDS: Record<Kind | "root", Kind[]> = { root: ["system", "module", "page", "feature"], system: ["module", "page", "feature"], module: ["module", "page", "feature"], page: ["feature"], feature: ["feature", "test"], test: ["test"] };

const route = useRoute();
const router = useRouter();
const nodes = ref<Node[]>([]);
const loading = ref(true);
const showRemoved = ref(false);
const detail = ref<Detail | null>(null);
const selectedId = computed(() => (route.params.id as string | undefined) || "");
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const pending = computed(() => nodes.value.filter((n) => !n.confirmed && n.status === "active").length);

async function loadTree() {
  loading.value = true;
  try {
    const before = nodes.value.length && nodes.value[0].spaceId === state.space;
    nodes.value = (await get<{ nodes: Node[] }>(`/api/requirements?space=${encodeURIComponent(state.space)}${showRemoved.value ? "&removed=1" : ""}`)).nodes;
    if (!before) loadFolds();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}
async function loadDetail() {
  if (!selectedId.value) {
    detail.value = null;
    return;
  }
  try {
    const d = await get<Detail>(`/api/requirements/${selectedId.value}`);
    detail.value = d;
    // A link to another business opens its tree.
    if (d.node.spaceId !== state.space) state.space = d.node.spaceId;
  } catch (e) {
    detail.value = null;
    toast((e as Error).message, "error");
  }
}
onMounted(() => void Promise.all([loadTree(), loadDetail()]));
watch(() => state.space, () => void loadTree());
watch(showRemoved, () => void loadTree());
watch(selectedId, () => {
  editing.value = null;
  void loadDetail();
});
onServerEvent((e) => {
  if (e.type === "changed" && (e as { entity?: string }).entity === "requirement") {
    void loadTree();
    if ((e as { id?: string }).id === selectedId.value) void loadDetail();
  }
});
const open = (id: string) => router.push(`/reqs/${id}`);

// ---- folding and search -------------------------------------------------------------------------
// Folded nodes per space, kept in this browser. A space opened for the first time shows systems and
// modules only; the selected node's ancestors always open.
const query = ref("");
const showTests = ref(true);
const folded = ref(new Set<string>());
const foldKey = () => `omem.reqs.folded.${state.space}`;
function loadFolds() {
  try {
    const saved = localStorage.getItem(foldKey());
    if (saved) return void (folded.value = new Set(JSON.parse(saved) as string[]));
  } catch {}
  folded.value = new Set(nodes.value.filter((n) => n.depth >= 1 && hasKids.value.has(n.id)).map((n) => n.id));
}
function saveFolds() {
  try {
    localStorage.setItem(foldKey(), JSON.stringify([...folded.value]));
  } catch {}
}
const byId = computed(() => new Map(nodes.value.map((n) => [n.id, n])));
const hasKids = computed(() => new Set(nodes.value.filter((n) => n.parentId && (showTests.value || n.kind !== "test")).map((n) => n.parentId!)));
const ancestors = (n: Node) => {
  const out: string[] = [];
  for (let p = n.parentId, i = 0; p && i < 20; p = byId.value.get(p)?.parentId ?? null, i++) out.push(p);
  return out;
};
function toggle(id: string) {
  const next = new Set(folded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  folded.value = next;
  saveFolds();
}
function foldAll(fold: boolean) {
  folded.value = fold ? new Set([...hasKids.value].filter((id) => (byId.value.get(id)?.depth ?? 0) >= 1)) : new Set();
  saveFolds();
}
// Searching: matches and the path down to them, regardless of folding.
const terms = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean));
const matches = computed(() => {
  if (!terms.value.length) return null;
  const hit = new Set(nodes.value.filter((n) => terms.value.every((t) => `${n.title}\n${n.body}\n${n.acceptance}\n${n.id}`.toLowerCase().includes(t))).map((n) => n.id));
  return hit;
});
const visible = computed(() => {
  const list = nodes.value.filter((n) => showTests.value || n.kind !== "test");
  const m = matches.value;
  if (m) {
    const keep = new Set<string>();
    for (const id of m) {
      const n = byId.value.get(id);
      if (!n) continue;
      keep.add(id);
      for (const a of ancestors(n)) keep.add(a);
    }
    return list.filter((n) => keep.has(n.id));
  }
  return list.filter((n) => !ancestors(n).some((a) => folded.value.has(a)));
});
// Opening a node (a link, a search hit) unfolds the way to it.
watch([selectedId, nodes], () => {
  const n = byId.value.get(selectedId.value);
  if (!n) return;
  const up = ancestors(n).filter((a) => folded.value.has(a));
  if (!up.length) return;
  const next = new Set(folded.value);
  for (const a of up) next.delete(a);
  folded.value = next;
  saveFolds();
});

async function apply(ops: Record<string, unknown>[], done = "已保存") {
  try {
    const r = await post<{ keys: Record<string, string> }>("/api/requirements", { space: state.space, ops });
    toast(done);
    await Promise.all([loadTree(), loadDetail()]);
    return r;
  } catch (e) {
    toast((e as Error).message, "error");
    return null;
  }
}

// ---- edit / add ---------------------------------------------------------------------------------

type Form = { mode: "edit" | "add"; parent: string | null; kind: Kind; title: string; body: string; acceptance: string; refs: string; tests: string; change: "correct" | "change"; reason: string; sourceRefs: string };
const editing = ref<Form | null>(null);
const testsText = (t: Node["tests"]) => t.map((x) => [x.file, x.name].filter(Boolean).join(" › ")).join("\n");
const parseTests = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
  const [file, ...rest] = l.split("›").map((x) => x.trim());
  return rest.length ? { file, name: rest.join(" › ") } : /[./\\]/.test(file) ? { file } : { name: file };
});
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
function startEdit() {
  const n = detail.value!.node;
  editing.value = { mode: "edit", parent: n.parentId, kind: n.kind, title: n.title, body: n.body, acceptance: n.acceptance, refs: n.refs.join("\n"), tests: testsText(n.tests), change: "correct", reason: "", sourceRefs: "" };
}
function startAdd(parent: Node | null) {
  const kinds = CHILD_KINDS[parent?.kind ?? "root"];
  editing.value = { mode: "add", parent: parent?.id ?? null, kind: kinds.includes("feature") && parent ? "feature" : kinds[0], title: "", body: "", acceptance: "", refs: "", tests: "", change: "correct", reason: "", sourceRefs: "" };
}
const kindOptions = computed(() => {
  const f = editing.value;
  if (!f) return [];
  const parentKind = f.parent ? (nodes.value.find((n) => n.id === f.parent)?.kind ?? detail.value?.path.find((p) => p.id === f.parent)?.kind) : undefined;
  return CHILD_KINDS[parentKind ?? "root"].map((k) => ({ value: k, label: KIND[k] }));
});
async function saveForm() {
  const f = editing.value!;
  if (!f.title.trim()) return toast("写个标题", "error");
  if (f.mode === "edit" && f.change === "change" && !f.reason.trim()) return toast("业务变更要写清为什么变", "error");
  const fields = { title: f.title, kind: f.kind, body: f.body, acceptance: f.acceptance, refs: lines(f.refs), ...(f.kind === "test" ? { tests: parseTests(f.tests) } : {}) };
  const op = f.mode === "add"
    ? { op: "add", key: "new", parent: f.parent ?? undefined, ...fields }
    : { op: "edit", id: detail.value!.node.id, change: f.change, reason: f.reason || undefined, source_refs: lines(f.sourceRefs), ...fields };
  const r = await apply([op], f.mode === "add" ? "已新建" : f.change === "change" ? "已记为业务变更" : "已更正");
  if (!r) return;
  editing.value = null;
  if (f.mode === "add" && r.keys.new) void open(r.keys.new);
}

async function remove(change: "correct" | "change") {
  const n = detail.value!.node;
  let reason: string | undefined;
  if (change === "change") {
    const v = await promptDialog(`移除「${n.title}」`, { message: "业务不要它了：写清为什么，以后回溯时看得到。下级一起移除。", placeholder: "如：退款改走客服工单，不再在页面上申请", okText: "移除", danger: true });
    if (!v?.trim()) return;
    reason = v.trim();
  } else if (!(await confirmDialog(`删除「${n.title}」？`, { message: "写错了、拆错了才删。下级一起删除，历史留着，可以恢复。", okText: "删除", danger: true }))) return;
  await apply([{ op: "delete", id: n.id, change, reason }], change === "change" ? "已移除" : "已删除");
}
const restore = () => apply([{ op: "restore", id: detail.value!.node.id }], "已恢复");
const confirmNode = () => apply([{ op: "confirm", id: detail.value!.node.id }], "已确认");

// ---- links --------------------------------------------------------------------------------------

const linking = ref(false);
const linkQuery = ref("");
const linkNote = ref("");
const linkHits = ref<{ id: string; spaceId: string; title: string; display: { place: string } }[]>([]);
let linkTimer: ReturnType<typeof setTimeout> | undefined;
watch(linkQuery, (v) => {
  clearTimeout(linkTimer);
  if (!v.trim()) return void (linkHits.value = []);
  linkTimer = setTimeout(async () => {
    const r = await get<{ hits: typeof linkHits.value }>(`/api/search?q=${encodeURIComponent(v.trim())}&space=*&types=requirement&limit=12`).catch(() => ({ hits: [] }));
    linkHits.value = r.hits.filter((h) => h.id !== selectedId.value);
  }, 250);
});
async function link(to: string) {
  if (await apply([{ op: "link", id: selectedId.value, to, note: linkNote.value.trim() || undefined }], "已关联")) {
    linking.value = false;
    linkQuery.value = "";
    linkNote.value = "";
  }
}
const unlink = (to: string) => apply([{ op: "unlink", id: selectedId.value, to }], "已取消关联");
</script>

<template>
  <div class="reqs">
    <aside class="list-col">
      <div class="head row">
        <strong class="ellipsis">{{ spaceName(state.space) }} · 需求</strong>
        <span class="spacer" />
        <button class="btn ghost sm icon" title="新建顶层节点" aria-label="新建顶层节点" @click="router.push('/reqs'); startAdd(null)"><Icon name="plus" :size="15" /></button>
      </div>
      <div class="filters">
        <input v-model="query" class="input sm" type="search" placeholder="搜索标题、需求、验收或 id" aria-label="搜索需求" />
        <div class="row wrap">
          <UiCheckbox v-model="showTests" size="sm">测试点</UiCheckbox>
          <UiCheckbox v-model="showRemoved" size="sm">已删除</UiCheckbox>
          <span class="spacer" />
          <button class="btn ghost sm" type="button" :disabled="!!matches" @click="foldAll(false)">全部展开</button>
          <button class="btn ghost sm" type="button" :disabled="!!matches" @click="foldAll(true)">收起</button>
        </div>
        <div v-if="pending || matches" class="row muted small">
          <span v-if="matches">{{ matches.size }} 个匹配</span>
          <span v-if="pending" class="badge accent">{{ pending }} 个待确认</span>
        </div>
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="6" />
        <template v-else>
          <div v-for="n in visible" :key="n.id" class="node" :class="{ on: n.id === selectedId, gone: n.status !== 'active', test: n.kind === 'test', hit: matches?.has(n.id) }" :style="{ paddingLeft: `${4 + n.depth * 16}px` }">
            <button v-if="hasKids.has(n.id)" type="button" class="fold" :aria-expanded="!!matches || !folded.has(n.id)" :aria-label="folded.has(n.id) ? `展开 ${n.title}` : `收起 ${n.title}`" :disabled="!!matches" @click="toggle(n.id)"><Icon :name="!matches && folded.has(n.id) ? 'right' : 'down'" :size="13" /></button>
            <span v-else class="fold-gap" />
            <button type="button" class="pick" @click="open(n.id)">
            <span class="k" :class="`k-${n.kind}`">{{ KIND[n.kind] }}</span>
            <span class="t ellipsis" :title="n.title">{{ n.title }}</span>
            <span v-if="!n.confirmed && n.status === 'active'" class="dot" title="待本人确认" />
            <span v-if="n.state && STATE[n.state.status]" class="badge" :class="STATE[n.state.status].cls">{{ STATE[n.state.status].text }}</span>
            </button>
          </div>
          <div v-if="matches && !matches.size" class="empty muted small">没有匹配的需求点。</div>
          <div v-if="!nodes.length" class="empty muted small">
            这个空间还没有需求树。点右上角的 + 建系统或模块，或者在事项页点“拆需求点”，让 AI 读事项的材料拆好再给你确认。
          </div>
        </template>
      </div>
    </aside>

    <main class="detail">
      <div v-if="editing" class="page">
        <div class="row dh"><h2 class="title">{{ editing.mode === "add" ? (editing.parent ? "新建下级" : "新建顶层节点") : "修改" }}</h2></div>
        <div class="card pad form">
          <label class="field"><span>类型</span><UiSegmented v-model="editing.kind" size="sm" :options="kindOptions" aria-label="类型" /></label>
          <label class="field"><span>标题</span><input v-model="editing.title" class="input" maxlength="200" placeholder="一句话说清做成什么，如：退款金额只算未发货的行" /></label>
          <label v-if="editing.kind !== 'system'" class="field"><span>{{ editing.kind === "test" ? "场景" : "需求" }}</span><textarea v-model="editing.body" class="textarea" rows="6" :placeholder="editing.kind === 'test' ? '前提、操作、预期' : '规则、口径、边界、例外；用 [文字](src:原件id#L起-L止) 引用原文'" /></label>
          <label v-if="editing.kind === 'feature'" class="field"><span>验收</span><textarea v-model="editing.acceptance" class="textarea" rows="3" placeholder="怎样算做到了" /></label>
          <label v-if="editing.kind === 'test'" class="field"><span>对应测试</span><textarea v-model="editing.tests" class="textarea mono" rows="2" placeholder="一行一个：文件 › 用例名" /></label>
          <label class="field"><span>依据</span><textarea v-model="editing.refs" class="textarea mono" rows="2" placeholder="一行一个：src:原件id#L3-L9 或 mem:记忆id" /></label>
          <template v-if="editing.mode === 'edit'">
            <div class="field">
              <span>这次修改是</span>
              <UiSegmented v-model="editing.change" size="sm" :options="[{ value: 'correct', label: '更正（写错了）' }, { value: 'change', label: '业务变更' }]" aria-label="修改类型" />
            </div>
            <template v-if="editing.change === 'change'">
              <label class="field"><span>为什么变</span><textarea v-model="editing.reason" class="textarea" rows="2" placeholder="业务上怎么定的、谁定的，以后回溯时看得到" /></label>
              <label class="field"><span>变更依据</span><textarea v-model="editing.sourceRefs" class="textarea mono" rows="2" placeholder="一行一个：群聊、会议、文档的 src: 引用" /></label>
            </template>
          </template>
          <div class="row"><span class="spacer" /><button class="btn sm" @click="editing = null">取消</button><button class="btn sm primary" @click="saveForm">保存</button></div>
        </div>
      </div>

      <div v-else-if="detail" class="page">
        <nav class="crumbs muted small" aria-label="路径">
          <template v-for="(p, i) in detail.path" :key="p.id">
            <span v-if="i" aria-hidden="true">/</span>
            <a v-if="p.id !== detail.node.id" href="#" @click.prevent="open(p.id)">{{ p.title }}</a>
            <span v-else>{{ p.title }}</span>
          </template>
        </nav>
        <div class="row dh">
          <span class="k lg" :class="`k-${detail.node.kind}`">{{ KIND[detail.node.kind] }}</span>
          <h2 class="title">{{ detail.node.title }}</h2>
          <span v-if="detail.node.status !== 'active'" class="badge danger">{{ detail.node.status === "removed" ? "已移除" : "已删除" }}</span>
          <span v-else-if="!detail.node.confirmed" class="badge accent">待确认</span>
        </div>
        <div class="row wrap actions">
          <template v-if="detail.node.status === 'active'">
            <button v-if="!detail.node.confirmed" class="btn sm primary" @click="confirmNode"><Icon name="check" :size="14" />确认（含下级）</button>
            <button class="btn sm" @click="startEdit"><Icon name="edit" :size="14" />修改</button>
            <button class="btn sm" @click="startAdd(detail.node)"><Icon name="plus" :size="14" />加下级</button>
            <button class="btn sm" @click="linking = !linking"><Icon name="link" :size="14" />关联</button>
            <span class="spacer" />
            <button class="btn ghost sm danger" @click="remove('change')">移除（业务不要了）</button>
            <button class="btn ghost sm danger" @click="remove('correct')">删除（写错了）</button>
          </template>
          <button v-else class="btn sm" @click="restore">恢复</button>
        </div>

        <section v-if="linking" class="block">
          <div class="block-head"><strong>关联到另一个需求点</strong><span class="muted small">可以在别的业务空间；跨业务的需求互相引用，不复制</span></div>
          <input v-model="linkQuery" class="input sm" placeholder="搜索需求点" aria-label="搜索需求点" />
          <input v-model="linkNote" class="input sm" placeholder="关系说明（可选），如：下单时校验对方的资质状态" aria-label="关系说明" />
          <button v-for="h in linkHits" :key="h.id" type="button" class="hit" @click="link(h.id)">
            <span class="ellipsis">{{ h.title }}</span><span class="muted small">{{ spaceName(h.spaceId) }}</span>
          </button>
        </section>

        <section v-if="detail.state" class="block">
          <div class="block-head"><strong>最近一次评审</strong><span class="badge" :class="STATE[detail.state.status]?.cls">{{ STATE[detail.state.status]?.text ?? detail.state.status }}</span><router-link :to="`/runs/${detail.state.runId}`" class="small">第 {{ detail.state.round }} 轮</router-link><span class="muted small">{{ relTime(detail.state.at) }}</span></div>
          <div v-if="detail.state.locations.length" class="small mono">{{ detail.state.locations.map((l) => `${l.file}${l.start ? `:${l.start}${l.end ? `-${l.end}` : ""}` : ""}`).join("、") }}</div>
          <div v-if="detail.state.note" class="small">{{ detail.state.note }}</div>
        </section>

        <section v-if="detail.node.body" class="block"><div class="block-head"><strong>{{ detail.node.kind === "test" ? "场景" : "需求" }}</strong></div><Markdown :source="detail.node.body" :space="detail.node.spaceId" /></section>
        <section v-if="detail.node.acceptance" class="block"><div class="block-head"><strong>验收</strong></div><Markdown :source="detail.node.acceptance" :space="detail.node.spaceId" /></section>
        <section v-if="detail.node.tests.length" class="block"><div class="block-head"><strong>对应测试</strong></div><div v-for="(t, i) in detail.node.tests" :key="i" class="small mono">{{ [t.file, t.name].filter(Boolean).join(" › ") }}</div></section>
        <section v-if="detail.node.refs.length" class="block"><div class="block-head"><strong>依据</strong></div><Markdown :source="detail.node.refs.map((r) => `- [${r}](${r})`).join('\n')" :space="detail.node.spaceId" /></section>

        <section v-if="detail.children.length" class="block">
          <div class="block-head"><strong>下级</strong></div>
          <a v-for="c in detail.children" :key="c.id" href="#" class="child" @click.prevent="open(c.id)"><span class="k" :class="`k-${c.kind}`">{{ KIND[c.kind] }}</span><span class="ellipsis">{{ c.title }}</span></a>
        </section>

        <section v-if="detail.links.length" class="block">
          <div class="block-head"><strong>关联</strong></div>
          <div v-for="l in detail.links" :key="l.id" class="row link">
            <span class="muted" aria-hidden="true">{{ l.direction === "out" ? "→" : "←" }}</span>
            <a v-if="l.other" href="#" class="ellipsis" @click.prevent="open(l.other.id)">{{ l.other.title }}</a>
            <span v-else class="muted">（已不存在）</span>
            <span v-if="l.other && l.other.spaceId !== detail.node.spaceId" class="badge">{{ spaceName(l.other.spaceId) }}</span>
            <span v-if="l.note" class="muted small grow ellipsis" :title="l.note">{{ l.note }}</span>
            <span v-else class="spacer" />
            <button v-if="l.other" class="btn ghost sm icon" title="取消关联" aria-label="取消关联" @click="unlink(l.other.id)"><Icon name="x" :size="13" /></button>
          </div>
        </section>

        <section class="block">
          <div class="block-head"><strong>时间线</strong><span class="muted small">第 {{ detail.node.version }} 版</span></div>
          <div v-for="v in [...detail.versions].reverse()" :key="v.id" class="ver" :class="{ biz: v.change === 'change' || v.change === 'remove' }">
            <div class="row wrap"><span class="badge" :class="{ warn: v.change === 'change' || v.change === 'remove' }">{{ CHANGE[v.change] ?? v.change }}</span><span class="muted small">{{ fmtTime(v.at) }} · {{ v.by }}</span><router-link v-if="v.runId" :to="`/runs/${v.runId}`" class="small">运行</router-link></div>
            <div v-if="v.reason" class="small">{{ v.reason }}</div>
            <Markdown v-if="v.sourceRefs.length" class="small" :source="v.sourceRefs.map((r) => `[${r}](${r})`).join(' ')" :space="detail.node.spaceId" />
          </div>
        </section>
      </div>

      <div v-else class="page muted">
        <p>选左边的节点看需求、验收、测试点和每次变更。</p>
        <p class="small">更正：写错了、拆错了，没有业务含义。业务变更：规则本身变了，记下原因和依据，留着以后决策时回溯。跨业务的需求用“关联”互相引用。</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.reqs {
  display: flex;
  height: 100%;
}
.list-col {
  width: 340px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  gap: 8px;
}
.filters {
  padding: 8px 12px;
  display: grid;
  gap: 6px;
  border-bottom: 1px solid var(--line);
}
.filters .row {
  gap: 8px;
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
}
.empty {
  padding: 12px 10px;
}
.node {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: 0 6px 0 4px;
  border-radius: 8px;
}
.node.hit .t {
  font-weight: 600;
}
.fold,
.fold-gap {
  flex: none;
  width: 22px;
  height: 22px;
}
.fold {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: none;
  color: var(--muted);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}
.fold:hover:not(:disabled) {
  background: var(--hover);
}
.pick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: 6px 4px;
  cursor: pointer;
}
.node:hover {
  background: var(--hover);
}
.node.on {
  background: var(--accent-soft);
}
.node.gone .t {
  text-decoration: line-through;
  color: var(--muted);
}
.node.test .t {
  color: var(--ink-2);
  font-size: 13px;
}
.t {
  flex: 1;
  min-width: 0;
}
.k {
  flex: none;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--line-strong);
  color: var(--muted);
}
.k.k-feature {
  color: var(--accent);
  border-color: var(--accent);
}
.k.lg {
  font-size: 12px;
  padding: 1px 6px;
}
.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.page {
  max-width: 880px;
  padding: 16px 24px 40px;
  display: grid;
  gap: 14px;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dh {
  gap: 10px;
  flex-wrap: wrap;
}
.title {
  flex: 1;
  min-width: 160px;
  margin: 0;
  font-size: 18px;
  overflow-wrap: anywhere;
}
.actions {
  gap: 8px;
}
.block {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.child {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.link {
  gap: 8px;
  min-width: 0;
}
.hit {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.hit:hover {
  background: var(--hover);
}
.ver {
  display: grid;
  gap: 4px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
}
.ver:first-of-type {
  border-top: 0;
}
.form {
  display: grid;
  gap: 12px;
}
.grow {
  flex: 1;
  min-width: 0;
}
@media (max-width: 760px) {
  .reqs {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 40vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .page {
    padding: 12px 16px 32px;
  }
}
</style>
