<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { del, get, onServerEvent, patch, post, type Memory, type MemoryFolder, type MemoryQuality } from "../api";
import MemoryCard from "../components/MemoryCard.vue";
import MemoryText from "../components/MemoryText.vue";
import MemoryFolderTree, { type FolderSelection } from "../components/MemoryFolderTree.vue";
import Icon from "../components/Icon.vue";
import UiSegmented from "../components/UiSegmented.vue";
import VirtualList from "../components/VirtualList.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { fmtTime, memoryKindLabel, openCitation, relTime, runKindLabel, state, statusLabel, toast } from "../store";

const tab = ref<"list" | "quality" | "recall" | "gaps">("list");
const memories = ref<Memory[]>([]);
const loading = ref(false);
const q = ref("");
const kind = ref("");
const status = ref("active");
const scope = ref<"space" | "all">("all");
const review = ref("");
const tag = ref("");
const tags = ref<{ tag: string; n: number }[]>([]);
const adding = ref(false);
const form = ref({ kind: "fact", subject: "", content: "", tags: "", folder: "" });
const editing = ref<string | null>(null);
const editText = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;

const kindOptions = computed(() => Object.entries(memoryKindLabel).map(([value, label]) => ({ value, label })));
const reviewLabel: Record<string, string> = { keep: "复核保留", rewrite: "复核改写", retract: "复核撤回", unclear: "复核未定" };
const codeLabel: Record<string, string> = {
  hedge: "免责式",
  "too-long": "太长",
  "process-log": "运行流水",
  "restates-source": "转述原件",
  "self-report": "助理汇报",
  "event-log": "事件复述",
  "no-source": "无来源",
  "bad-source": "来源不存在",
  duplicate: "重复",
  empty: "空",
};

// ---- folders ----------------------------------------------------------------------
const folders = ref<MemoryFolder[]>([]);
const unfiled = ref<Record<string, number>>({});
const sel = ref<FolderSelection>({ space: null, folder: undefined });
const treeOpen = ref(false);
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const treeSpaces = computed(() => (scope.value === "space" ? [{ id: state.space, name: spaceName(state.space) }] : state.spaces.map((s) => ({ id: s.id, name: s.name }))));
const treeTotal = computed(() => folders.value.filter((f) => !f.path.includes("/")).reduce((a, f) => a + f.total, 0) + Object.values(unfiled.value).reduce((a, n) => a + n, 0));
async function loadFolders() {
  const r = await get<{ folders: MemoryFolder[]; unfiled: Record<string, number> }>(`/api/memory-folders${scope.value === "space" ? `?space=${state.space}` : ""}`).catch(() => null);
  if (r) (folders.value = r.folders), (unfiled.value = r.unfiled);
}
/** The space new folders and memories go to: the selected one, else the current space. */
const targetSpace = computed(() => sel.value.space ?? state.space);
const currentFolder = computed(() => (sel.value.space && typeof sel.value.folder === "string" ? folders.value.find((f) => f.spaceId === sel.value.space && f.path === sel.value.folder) ?? null : null));
const selLabel = computed(() => {
  const { space, folder } = sel.value;
  if (!space) return "全部记忆";
  if (folder === null) return "未归档";
  return folder ? folder.split("/").pop()! : spaceName(space);
});
function select(s: FolderSelection) {
  sel.value = s;
  treeOpen.value = false;
}
async function newFolder() {
  const parent = sel.value.space === targetSpace.value && typeof sel.value.folder === "string" ? sel.value.folder : "";
  const name = await promptDialog("新建目录", { message: parent ? `建在「${parent}」下面。用 / 分隔可以一次建几层。` : `建在「${spaceName(targetSpace.value)}」的顶层。用 / 分隔可以一次建几层。`, placeholder: "如：项目A、生活/出行", okText: "下一步" });
  if (!name?.trim()) return;
  const description = await promptDialog("这个目录放什么？", { message: "一句话说明，助理归档时按它判断；可以留空。", placeholder: "如：项目 A 的发布、环境与值班约定", okText: "建好" });
  if (description === null) return;
  const r = await post<{ path: string }>("/api/memory-folders", { space: targetSpace.value, path: parent ? `${parent}/${name}` : name, description });
  await loadFolders();
  select({ space: targetSpace.value, folder: r.path });
}
async function describeFolder() {
  const f = currentFolder.value;
  if (!f) return;
  const v = await promptDialog("目录说明", { message: `「${f.path}」放哪一类记忆。助理归档时按它判断。`, value: f.description, okText: "保存" });
  if (v === null) return;
  await patch("/api/memory-folders", { space: f.spaceId, path: f.path, description: v });
  void loadFolders();
}
async function renameFolder() {
  const f = currentFolder.value;
  if (!f) return;
  const v = await promptDialog("改名或移动目录", { message: "写完整路径。改成已有的目录会把两个合并。", value: f.path, okText: "保存" });
  if (!v?.trim() || v.trim() === f.path) return;
  const r = await patch<{ path: string }>("/api/memory-folders", { space: f.spaceId, path: f.path, to: v });
  await loadFolders();
  select({ space: f.spaceId, folder: r.path });
}
async function removeFolder() {
  const f = currentFolder.value;
  if (!f) return;
  const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  if (!(await confirmDialog(`删除目录「${f.path}」？`, { message: `其中的 ${f.total} 条记忆和子目录移到${parent ? `「${parent}」` : "顶层（记忆变为未归档）"}，记忆本身不会删除。`, okText: "删除", danger: true }))) return;
  await del(`/api/memory-folders?space=${encodeURIComponent(f.spaceId)}&path=${encodeURIComponent(f.path)}`);
  await loadFolders();
  select({ space: f.spaceId, folder: parent || undefined });
}
async function organize() {
  const r = await post<{ id: string }>("/api/memory-folders/organize", { space: targetSpace.value });
  toast(`已开始整理「${spaceName(targetSpace.value)}」的记忆目录，完成后这里会更新`, "ok", `#/runs/${r.id}`);
}

