<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { get, post, put } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import VirtualList from "../components/VirtualList.vue";
import { confirmDialog } from "../lib/dialog";
import { fmtTime, loadSpaces, relTime, state, toast } from "../store";

/**
 * Feishu knowledge bases the owner can see (src/channels/lark-knowledge.ts): what the scout proposes
 * for each (a space, a new space, ignore, later), the owner's decision, and the nightly reading.
 */
type Status = "new" | "proposed" | "later" | "mapped" | "ignored";
type Priority = "high" | "normal" | "low";
type Level = "focus" | "normal" | "reference";
type NewSpace = { id: string; name: string; kind: "project" | "topic" | "learning"; description: string };
type Proposal = { action: "map" | "create" | "ignore" | "later"; space?: string; newSpace?: NewSpace; priority: Priority; level: Level; reason: string; at: string };
type Kb = {
  id: string;
  name: string;
  description: string;
  spaceType: string | null;
  goneAt: string | null;
  sample: { roots: { title: string }[]; rootCount: number; more: boolean; error?: string } | null;
  status: Status;
  targetSpace: string | null;
  priority: Priority;
  level: Level;
  dailyShare: number | null;
  proposal: Proposal | null;
  decidedBy: string | null;
  paused: boolean;
  progress: { nodes: number; captured: number; read: number; known: number; skipped: number; failed: number; lastReadAt: string | null; crawl: { status: string; queued: number } | null };
};
type Report = { at: string; found?: number; added?: number; gone?: number; walked?: number; errors?: string[]; skipped?: string; read?: number; budget?: number };
type Overview = {
  counts: Record<Status | "gone", number>;
  discovery: { running: boolean; last: Report | null };
  reading: { running: boolean; last: Report | null };
  settings: { direction: string; autoApply: boolean; dailyDocs: number };
  kbs: Kb[];
};

const STATUS: Record<Status, string> = { new: "还没判断", proposed: "待确认", later: "先放着", mapped: "已归入", ignored: "不读" };
const PRIORITY: Record<Priority, string> = { high: "高", normal: "中", low: "低" };
const LEVEL: Record<Level, string> = { focus: "重点关注", normal: "一般关注", reference: "仅检索" };
const TYPE: Record<string, string> = { team: "团队", person: "个人", my_library: "个人文档库" };
const priorityOptions = (["high", "normal", "low"] as Priority[]).map((v) => ({ value: v, label: `优先级 ${PRIORITY[v]}` }));
const levelOptions = (["focus", "normal", "reference"] as Level[]).map((v) => ({ value: v, label: LEVEL[v] }));
const kindOptions = [{ value: "topic", label: "领域" }, { value: "project", label: "项目" }, { value: "learning", label: "学习" }];

const data = ref<Overview | null>(null);
const loading = ref(true);
const filter = ref<Status | "gone" | "all">("all");
const busy = ref<string | null>(null);

async function load() {
  try {
    data.value = await get<Overview>("/api/lark/kb");
    form.direction = data.value.settings.direction;
    form.dailyDocs = data.value.settings.dailyDocs;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}
let firstLoad = true;
watch(data, (d) => {
  if (!d || !firstLoad) return;
  firstLoad = false;
  filter.value = d.counts.proposed ? "proposed" : d.counts.mapped ? "mapped" : "all";
});

// While discovery or reading runs in the background, look again every few seconds.
let timer: ReturnType<typeof setInterval> | null = null;
watch(
  () => !!(data.value?.discovery.running || data.value?.reading.running),
  (running) => {
    if (running && !timer) timer = setInterval(load, 5000);
    if (!running && timer) (clearInterval(timer), (timer = null));
  },
);
onMounted(load);
onBeforeUnmount(() => timer && clearInterval(timer));

const filterOptions = computed(() => {
  const c = data.value?.counts;
  const n = (k: Status | "gone") => (c?.[k] ? ` ${c[k]}` : "");
  return [
    { value: "proposed" as const, label: `待确认${n("proposed")}` },
    { value: "mapped" as const, label: `已归入${n("mapped")}` },
    { value: "new" as const, label: `还没判断${n("new")}` },
    { value: "later" as const, label: `先放着${n("later")}` },
    { value: "ignored" as const, label: `不读${n("ignored")}` },
    { value: "gone" as const, label: `已看不到${n("gone")}` },
    { value: "all" as const, label: "全部" },
  ];
});
const shown = computed(() => {
  const list = data.value?.kbs ?? [];
  if (filter.value === "all") return list.filter((k) => !k.goneAt);
  if (filter.value === "gone") return list.filter((k) => !!k.goneAt);
  return list.filter((k) => !k.goneAt && k.status === filter.value);
});

const spaceOptions = computed(() => state.spaces.filter((s) => s.kind !== "repo" && s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name })));
const spaceName = (id: string | null | undefined) => (id ? (state.spaces.find((s) => s.id === id)?.name ?? id) : "");

