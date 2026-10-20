<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { del, get, onServerEvent, patch, post, type Memory, type MemoryQuality } from "../api";
import MemoryCard from "../components/MemoryCard.vue";
import Icon from "../components/Icon.vue";
import UiSegmented from "../components/UiSegmented.vue";
import VirtualList from "../components/VirtualList.vue";
import UiSelect from "../components/UiSelect.vue";
import { promptDialog } from "../lib/dialog";
import { fmtTime, memoryKindLabel, openCitation, state, statusLabel, toast } from "../store";

const tab = ref<"list" | "quality" | "recall">("list");
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
const form = ref({ kind: "fact", subject: "", content: "", tags: "" });
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

async function load() {
  loading.value = true;
  try {
    const p = new URLSearchParams({ status: status.value });
    if (q.value.trim()) p.set("q", q.value.trim());
    if (kind.value) p.set("kind", kind.value);
    if (scope.value === "space") p.set("space", state.space);
    if (review.value) p.set("review", review.value);
    if (tag.value) p.set("tag", tag.value);
    memories.value = await get<Memory[]>(`/api/memories?${p}`);
  } finally {
    loading.value = false;
  }
}
async function loadTags() {
  tags.value = await get<{ tag: string; n: number }[]>(`/api/memory-tags${scope.value === "space" ? `?space=${state.space}` : ""}`).catch(() => []);
}
onMounted(() => (load(), loadTags()));
watch([kind, status, scope, review, tag], load);
watch(scope, loadTags);
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});
const off = onServerEvent((e) => {
  if (e.type === "changed" && e.entity === "memory") {
    void load();
    if (tab.value === "quality") void loadQuality();
  }
});
onBeforeUnmount(() => off());

const groups = computed(() => {
  const map = new Map<string, Memory[]>();
  for (const m of memories.value) {
    const key = m.subject || "（未分类）";
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
});
/** Subjects and their memories as one flat list, so long lists render only what is on screen. */
const rows = computed(() => groups.value.flatMap(([subject, ms]) => [{ kind: "subject" as const, key: `s:${subject}`, subject }, ...ms.map((m) => ({ kind: "memory" as const, key: m.id, m }))]));
const splitTags = (s: string) => s.split(/[,，\s]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean);

async function add() {
  if (!form.value.content.trim()) return;
  await post("/api/memories", { kind: form.value.kind, subject: form.value.subject, content: form.value.content, tags: splitTags(form.value.tags), space: state.space });
  form.value = { kind: "fact", subject: "", content: "", tags: "" };
  adding.value = false;
  toast("已记住", "ok");
  void loadTags();
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
type RecallStats = { total: number; recalled: number; neverRecalled: number; totalRecalls: number; usedRecalls: number; distinctRecalls: number; distinctUsed: number };
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
      <UiSegmented v-model="tab" aria-label="视图" :options="[{ value: 'list', label: '记忆' }, { value: 'recall', label: '召回' }, { value: 'quality', label: '质量' }]" />
      <button v-if="tab === 'list'" class="btn primary" @click="adding = !adding"><Icon name="plus" :size="15" />添加</button>
    </div>

    <template v-if="tab === 'list'">
      <form v-if="adding" class="card pad add" @submit.prevent="add">
        <div class="row wrap">
          <UiSelect v-model="form.kind" width="120px" aria-label="类型" :options="kindOptions" />
          <input v-model="form.subject" class="input" style="flex: 1; min-width: 160px" placeholder="主题，如“项目A 预算”“张三”" />
          <input v-model="form.tags" class="input" style="flex: 1; min-width: 140px" placeholder="标签（可选，空格分隔）" />
        </div>
        <textarea v-model="form.content" class="textarea" rows="2" placeholder="一句话：主语开头，写清对象、时间和数字" />
        <div class="row"><span class="muted small">保存到「{{ state.spaces.find((s) => s.id === state.space)?.name }}」</span><span class="spacer" /><button class="btn" type="button" @click="adding = false">取消</button><button class="btn primary">保存</button></div>
      </form>

      <div class="filters row wrap">
        <div class="search row"><Icon name="search" :size="15" /><input v-model="q" placeholder="搜索记忆" /></div>
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
        <h3>没有符合条件的记忆</h3>
        <p>在问答里告诉助理一件事（“记住：…”），或保存聊天和文档让助理整理，长期有用的结论会出现在这里。</p>
      </div>

      <VirtualList :items="rows" :item-key="(r) => r.key" :estimate="96">
        <template #default="{ item: r }">
        <h2 v-if="r.kind === 'subject'" class="subject">{{ r.subject }}</h2>
        <MemoryCard
          v-else
          :key="r.m.id"
          :m="r.m"
          @tag="tag = $event"
          @history="openCitation({ kind: 'memory', id: $event.id }, true)"
          @sources="openCitation({ kind: 'memory', id: $event.id }, true)"
          @tags="editTags($event)"
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
        </template>
      </VirtualList>
    </template>

    <template v-else-if="tab === 'recall'">
      <div v-if="!recall" class="skeleton"><div v-for="i in 4" :key="i" class="sk-line" /></div>
      <template v-else>
        <div class="row wrap qhead">
          <span class="badge ok">记忆 {{ recall.stats.total }} 条</span>
          <span class="badge">被召回过 {{ recall.stats.recalled }}</span>
          <span class="badge warn">从未召回 {{ recall.stats.neverRecalled }}</span>
          <span class="muted small">召回 {{ recall.stats.totalRecalls }} 次；其中真正用上 {{ recall.stats.usedRecalls }} 次（{{ pct(recall.stats.usedRecalls, recall.stats.totalRecalls) }}）</span>
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
                  {{ m.content }}
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
  font-size: 15px;
  font-weight: 650;
  padding: 18px 0 8px;
  margin: 0;
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
.muted-ink {
  color: var(--ink-2);
  font-size: 14px;
}
</style>