// Moving: a picker per memory, or drag cards onto the tree.
const moving = ref<Memory | null>(null);
const moveTo = ref("");
const moveNew = ref("");
const moveOptions = computed(() => [{ value: "", label: "未归档" }, ...folders.value.filter((f) => f.spaceId === moving.value?.spaceId).map((f) => ({ value: f.path, label: f.path, hint: `${f.total} 条` }))]);
function startMove(m: Memory) {
  moving.value = m;
  moveTo.value = m.folder;
  moveNew.value = "";
}
async function moveMemories(space: string, ids: string[], folder: string) {
  const r = await post<{ moved: number }>("/api/memory-folders/move", { space, ids, folder });
  if (r.moved) toast(`已移到「${folder || "未归档"}」`, "ok");
  void loadFolders();
}
async function confirmMove() {
  const m = moving.value;
  if (!m) return;
  moving.value = null;
  await moveMemories(m.spaceId, [m.id], moveNew.value.trim() || moveTo.value);
}
function drag(e: DragEvent, m: Memory) {
  e.dataTransfer?.setData("application/x-omem-memories", m.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onTreeDrop(d: { space: string; folder: string; ids: string[] }) {
  const ids = d.ids.filter((id) => memories.value.find((m) => m.id === id)?.spaceId === d.space);
  if (!ids.length) return toast("只能在同一个空间里移动", "error");
  void moveMemories(d.space, ids, d.folder);
}

let loadSeq = 0;
async function load() {
  const my = ++loadSeq;
  loading.value = true;
  try {
    const p = new URLSearchParams({ status: status.value });
    if (q.value.trim()) p.set("q", q.value.trim());
    if (kind.value) p.set("kind", kind.value);
    if (sel.value.space) p.set("space", sel.value.space);
    else if (scope.value === "space") p.set("space", state.space);
    if (sel.value.folder === null) p.set("unfiled", "1");
    else if (sel.value.folder) p.set("folder", sel.value.folder);
    if (review.value) p.set("review", review.value);
    if (tag.value) p.set("tag", tag.value);
    const r = await get<Memory[]>(`/api/memories?${p}`);
    if (my === loadSeq) memories.value = r;
  } finally {
    if (my === loadSeq) loading.value = false;
  }
}
async function loadTags() {
  tags.value = await get<{ tag: string; n: number }[]>(`/api/memory-tags${scope.value === "space" ? `?space=${state.space}` : ""}`).catch(() => []);
}
onMounted(() => (load(), loadTags(), loadFolders()));
watch([kind, status, review, tag], load);
watch(sel, load, { deep: true });
watch(scope, () => {
  // The tree changes with the scope; start again from everything in it.
  if (sel.value.space || sel.value.folder !== undefined) sel.value = { space: null, folder: undefined };
  else void load();
  void loadTags();
  void loadFolders();
});
watch(q, () => {
  clearTimeout(timer);
  loading.value = true;
  timer = setTimeout(load, 250);
});
const off = onServerEvent((e) => {
  if (e.type === "changed" && e.entity === "memory") {
    void load();
    void loadFolders();
    if (tab.value === "quality") void loadQuality();
  }
});
onBeforeUnmount(() => off());

/** Memories grouped by the folder they sit in, named relative to the selected folder; its own come first, not filed last. */
const groups = computed(() => {
  const base = typeof sel.value.folder === "string" ? sel.value.folder : "";
  const spaces = new Set(memories.value.map((m) => m.spaceId));
  const spaceRank = (id: string) => state.spaces.findIndex((s) => s.id === id);
  const map = new Map<string, { key: string; label: string; rank: [number, number, string]; ms: Memory[] }>();
  for (const m of memories.value) {
    const rel = !m.folder ? "" : base && m.folder.startsWith(base + "/") ? m.folder.slice(base.length + 1) : m.folder === base ? "" : m.folder;
    const own = !!m.folder && m.folder === base;
    const label = (spaces.size > 1 ? `${spaceName(m.spaceId)} · ` : "") + (!m.folder ? "未归档" : own ? selLabel.value : rel);
    const key = JSON.stringify([m.spaceId, m.folder]);
    const g = map.get(key) ?? { key, label, rank: [spaceRank(m.spaceId), !m.folder ? 2 : own ? 0 : 1, rel] as [number, number, string], ms: [] };
    g.ms.push(m);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2].localeCompare(b.rank[2], "zh-Hans-CN"));
});
/** Folders and their memories as one flat list, so long lists render only what is on screen. */
const rows = computed(() => groups.value.flatMap((g) => [{ kind: "group" as const, key: `g:${g.key}`, label: g.label }, ...g.ms.map((m) => ({ kind: "memory" as const, key: m.id, m }))]));
const splitTags = (s: string) => s.split(/[,，\s]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean);

watch(adding, (open) => {
  if (open) form.value.folder = sel.value.space === targetSpace.value && typeof sel.value.folder === "string" ? sel.value.folder : "";
});
async function add() {
  if (!form.value.content.trim()) return;
  await post("/api/memories", { kind: form.value.kind, subject: form.value.subject, content: form.value.content, tags: splitTags(form.value.tags), folder: form.value.folder, space: targetSpace.value });
  form.value = { kind: "fact", subject: "", content: "", tags: "", folder: "" };
  adding.value = false;
  toast("已记住", "ok");
  void loadTags();
  void loadFolders();
}
function startEdit(m: Memory) {
  editing.value = m.id;
  editText.value = m.content;
}
async function supersede(m: Memory) {
  if (editText.value.trim() === m.content) return void (editing.value = null);
  await post(`/api/memories/${m.id}/supersede`, { content: editText.value, reason: "本人更正" });
  editing.value = null;
  toast("已更正，旧版本保留在演变记录中", "ok");
}
async function editTags(m: Memory) {
  const v = await promptDialog("标签", { message: "用逗号或空格分隔，留空清除。", value: (m.tags ?? []).join(" "), okText: "保存" });
  if (v === null) return;
  await patch(`/api/memories/${m.id}`, { tags: splitTags(v) });
  void loadTags();
}
async function retract(m: Memory) {
  const reason = await promptDialog("撤回这条记忆？", { message: m.content, value: "不再准确", placeholder: "撤回原因（可选）", okText: "撤回", danger: true });
  if (reason === null) return;
  await del(`/api/memories/${m.id}?reason=${encodeURIComponent(reason)}`);
}

// ---- quality --------------------------------------------------------------------
const quality = ref<MemoryQuality | null>(null);
const days = ref(30);
async function loadQuality() {
  quality.value = await get<MemoryQuality>(`/api/memory-quality?days=${days.value}`);
}
watch(tab, (t) => t === "quality" && loadQuality());
watch(days, loadQuality);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

// ---- recall effectiveness --------------------------------------------------------
type RecallStats = { total: number; recalled: number; neverRecalled: number; totalRecalls: number; usedRecalls: number; distinctRecalls: number; distinctUsed: number; passiveRecalls: number; passiveUsed: number };
type RecallRow = { id: string; spaceId: string; kind: string; subject: string; content: string; status: string; agent: string | null; updatedAt: string; recalls: number; used: number; lastRecalledAt: string | null };
const recall = ref<{ stats: RecallStats; memories: RecallRow[] } | null>(null);
const recallSort = ref<"recalls" | "never" | "unused" | "recent">("recalls");
async function loadRecall() {
  const p = new URLSearchParams({ sort: recallSort.value });
  if (scope.value === "space") p.set("space", state.space);
  recall.value = await get(`/api/memory-recall-stats?${p}`);
}
watch(tab, (t) => t === "recall" && loadRecall());
watch(recallSort, loadRecall);
const effectiveness = (m: RecallRow) => (m.recalls ? Math.round((m.used / m.recalls) * 100) : null);
// ---- shortcomings seen in daily use ----------------------------------------------------
type Gaps = {
  failedRuns: { kind: string; n: number; lastError: string; lastRunId: string }[];
  notFound: { messageId: string; question: string; answer: string; at: string }[];
  corrections: { messageId: string; said: string; answer: string; at: string }[];
  rejectedWrites: { n: number; codes: Record<string, number> };
  retracted: { id: string; content: string; note: string }[];
  passive: { shown: number; used: number };
  reactions?: { negative: { messageId: string; runId: string | null; emoji: string; actorKind: string; at: string; answer: string }[]; positive: number };
};
const gaps = ref<Gaps | null>(null);
const gapDays = ref(7);
async function loadGaps() {
  gaps.value = await get<Gaps>(`/api/shortcomings?days=${gapDays.value}`);
  dream.value = await get<Dream>("/api/dream/status").catch(() => null);
}
// The nightly dream that works through these signals (src/agents/jobs.ts "dream").
type Dream = { enabled: boolean; cron: string | null; next: string | null; lastDreamAt: string | null; lastRun: { id: string; status: string; at: string } | null; digestExperiences: number };
const dream = ref<Dream | null>(null);
const DREAM_HINT = "omem.memory.dreamHintSeen";
const dreamHintSeen = ref((() => {
  try {
    return localStorage.getItem(DREAM_HINT) === "1";
  } catch {
    return false;
  }
})());
function hideDreamHint() {
  dreamHintSeen.value = true;
  try {
    localStorage.setItem(DREAM_HINT, "1");
  } catch {}
}
const dreaming = ref(false);
async function dreamNow() {
  dreaming.value = true;
  try {
    await post("/api/schedules/dream/run");
    toast("已开始整理，完成后在“运行”里看报告", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    dreaming.value = false;
  }
}
watch(tab, (t) => t === "gaps" && loadGaps());
watch(gapDays, loadGaps);
const gapsEmpty = computed(() => !!gaps.value && !gaps.value.notFound.length && !gaps.value.corrections.length && !gaps.value.failedRuns.length && !gaps.value.retracted.length && !gaps.value.rejectedWrites.n && !gaps.value.reactions?.negative.length);
const actorLabel: Record<string, string> = { owner: "你", member: "其他用户", guest: "访客" };
const verdictClass = (v: string | null) => (v === "keep" ? "ok" : v === "retract" ? "danger" : v === "rewrite" ? "warn" : "");
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>记忆</h1>
        <p>助理记住的事实、约定、偏好和经验。更正时旧版本不会消失；新记忆写入前会被检查，之后由复核模型保留、改写或撤回。</p>
      </div>
      <span class="spacer" />
      <UiSegmented v-model="tab" aria-label="视图" :options="[{ value: 'list', label: '记忆' }, { value: 'recall', label: '召回' }, { value: 'quality', label: '质量' }, { value: 'gaps', label: '不足' }]" />
      <button v-if="tab === 'list'" class="btn primary" @click="adding = !adding"><Icon name="plus" :size="15" />添加</button>
    </div>

    <div v-if="tab === 'list'" class="layout">
      <aside class="side" :class="{ open: treeOpen }">
        <div class="side-head row">
          <strong>目录</strong>
          <span class="spacer" />
          <button class="btn ghost sm icon" :title="`在「${spaceName(targetSpace)}」新建目录`" :aria-label="`在「${spaceName(targetSpace)}」新建目录`" @click="newFolder"><Icon name="plus" :size="15" /></button>
          <button class="btn ghost sm icon" :title="`整理「${spaceName(targetSpace)}」的记忆目录`" :aria-label="`整理「${spaceName(targetSpace)}」的记忆目录`" @click="organize"><Icon name="sparkles" :size="15" /></button>
        </div>
        <MemoryFolderTree :folders="folders" :unfiled="unfiled" :spaces="treeSpaces" :selection="sel" :total="treeTotal" @select="select" @drop="onTreeDrop" />
        <p v-if="!folders.length" class="muted small side-note">还没有目录。新记忆会由助理按领域归档；已有的记忆可以点上面的 <Icon name="sparkles" :size="12" /> 让助理整理一遍。</p>
      </aside>

      <main class="main">
        <button class="btn sm tree-toggle" :aria-expanded="treeOpen" @click="treeOpen = !treeOpen"><Icon name="folder" :size="15" /><span class="ellipsis">目录：{{ selLabel }}</span></button>

        <div v-if="sel.space && sel.folder !== undefined" class="folder-head">
          <div class="crumbs small muted">
            <a href="#" @click.prevent="select({ space: sel.space, folder: undefined })">{{ spaceName(sel.space) }}</a>
            <template v-for="(part, i) in (sel.folder ?? '未归档').split('/')" :key="i">
              <span>/</span>
              <a v-if="sel.folder && i < sel.folder.split('/').length - 1" href="#" @click.prevent="select({ space: sel.space, folder: sel.folder.split('/').slice(0, i + 1).join('/') })">{{ part }}</a>
              <span v-else class="ink">{{ part }}</span>
            </template>
          </div>
          <div class="row wrap">
            <p class="desc">{{ sel.folder === null ? "还没放进目录的记忆。拖到左边的目录上，或点“移动”。" : currentFolder?.description || "还没有说明。写一句这里放哪一类记忆，助理归档时会按它判断。" }}</p>
            <span class="spacer" />
            <template v-if="currentFolder">
              <button class="btn ghost sm" @click="describeFolder"><Icon name="edit" :size="14" />说明</button>
              <button class="btn ghost sm" @click="renameFolder">改名</button>
              <button class="btn ghost sm icon" title="删除目录" aria-label="删除目录" @click="removeFolder"><Icon name="trash" :size="14" /></button>
            </template>
            <button v-else-if="sel.folder === null" class="btn sm" @click="organize"><Icon name="sparkles" :size="14" />让助理归档</button>
          </div>
        </div>

        <form v-if="adding" class="card pad add" @submit.prevent="add">
          <div class="row wrap">
            <UiSelect v-model="form.kind" width="120px" aria-label="类型" :options="kindOptions" />
            <input v-model="form.subject" class="input" style="flex: 1; min-width: 160px" placeholder="主题，如“项目A 预算”“张三”" />
            <input v-model="form.folder" class="input" style="flex: 1; min-width: 140px" placeholder="目录（可选），如 工作/项目A" />
            <input v-model="form.tags" class="input" style="flex: 1; min-width: 140px" placeholder="标签（可选，空格分隔）" />
          </div>
          <textarea v-model="form.content" class="textarea" rows="2" placeholder="一句话：主语开头，写清对象、时间和数字" />
          <div class="row"><span class="muted small">保存到「{{ spaceName(targetSpace) }}」</span><span class="spacer" /><button class="btn" type="button" @click="adding = false">取消</button><button class="btn primary">保存</button></div>
        </form>

        <div class="filters row wrap">
          <div class="search row"><Icon name="search" :size="15" /><input v-model="q" placeholder="搜索记忆" /><span v-if="loading && q.trim()" class="spinner" aria-label="搜索中" /></div>
          <UiSelect v-model="kind" width="120px" aria-label="类型" :options="[{ value: '', label: '全部类型' }, ...kindOptions]" />
          <UiSelect
            v-model="status"
            width="120px"
            aria-label="状态"
            :options="[
              { value: 'active', label: '当前有效' },
              { value: 'all', label: '包括历史' },
              { value: 'superseded', label: '已被更正' },
              { value: 'retracted', label: '已撤回' },
            ]"
          />
          <UiSelect
            v-model="review"
            width="140px"
            aria-label="复核"
            :options="[
              { value: '', label: '全部复核状态' },
              { value: 'pending', label: '待复核' },
              { value: 'keep', label: '复核保留' },
              { value: 'rewrite', label: '复核改写' },
              { value: 'retract', label: '复核撤回' },
            ]"
          />
          <UiSelect v-if="tags.length" v-model="tag" width="130px" aria-label="标签" :options="[{ value: '', label: '全部标签' }, ...tags.map((t) => ({ value: t.tag, label: `#${t.tag}`, hint: `${t.n} 条` }))]" />
          <UiSegmented v-model="scope" size="sm" aria-label="范围" :options="[{ value: 'all', label: '所有空间' }, { value: 'space', label: '当前空间' }]" />
        </div>

        <div v-if="loading && !memories.length" class="skeleton">
          <div v-for="i in 4" :key="i" class="sk-line" />
        </div>
        <div v-else-if="!memories.length" class="empty">
          <Icon name="brain" :size="34" />
          <h3>{{ sel.folder !== undefined ? "这里还没有记忆" : "没有符合条件的记忆" }}</h3>
          <p v-if="sel.folder !== undefined">把记忆拖到左边的目录上，或在记忆上点“移动”。</p>
          <p v-else>在问答里告诉助理一件事（“记住：…”），或保存聊天和文档让助理整理，长期有用的结论会出现在这里。</p>
        </div>

        <VirtualList :items="rows" :item-key="(r) => r.key" :estimate="96">
          <template #default="{ item: r }">
            <h2 v-if="r.kind === 'group'" class="subject"><Icon name="folder" :size="14" />{{ r.label }}</h2>
            <div v-else draggable="true" @dragstart="drag($event, r.m)">
              <MemoryCard
                :key="r.m.id"
                :m="r.m"
                movable
                @tag="tag = $event"
                @history="openCitation({ kind: 'memory', id: $event.id }, true)"
                @sources="openCitation({ kind: 'memory', id: $event.id }, true)"
                @tags="editTags($event)"
                @move="startMove($event)"
                @edit="startEdit($event)"
                @retract="retract($event)"
              >
                <template v-if="editing === r.m.id" #editor>
                  <div class="edit">
                    <textarea v-model="editText" class="textarea" rows="2" />
                    <div class="row"><span class="muted small">保存后旧内容标记为“已被更正”。</span><span class="spacer" /><button class="btn sm" @click="editing = null">取消</button><button class="btn primary sm" @click="supersede(r.m)">保存更正</button></div>
                  </div>
                </template>
              </MemoryCard>
            </div>
          </template>
        </VirtualList>
      </main>

      <Teleport to="body">
        <div v-if="moving" class="modal-overlay" @mousedown.self="moving = null" @keydown.esc="moving = null">
          <form class="modal" @submit.prevent="confirmMove">
            <header class="row"><strong>移动到目录</strong><span class="spacer" /><button type="button" class="btn ghost sm icon" aria-label="关闭" @click="moving = null"><Icon name="x" /></button></header>
            <p class="muted small clamp">{{ moving.subject ? moving.subject + "：" : "" }}{{ moving.content }}</p>
            <label class="field"><span>已有目录</span><UiSelect v-model="moveTo" aria-label="已有目录" :options="moveOptions" /></label>
            <label class="field"><span>或新目录（完整路径）</span><input v-model="moveNew" class="input" placeholder="如：工作/项目A/发布" /></label>
            <div class="row"><span class="spacer" /><button type="button" class="btn" @click="moving = null">取消</button><button class="btn primary">移动</button></div>
          </form>
        </div>
      </Teleport>
    </div>

    <template v-else-if="tab === 'recall'">
      <div v-if="!recall" class="skeleton"><div v-for="i in 4" :key="i" class="sk-line" /></div>
      <template v-else>
        <div class="row wrap qhead">
          <span class="badge ok">记忆 {{ recall.stats.total }} 条</span>
          <span class="badge">被召回过 {{ recall.stats.recalled }}</span>
          <span class="badge warn">从未召回 {{ recall.stats.neverRecalled }}</span>
          <span class="muted small">召回 {{ recall.stats.totalRecalls }} 次；其中真正用上 {{ recall.stats.usedRecalls }} 次（{{ pct(recall.stats.usedRecalls, recall.stats.totalRecalls) }}）<template v-if="recall.stats.passiveRecalls">；对话前自动带上 {{ recall.stats.passiveRecalls }} 次，用上 {{ recall.stats.passiveUsed }} 次（{{ pct(recall.stats.passiveUsed, recall.stats.passiveRecalls) }}）</template></span>
          <span class="spacer" />
          <UiSegmented v-model="recallSort" size="sm" aria-label="排序" :options="[
            { value: 'recalls', label: '召回最多' },
            { value: 'unused', label: '召回未用' },
            { value: 'never', label: '从未召回' },
            { value: 'recent', label: '最近召回' },
          ]" />
        </div>
        <p class="muted small">“用上”指该次运行的回答、消息或写入里引用了这条记忆。从未召回或召回了但从没用上的，是优先清理或改写的对象。</p>
        <div class="table-wrap card">
          <table class="rtable">
            <thead><tr><th class="grow">记忆</th><th>类型</th><th>召回</th><th>用上</th><th>命中率</th><th>最近召回</th></tr></thead>
            <tbody>
              <tr v-for="m in recall.memories" :key="m.id">
                <td class="grow"><router-link :to="`/memory`" class="ellipsis">{{ m.subject ? m.subject + "：" : "" }}{{ m.content }}</router-link><span v-if="m.agent" class="badge">{{ m.agent }} 专用</span></td>
                <td>{{ memoryKindLabel[m.kind] ?? m.kind }}</td>
                <td>{{ m.recalls }}</td>
                <td :class="{ warn: m.recalls && !m.used }">{{ m.used }}</td>
                <td>{{ effectiveness(m) === null ? "—" : effectiveness(m) + "%" }}</td>
                <td class="muted small">{{ m.lastRecalledAt ? fmtTime(m.lastRecalledAt) : "从未" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <template v-else-if="tab === 'gaps'">
      <div v-if="!gaps" class="skeleton"><div v-for="i in 3" :key="i" class="sk-line" /></div>
      <template v-else>
        <div class="row wrap qhead">
          <span class="muted small">从日常运行里按规则挑出的线索：回答说没找到、本人纠正了回答、飞书里对回答加的负面表情、失败的运行、被撤回或拦下的记忆。每晚整理时会逐条看能不能补（记下缺的事实、写经验或案例、建事项问你）。</span>
          <span class="spacer" />
          <UiSegmented v-model="gapDays" size="sm" aria-label="统计范围" :options="[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }]" />
        </div>
        <div v-if="dream" class="row wrap small dream">
          <span>每晚整理：</span>
          <span v-if="dream.enabled" class="badge ok">已开启{{ dream.next ? ` · 下次 ${fmtTime(dream.next)}` : "" }}</span>
          <span v-else class="badge warn">定时已关闭</span>
          <span class="muted">上次整理 <router-link v-if="dream.lastRun" :to="`/runs/${dream.lastRun.id}`">{{ relTime(dream.lastRun.at) }}</router-link><template v-else>还没有过</template></span>
          <span v-if="dream.digestExperiences" class="muted">· 存量整理写的经验记忆 {{ dream.digestExperiences }} 条待逐步合并</span>
          <span class="spacer" />
          <button class="btn sm" :disabled="dreaming" @click="dreamNow">立即整理一次</button>
        </div>
        <p v-if="dream && !dream.enabled && !gapsEmpty && !dreamHintSeen" class="small warn-text dream-hint">
          每晚整理关着，下面这些不足没人去补。可以先点“立即整理一次”看看报告，再到 设置 → 定时任务 打开。
          <button class="btn ghost sm" @click="hideDreamHint">知道了</button>
        </p>
        <div v-if="gapsEmpty" class="empty small">这段时间没有发现不足。</div>
        <template v-if="gaps.notFound.length">
          <h2 class="section-title">回答说没找到</h2>
          <a v-for="g in gaps.notFound" :key="g.messageId" href="#" class="rej gap" @click.prevent="openCitation({ kind: 'message', id: g.messageId }, true)">
            <div class="small muted">{{ fmtTime(g.at) }}</div>
            <p class="content">问：{{ g.question }}</p>
            <p class="content muted-ink">答：{{ g.answer }}</p>
          </a>
        </template>
        <template v-if="gaps.corrections.length">
          <h2 class="section-title">你纠正了回答</h2>
          <a v-for="g in gaps.corrections" :key="g.messageId" href="#" class="rej gap" @click.prevent="openCitation({ kind: 'message', id: g.messageId }, true)">
            <div class="small muted">{{ fmtTime(g.at) }}</div>
            <p class="content">你说：{{ g.said }}</p>
            <p class="content muted-ink">之前答：{{ g.answer }}</p>
          </a>
        </template>
        <template v-if="gaps.reactions?.negative.length">
          <h2 class="section-title">回答收到负面表情 <span class="muted small">同期正面 {{ gaps.reactions.positive }} 个</span></h2>
          <component :is="g.runId ? 'router-link' : 'div'" v-for="g in gaps.reactions.negative" :key="g.messageId + g.emoji + g.actorKind" :to="g.runId ? `/runs/${g.runId}` : undefined" class="rej gap">
            <div class="row small wrap"><span class="badge danger">{{ actorLabel[g.actorKind] ?? g.actorKind }} · {{ g.emoji }}</span><span class="muted">{{ fmtTime(g.at) }}</span></div>
            <p v-if="g.answer" class="content muted-ink">回答：{{ g.answer }}</p>
          </component>
        </template>
        <template v-if="gaps.failedRuns.length">
          <h2 class="section-title">失败的运行</h2>
          <router-link v-for="g in gaps.failedRuns" :key="g.kind" :to="`/runs/${g.lastRunId}`" class="rej gap">
            <div class="row small wrap"><span class="badge danger">{{ runKindLabel[g.kind] ?? g.kind }} {{ g.n }} 次</span></div>
            <p class="content muted-ink">最近一次：{{ g.lastError || "没有错误信息" }}</p>
          </router-link>
        </template>
        <template v-if="gaps.retracted.length">
          <h2 class="section-title">复核撤回的记忆</h2>
          <div v-for="g in gaps.retracted" :key="g.id" class="rej">
            <p class="content"><MemoryText :text="g.content" /></p>
            <p v-if="g.note" class="content muted-ink">{{ g.note }}</p>
          </div>
        </template>
        <p v-if="gaps.rejectedWrites.n" class="muted small">写入检查拦下 {{ gaps.rejectedWrites.n }} 条记忆（{{ Object.entries(gaps.rejectedWrites.codes).map(([k, v]) => `${codeLabel[k] ?? k} ${v}`).join("、") }}），详见“质量”。</p>
        <p v-if="gaps.passive.shown" class="muted small">对话前自动带上的记忆 {{ gaps.passive.shown }} 次，回答用上 {{ gaps.passive.used }} 次（{{ pct(gaps.passive.used, gaps.passive.shown) }}）。</p>
      </template>
    </template>

    <template v-else>
      <div v-if="!quality" class="skeleton"><div v-for="i in 3" :key="i" class="sk-line" /></div>
      <template v-else>
        <div class="row wrap qhead">
          <span class="badge" :class="quality.review.enabled ? 'ok' : 'warn'">{{ quality.review.enabled ? "复核已开启" : "复核未开启" }}</span>
          <span class="muted small">
            复核模型：{{ quality.review.profile ?? "按角色 memory-reviewer 的配置" }}{{ quality.review.model ? ` · ${quality.review.model}` : "" }}；待复核 {{ quality.pending }} 条；
            对比运行：{{ quality.compare.length ? quality.compare.map((c) => [c.profile, c.model].filter(Boolean).join(" · ")).join("、") : "未配置（设置 → Agent → 记忆质量）" }}
          </span>
          <span class="spacer" />
          <UiSegmented v-model="days" size="sm" aria-label="统计范围" :options="[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]" />
        </div>

        <h2 class="section-title">按模型</h2>
        <div v-if="!quality.stats.length" class="empty small">还没有可统计的记忆。</div>
        <div v-else class="table-wrap card">
          <table class="qtable">
            <thead>
              <tr>
                <th>后端 · 模型 · 强度</th>
                <th title="正式写入的记忆">写入</th>
                <th title="对比运行的提案（未写入）">对比提案</th>
                <th title="被写入检查拒绝的次数">检查拒绝</th>
                <th>复核保留</th>
                <th>复核改写</th>
                <th>复核撤回</th>
                <th>平均字数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in quality.stats" :key="s.model">
                <td class="model">{{ s.model }}</td>
                <td>{{ s.stored }}</td>
                <td>{{ s.shadow }}</td>
                <td>
                  {{ s.rejected }}<span v-if="s.rejected" class="muted small">（{{ Object.entries(s.rejectedBy).map(([k, v]) => `${codeLabel[k] ?? k} ${v}`).join("、") }}）</span>
                </td>
                <td>{{ s.kept }} <span class="muted small">{{ pct(s.kept, s.reviewed) }}</span></td>
                <td>{{ s.rewritten }} <span class="muted small">{{ pct(s.rewritten, s.reviewed) }}</span></td>
                <td>{{ s.retracted }} <span class="muted small">{{ pct(s.retracted, s.reviewed) }}</span></td>
                <td>{{ s.avgChars }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="quality.runs.length">
          <h2 class="section-title">同一份材料，不同模型怎么记</h2>
          <div v-for="c in quality.runs" :key="c.run.id" class="card pad cmp">
            <div class="row small muted"><strong class="ink">{{ c.run.title }}</strong><span>{{ fmtTime(c.run.created_at) }}</span><span>· {{ c.run.space_id }}</span></div>
            <div class="cols">
              <div class="col">
                <div class="col-head">正式运行 · {{ c.run.profile_id ?? "默认" }}{{ c.live[0]?.model ? ` · ${c.live[0].model}` : "" }}</div>
                <p v-if="!c.live.length && !c.rejected.length" class="muted small">没有写记忆</p>
                <div v-for="m in c.live" :key="m.id" class="prop">
                  <span v-if="m.review_verdict" class="badge" :class="verdictClass(m.review_verdict)">{{ reviewLabel[m.review_verdict] ?? m.review_verdict }}</span>
                  <MemoryText :text="m.content" />
                </div>
                <div v-for="(r, i) in c.rejected" :key="i" class="prop rejected"><span class="badge danger">拒绝：{{ r.codes.map((x) => codeLabel[x] ?? x).join("、") }}</span>{{ r.content }}</div>
              </div>
              <div v-for="s in c.shadows" :key="s.id" class="col">
                <div class="col-head">{{ s.title.replace(/^对比：/, "") }}<span v-if="s.status !== 'done'" class="badge">{{ statusLabel[s.status] ?? s.status }}</span></div>
                <p v-if="!s.writes.length && !s.rejected.length" class="muted small">没有写入</p>
                <div v-for="w in s.writes" :key="w.id" class="prop">
                  <span class="badge">{{ w.tool === "remember" ? "记忆" : w.tool === "supersede" ? "更正" : w.tool === "upsert_item" ? "事项" : w.tool }}</span>
                  <span v-if="w.verdict" class="badge" :class="verdictClass(w.verdict)" :title="w.verdict_note ?? ''">{{ reviewLabel[w.verdict] ?? w.verdict }}</span>
                  {{ w.args.content ?? w.args.title ?? w.args.text ?? JSON.stringify(w.args).slice(0, 120) }}
                </div>
                <div v-for="(r, i) in s.rejected" :key="i" class="prop rejected"><span class="badge danger">拒绝：{{ r.codes.map((x) => codeLabel[x] ?? x).join("、") }}</span>{{ r.content }}</div>
              </div>
            </div>
          </div>
        </template>

        <h2 class="section-title">最近被拒绝的写入</h2>
        <div v-if="!quality.rejections.length" class="empty small">最近没有被拒绝的记忆。</div>
        <div v-for="r in quality.rejections" :key="r.id" class="rej">
          <div class="row small wrap">
            <span v-for="c in r.codes" :key="c" class="badge danger">{{ codeLabel[c] ?? c }}</span>
            <span v-if="r.shadow" class="badge">对比运行</span>
            <span class="muted">{{ fmtTime(r.at) }} · {{ [r.agent_profile, r.model, r.effort].filter(Boolean).join(" · ") || "未知模型" }}</span>
          </div>
          <p class="content muted-ink">{{ r.content }}</p>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}
.side {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  display: grid;
  align-content: start;
  gap: 6px;
  margin-left: -8px;
}
.side-head {
  padding: 0 0 4px 8px;
  gap: 2px;
}
.side-note {
  padding: 4px 8px;
  margin: 0;
}
.main {
  min-width: 0;
}
.tree-toggle {
  display: none;
  margin-bottom: 12px;
  max-width: 100%;
}
.folder-head {
  display: grid;
  gap: 4px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.crumbs .ink {
  color: var(--ink);
  font-weight: 600;
}
.desc {
  margin: 0;
  color: var(--ink-2);
  font-size: 14px;
  flex: 1 1 260px;
  min-width: 0;
}
@media (max-width: 860px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .side {
    display: none;
    position: static;
    max-height: 50vh;
    margin: 0 0 14px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
  }
  .side.open {
    display: grid;
  }
  .tree-toggle {
    display: inline-flex;
  }
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 10vh;
}
.modal {
  width: min(520px, calc(100vw - 24px));
  max-height: 80vh;
  overflow: auto;
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
}
.add {
  display: grid;
  gap: 10px;
  margin-bottom: 18px;
}
.filters {
  margin-bottom: 20px;
  gap: 8px;
}
.search {
  flex: 1;
  min-width: 200px;
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--panel);
  color: var(--muted);
}
.search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  padding: 7px 0;
  color: var(--ink);
}
.group {
  margin-bottom: 26px;
}
.subject {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 650;
  padding: 18px 0 8px;
  margin: 0;
  overflow-wrap: anywhere;
}
.subject :deep(svg) {
  color: var(--muted);
  flex: none;
}
.mem {
  border-top: 1px solid var(--line);
  padding: 10px 0;
}
.head {
  gap: 6px;
}
.tag {
  color: var(--accent);
  cursor: pointer;
}
.tag:hover {
  text-decoration: underline;
}
.actions {
  opacity: 0.6;
  gap: 0;
}
.mem:hover .actions,
.mem:focus-within .actions {
  opacity: 1;
}
.content {
  margin: 6px 0 0;
  font-size: 15px;
  line-height: 1.7;
}
.note {
  margin: 4px 0 0;
}
.mem.superseded .content,
.mem.retracted .content {
  color: var(--muted);
  text-decoration: line-through;
}
.edit {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
.skeleton {
  display: grid;
  gap: 14px;
  padding: 8px 0;
}
.sk-line {
  height: 46px;
  border-radius: 8px;
  background: linear-gradient(90deg, var(--sunken), var(--hover), var(--sunken));
  background-size: 200% 100%;
  animation: sk 1.2s linear infinite;
}
@keyframes sk {
  to {
    background-position: -200% 0;
  }
}
.qhead {
  margin-bottom: 18px;
}
.dream {
  gap: 6px 10px;
  margin-bottom: 10px;
}
.dream-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.section-title {
  margin-top: 22px;
}
.table-wrap {
  overflow-x: auto;
}
.qtable {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}
.qtable th,
.qtable td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.qtable th {
  font-weight: 600;
  color: var(--ink-2);
  background: var(--sunken);
}
.qtable tr:last-child td {
  border-bottom: 0;
}
.qtable .model {
  font-family: var(--mono);
  font-size: 12.5px;
}
/* Recall list: reuse the quality table look, but wrap the memory text. */
.rtable {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
  table-layout: fixed;
}
.rtable th,
.rtable td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.rtable th {
  font-weight: 600;
  color: var(--ink-2);
  background: var(--sunken);
  white-space: nowrap;
}
.rtable tr:last-child td {
  border-bottom: 0;
}
.rtable td.grow,
.rtable th.grow {
  width: 52%;
}
.rtable td.grow .ellipsis {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  color: inherit;
}
.rtable td:not(.grow) {
  white-space: nowrap;
}
.cmp {
  margin-bottom: 12px;
}
.ink {
  color: var(--ink);
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
  margin-top: 10px;
}
.col-head {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-2);
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 6px;
  align-items: center;
}
.prop {
  font-size: 13.5px;
  line-height: 1.6;
  padding: 4px 0;
}
.prop .badge {
  margin-right: 4px;
}
.prop.rejected {
  color: var(--muted);
}
.rej {
  border-top: 1px solid var(--line);
  padding: 8px 0;
}
.gap {
  display: block;
  color: inherit;
  text-decoration: none;
}
.gap:hover .content {
  color: var(--accent);
}
.gap .content {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.muted-ink {
  color: var(--ink-2);
  font-size: 14px;
}
</style>