function proposalText(p: Proposal) {
  if (p.action === "create") return `新建空间「${p.newSpace?.name}」`;
  if (p.action === "map") return `归入「${spaceName(p.space)}」`;
  return p.action === "ignore" ? "不读" : "先放着";
}
const sampleText = (k: Kb) => {
  const s = k.sample;
  if (!s) return "还没看过目录";
  if (s.error) return `目录读不了：${s.error}`;
  if (!s.roots.length) return "目录是空的";
  return `${s.roots.slice(0, 8).map((r) => r.title || "（未命名）").join("、")}${s.rootCount > 8 || s.more ? ` 等 ${s.rootCount}${s.more ? "+" : ""} 项` : ""}`;
};

async function act(k: Kb, body: Record<string, unknown>, done?: string) {
  busy.value = k.id;
  try {
    const r = await post<{ error?: string | null }>(`/api/lark/kb/${encodeURIComponent(k.id)}`, body);
    if (body.action === "create" || (body.action === "accept" && k.proposal?.action === "create")) await loadSpaces();
    toast(r?.error ? `已处理，目录暂时没读到：${r.error}（夜里会再试）` : (done ?? "已处理"), r?.error ? "error" : "ok");
    editing.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
  }
}
async function ignore(k: Kb) {
  if (k.status === "mapped" && !(await confirmDialog("不再读这个知识库？", { message: `《${k.name}》已经读进来的文档留在空间里；之后不再读新的。可以在“不读”里恢复。`, okText: "不读", danger: true }))) return;
  await act(k, { action: "ignore" }, "不再读这个知识库");
}

// Changing the target: an existing space or a new one, with priority and initial level.
const editing = ref<string | null>(null);
const edit = reactive({ mode: "map" as "map" | "create", space: "", priority: "normal" as Priority, level: "normal" as Level, id: "", name: "", kind: "topic" as NewSpace["kind"], description: "" });
function startEdit(k: Kb) {
  const p = k.proposal;
  Object.assign(edit, {
    mode: p?.action === "create" && k.status !== "mapped" ? "create" : "map",
    space: k.targetSpace ?? (p?.action === "map" ? p.space : "") ?? "",
    priority: k.status === "mapped" ? k.priority : (p?.priority ?? "normal"),
    level: k.status === "mapped" ? k.level : (p?.level ?? "normal"),
    id: p?.newSpace?.id ?? "",
    name: p?.newSpace?.name ?? k.name,
    kind: p?.newSpace?.kind ?? "topic",
    description: p?.newSpace?.description ?? k.description,
  });
  editing.value = k.id;
}
function saveEdit(k: Kb) {
  if (edit.mode === "map") {
    if (!edit.space) return toast("选一个空间", "error");
    return act(k, { action: "map", space: edit.space, priority: edit.priority, level: edit.level }, `已归入「${spaceName(edit.space)}」，夜里开始读`);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(edit.id.trim())) return toast("空间 id 用小写字母、数字和连字符，至少两个字符", "error");
  if (!edit.name.trim() || !edit.description.trim()) return toast("写上新空间的名称和一句说明", "error");
  return act(k, { action: "create", newSpace: { id: edit.id.trim(), name: edit.name.trim(), kind: edit.kind, description: edit.description.trim() }, priority: edit.priority, level: edit.level }, `已新建空间「${edit.name.trim()}」并归入`);
}
async function setShare(k: Kb, raw: string) {
  const v = raw.trim();
  const n = v === "" ? null : Math.max(0, Math.min(2000, Math.round(Number(v))));
  if (n !== null && !Number.isFinite(n)) return;
  await act(k, { action: "update", dailyShare: n }, n === null ? "按优先级分每晚的篇数" : `每晚固定读 ${n} 篇`);
}

// Settings: the direction the scout follows, auto-apply, the nightly budget.
const form = reactive({ direction: "", dailyDocs: 30 });
const settingsOpen = ref(false);
async function saveSettings(patch: Record<string, unknown>, note = "已保存") {
  try {
    const r = await put<{ settings: Overview["settings"] }>("/api/lark/kb/settings", patch);
    if (data.value) data.value.settings = r.settings;
    toast(note, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function discover() {
  try {
    const r = await post<{ started: boolean }>("/api/lark/kb/discover");
    toast(r.started ? "开始发现：列出知识库，新出现的浅读一层目录，然后交给助理提建议" : "已经在发现了", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function readNow() {
  try {
    const r = await post<{ started: boolean }>("/api/lark/kb/read", {});
    toast(r.started ? "开始读一批，读完交给整理" : "已经在读了", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const lastDiscovery = computed(() => {
  const d = data.value?.discovery.last;
  if (!d) return "还没发现过";
  if (d.skipped) return `${relTime(d.at)}：${d.skipped}`;
  return `${relTime(d.at)}发现 ${d.found ?? 0} 个，新出现 ${d.added ?? 0}${d.gone ? `，看不到了 ${d.gone}` : ""}`;
});
const lastReading = computed(() => {
  const r = data.value?.reading.last;
  if (!r) return "还没读过";
  if (r.skipped) return `${relTime(r.at)}：${r.skipped}`;
  return `${relTime(r.at)}读了 ${r.read ?? 0} 篇（每晚 ${r.budget ?? 0} 篇）`;
});
</script>

<template>
  <div class="page kb-page">
    <div class="page-head">
      <div class="grow">
        <router-link to="/sources" class="back small"><Icon name="left" :size="14" />原件</router-link>
        <h1>飞书知识库</h1>
        <p>你在飞书里能看到的知识库。助理按你写的方向提议放进哪个空间；确认后，每晚从已归入的知识库读一些文档，读进对应空间再整理。只读飞书，不会改动知识库。</p>
      </div>
      <div class="row wrap gap">
        <button class="btn sm" :disabled="data?.discovery.running" @click="discover"><Icon name="search" :size="14" />{{ data?.discovery.running ? "发现中…" : "立即发现" }}</button>
        <button class="btn sm" :disabled="data?.reading.running || !data?.counts.mapped" @click="readNow"><Icon name="play" :size="14" />{{ data?.reading.running ? "读取中…" : "现在读一批" }}</button>
      </div>
    </div>

    <Skeleton v-if="loading" variant="cards" :rows="4" />
    <template v-else-if="data">
      <div class="card pad stack status">
        <div class="row wrap gap small">
          <span class="muted">发现：{{ lastDiscovery }}</span>
          <span class="muted">夜读：{{ lastReading }}</span>
          <span class="spacer" />
          <button class="btn ghost sm" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen"><Icon name="settings" :size="14" />{{ settingsOpen ? "收起设置" : "设置" }}</button>
        </div>
        <p v-for="(e, i) in data.discovery.last?.errors ?? []" :key="i" class="muted small">{{ e }}</p>
        <div v-if="settingsOpen" class="stack settings">
          <label class="field">
            <span>你的方向（助理按它判断哪些知识库值得读、放进哪里）</span>
            <textarea v-model="form.direction" class="textarea" rows="3" placeholder="例如：我负责项目 A 的退款和结算；想补齐支付风控的背景知识；行政、活动类不用读" @change="saveSettings({ direction: form.direction }, '已保存方向，先放着的会重新判断')" />
          </label>
          <div class="row wrap gap">
            <label class="field share">
              <span>每晚读几篇</span>
              <input v-model.number="form.dailyDocs" class="input sm" type="number" inputmode="numeric" min="0" max="2000" @change="saveSettings({ dailyDocs: Math.max(0, Math.min(2000, Math.round(Number(form.dailyDocs) || 0))) }, '已保存每晚的篇数')" />
            </label>
            <UiCheckbox :model-value="data.settings.autoApply" switch @change="(v) => saveSettings({ autoApply: v }, v ? '建议会直接生效，处理后通知你' : '建议等你确认')">建议直接生效（不等确认）</UiCheckbox>
          </div>
          <p class="muted small">定时：每周日发现一次，每晚 2:30 读取，时间在设置 → 定时任务里改。空间里已有的文档不重复读，读到的按空间交给整理。</p>
        </div>
      </div>

      <div class="filters">
        <UiSegmented v-model="filter" size="sm" aria-label="按状态筛选" :options="filterOptions" />
      </div>

      <div v-if="!data.kbs.length" class="empty">
        <Icon name="book" :size="32" />
        <h3>还没有发现过知识库</h3>
        <p>点“立即发现”列出你能看到的知识库（需要运行 omem 的电脑上 lark-cli 已登录）。</p>
      </div>
      <div v-else-if="!shown.length" class="empty small"><p>这一类没有知识库。</p></div>
      <VirtualList v-else :items="shown" :item-key="(k) => k.id" :estimate="150">
        <template #default="{ item: k }">
          <article class="card pad kb" :class="{ gone: !!k.goneAt }">
            <div class="row wrap gap head">
              <strong class="title">《{{ k.name || "（无名称）" }}》</strong>
              <span v-if="k.spaceType" class="badge">{{ TYPE[k.spaceType] ?? k.spaceType }}</span>
              <span v-if="k.goneAt" class="badge danger">已看不到</span>
              <span v-else class="badge" :class="{ accent: k.status === 'proposed', ok: k.status === 'mapped' }">{{ STATUS[k.status] }}</span>
              <span v-if="k.paused" class="badge warn">已暂停</span>
            </div>
            <p v-if="k.description" class="muted small desc">{{ k.description }}</p>
            <p class="muted small sample">目录：{{ sampleText(k) }}</p>

            <div v-if="k.proposal && (k.status === 'proposed' || k.status === 'later' || k.status === 'new')" class="proposal small">
              <div><strong>建议：{{ proposalText(k.proposal) }}</strong><template v-if="k.proposal.action === 'map' || k.proposal.action === 'create'"> · 优先级{{ PRIORITY[k.proposal.priority] }} · 初始{{ LEVEL[k.proposal.level] }}</template></div>
              <div v-if="k.proposal.newSpace" class="muted">新空间：{{ k.proposal.newSpace.id }} · {{ k.proposal.newSpace.description }}</div>
              <div class="muted">{{ k.proposal.reason }}</div>
            </div>

            <div v-if="k.status === 'mapped' && !k.goneAt" class="mapped small">
              <div class="row wrap gap">
                <span>归入「{{ spaceName(k.targetSpace) }}」</span>
                <UiSelect :model-value="k.priority" size="sm" width="110px" aria-label="优先级" :options="priorityOptions" :disabled="busy === k.id" @change="(v) => act(k, { action: 'update', priority: v }, '已改优先级')" />
                <UiSelect :model-value="k.level" size="sm" width="110px" aria-label="初始关注程度" :options="levelOptions" :disabled="busy === k.id" @change="(v) => act(k, { action: 'update', level: v }, '已改关注程度')" />
                <label class="pace muted">每晚<input class="input sm num" type="number" inputmode="numeric" min="0" max="2000" :value="k.dailyShare ?? ''" placeholder="自动" aria-label="每晚固定读几篇，空着按优先级分" @change="setShare(k, ($event.target as HTMLInputElement).value)" />篇</label>
              </div>
              <div class="muted">
                已读 {{ k.progress.read }} 篇<template v-if="k.progress.known"> · 空间里已有 {{ k.progress.known }}</template><template v-if="k.progress.failed"> · 失败 {{ k.progress.failed }}</template> · 目录里见过 {{ k.progress.nodes }} 个页面<template v-if="k.progress.crawl"> · {{ k.progress.crawl.status === "done" ? "已读完，下周再看有没有新页面" : `还有 ${k.progress.crawl.queued} 项待看` }}</template><template v-if="k.progress.lastReadAt"> · 最近 {{ fmtTime(k.progress.lastReadAt) }}</template>
              </div>
            </div>

            <div v-if="editing === k.id" class="edit stack">
              <UiSegmented v-model="edit.mode" size="sm" aria-label="放进哪里" :options="[{ value: 'map', label: '已有空间' }, { value: 'create', label: '新建空间' }]" />
              <div v-if="edit.mode === 'map'" class="row wrap gap">
                <UiSelect v-model="edit.space" size="sm" width="200px" aria-label="空间" placeholder="选空间" :options="spaceOptions" />
              </div>
              <div v-else class="grid">
                <label class="field"><span>空间 id</span><input v-model="edit.id" class="input sm" placeholder="如 refund" /></label>
                <label class="field"><span>名称</span><input v-model="edit.name" class="input sm" /></label>
                <div class="field"><span>类型</span><UiSelect v-model="edit.kind" size="sm" aria-label="空间类型" :options="kindOptions" /></div>
                <label class="field wide"><span>这个空间放什么</span><input v-model="edit.description" class="input sm" /></label>
              </div>
              <div class="row wrap gap">
                <UiSelect v-model="edit.priority" size="sm" width="110px" aria-label="优先级" :options="priorityOptions" />
                <UiSelect v-model="edit.level" size="sm" width="110px" aria-label="初始关注程度" :options="levelOptions" />
                <span class="spacer" />
                <button class="btn ghost sm" @click="editing = null">取消</button>
                <button class="btn primary sm" :disabled="busy === k.id" @click="saveEdit(k)">确定</button>
              </div>
            </div>

            <div v-else-if="!k.goneAt" class="row wrap gap actions">
              <template v-if="k.status === 'proposed'">
                <button class="btn primary sm" :disabled="busy === k.id" @click="act(k, { action: 'accept' }, k.proposal?.action === 'create' ? '已新建空间并归入，夜里开始读' : '已采纳')">采纳</button>
                <button class="btn ghost sm" @click="startEdit(k)">改目标</button>
                <button v-if="k.proposal?.action !== 'ignore'" class="btn ghost sm" :disabled="busy === k.id" @click="ignore(k)">不读</button>
                <button v-if="k.proposal?.action !== 'later'" class="btn ghost sm" :disabled="busy === k.id" @click="act(k, { action: 'later' }, '先放着')">先放着</button>
              </template>
              <template v-else-if="k.status === 'mapped'">
                <button class="btn ghost sm" :disabled="busy === k.id || k.paused || data.reading.running" @click="act(k, { action: 'read' }, '开始读一批')"><Icon name="play" :size="13" />现在读一批</button>
                <button class="btn ghost sm" :disabled="busy === k.id" @click="act(k, { action: k.paused ? 'resume' : 'pause' }, k.paused ? '继续每晚读取' : '已暂停')">{{ k.paused ? "继续" : "暂停" }}</button>
                <button class="btn ghost sm" @click="startEdit(k)">改目标</button>
                <button class="btn ghost sm danger" :disabled="busy === k.id" @click="ignore(k)">不读</button>
              </template>
              <template v-else-if="k.status === 'ignored'">
                <button class="btn ghost sm" :disabled="busy === k.id" @click="act(k, { action: 'reset' }, '已交给助理重新判断')">重新判断</button>
                <button class="btn ghost sm" @click="startEdit(k)">归入空间</button>
              </template>
              <template v-else>
                <button class="btn ghost sm" @click="startEdit(k)">归入空间</button>
                <button class="btn ghost sm" :disabled="busy === k.id" @click="ignore(k)">不读</button>
              </template>
            </div>
          </article>
        </template>
      </VirtualList>
    </template>
  </div>
</template>

<style scoped>
.kb-page {
  max-width: 900px;
}
.grow {
  flex: 1 1 320px;
  min-width: 0;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--muted);
  margin-bottom: 4px;
}
.gap {
  gap: 8px;
}
.status {
  margin-bottom: 14px;
  gap: 8px;
}
.settings {
  gap: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.share {
  width: 140px;
}
.filters {
  margin-bottom: 12px;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.kb {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
  min-width: 0;
}
.kb.gone {
  opacity: 0.65;
}
.head {
  align-items: center;
  min-width: 0;
}
.title {
  min-width: 0;
  overflow-wrap: anywhere;
}
.desc,
.sample {
  margin: 0;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.proposal {
  background: var(--sunken);
  border-radius: 8px;
  padding: 8px 10px;
  display: grid;
  gap: 2px;
  overflow-wrap: anywhere;
}
.mapped {
  display: grid;
  gap: 6px;
  align-items: center;
}
.pace {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.num {
  width: 64px;
}
.edit {
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--line);
  border-radius: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
}
.grid .wide {
  grid-column: 1 / -1;
}
.actions {
  padding-top: 2px;
}
</style>
