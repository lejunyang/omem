<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { get, patch, post, type Card, type Source } from "../api";
import Icon from "../components/Icon.vue";
import Markdown from "../components/Markdown.vue";
import { fmtTime, openCitation, state, toast } from "../store";

const tab = ref<"review" | "goals" | "cards" | "generate">("review");
type Goal = { id: string; title: string; detail: string; spaceId: string; dailyNew: number; remindAt: string; status: string; text: string; stats: { total: number; due: number }; progress: { recall: number | null; streak: number; mature: number; reviews: number; weak: { front: string; lapses: number }[] } };
const goals = ref<Goal[]>([]);
const goalForm = ref({ title: "", detail: "", dailyNew: 10, remindAt: "20:30" });
async function loadGoals() {
  goals.value = await get<Goal[]>("/api/learn/goals");
}
async function addGoal() {
  if (!goalForm.value.title.trim()) return;
  await post("/api/learn/goals", { ...goalForm.value, spaceId: state.space });
  goalForm.value = { title: "", detail: "", dailyNew: 10, remindAt: "20:30" };
  toast("已添加学习目标：每天会从这个空间的新材料出卡，到点提醒复习", "ok");
  void loadGoals();
}
async function setGoalStatus(g: Goal, status: string) {
  await post("/api/learn/goals", { id: g.id, status });
  void loadGoals();
}
const due = ref<Card[]>([]);
const all = ref<Card[]>([]);
const stats = ref({ total: 0, due: 0, reviewedToday: 0 });
const flipped = ref(false);
const done = ref(0);
const newCard = ref({ front: "", back: "" });
const sources = ref<Source[]>([]);
const picked = ref<string[]>([]);
const focus = ref("");
const scope = ref<"space" | "all">("all");

async function load() {
  const space = scope.value === "space" ? `&space=${state.space}` : "";
  const r = await get<{ cards: Card[]; stats: typeof stats.value }>(`/api/cards?due=1${space}`);
  due.value = r.cards;
  stats.value = r.stats;
  all.value = (await get<{ cards: Card[] }>(`/api/cards?${space.slice(1)}`)).cards;
}
onMounted(load);
onMounted(loadGoals);
const current = computed(() => due.value[0]);

async function rate(rating: 1 | 2 | 3 | 4) {
  if (!current.value) return;
  await post(`/api/cards/${current.value.id}/review`, { rating });
  due.value.shift();
  done.value++;
  flipped.value = false;
  stats.value.reviewedToday++;
}
function onKey(e: KeyboardEvent) {
  if (tab.value !== "review" || !current.value || (e.target as HTMLElement).closest("input, textarea")) return;
  if (e.key === " ") (flipped.value = !flipped.value), e.preventDefault();
  else if (flipped.value && ["1", "2", "3", "4"].includes(e.key)) void rate(Number(e.key) as 1 | 2 | 3 | 4);
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

async function add() {
  if (!newCard.value.front.trim()) return;
  await post("/api/cards", { ...newCard.value, space: state.space });
  newCard.value = { front: "", back: "" };
  toast("已添加卡片", "ok");
  void load();
}
const importText = ref("");
async function importCards(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  const text = file ? await file.text() : importText.value;
  if (!text.trim()) return;
  const r = await post<{ created: number; skipped: number }>("/api/cards/import", { space: state.space, text });
  toast(`导入 ${r.created} 张，跳过重复 ${r.skipped} 张`, "ok");
  importText.value = "";
  void load();
}
async function suspend(c: Card) {
  await patch(`/api/cards/${c.id}`, { suspended: !c.suspended });
  void load();
}
async function loadSources() {
  sources.value = (await get<{ sources: Source[] }>(`/api/sources?space=${state.space}&limit=500`)).sources.filter((s) => s.kind !== "code");
}
async function generate() {
  if (!picked.value.length) return;
  await post("/api/learn/generate", { space: state.space, sourceIds: picked.value, focus: focus.value || undefined });
  picked.value = [];
  toast("助理正在阅读材料并生成卡片", "ok");
}
function openRef(r: string) {
  const m = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(r);
  if (m) openCitation({ kind: "source", id: m[1], from: m[2] ? +m[2] : undefined, to: m[3] ? +m[3] : undefined }, true);
}
const ratings = [
  { v: 1 as const, label: "忘了", cls: "danger" },
  { v: 2 as const, label: "困难", cls: "warn" },
  { v: 3 as const, label: "记得", cls: "" },
  { v: 4 as const, label: "简单", cls: "ok" },
];
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>学习</h1>
        <p>从材料里生成卡片，按遗忘曲线（FSRS）安排复习。今天已复习 {{ stats.reviewedToday }} 张，共 {{ stats.total }} 张。</p>
      </div>
      <span class="spacer" />
      <select v-model="scope" class="select" style="width: auto" @change="load"><option value="all">所有空间</option><option value="space">当前空间</option></select>
    </div>
    <div class="tabs">
      <button :class="{ on: tab === 'review' }" @click="tab = 'review'">复习 <span class="badge">{{ due.length }}</span></button>
      <button :class="{ on: tab === 'goals' }" @click="(tab = 'goals'), loadGoals()">学习目标 <span class="badge">{{ goals.filter((g) => g.status === "active").length }}</span></button>
      <button :class="{ on: tab === 'cards' }" @click="tab = 'cards'">全部卡片</button>
      <button :class="{ on: tab === 'generate' }" @click="(tab = 'generate'), loadSources()">从材料生成</button>
    </div>

    <section v-if="tab === 'review'">
      <div v-if="current" class="study">
        <div class="progress muted small">剩余 {{ due.length }} 张 · 本轮已复习 {{ done }} 张</div>
        <div class="flash card" :class="{ flipped }" @click="flipped = !flipped">
          <div class="front"><Markdown :source="current.front" :linkify="false" /></div>
          <div v-if="flipped" class="back"><Markdown :source="current.back" :linkify="false" /></div>
          <div v-if="!flipped" class="hint muted small">点击或按空格显示答案</div>
        </div>
        <div v-if="flipped" class="rates">
          <button v-for="r in ratings" :key="r.v" class="btn" :class="r.cls" @click="rate(r.v)">{{ r.label }} <kbd>{{ r.v }}</kbd></button>
        </div>
        <div v-if="current.sourceRefs.length" class="row small muted refs">来源：<a v-for="r in current.sourceRefs" :key="r" href="#" class="mono" @click.prevent="openRef(r)">{{ r.replace(/^src:/, "").slice(0, 28) }}</a></div>
      </div>
      <div v-else class="empty">
        <Icon name="check" :size="34" />
        <h3>{{ done ? `完成！本轮复习了 ${done} 张` : "现在没有需要复习的卡片" }}</h3>
        <p>打开任何材料点“生成卡片”，或在“从材料生成”中批量选择。英语材料会生成词汇、搭配和例句卡。</p>
      </div>
    </section>

    <section v-else-if="tab === 'goals'" class="stack">
      <div v-for="g in goals" :key="g.id" class="card pad goal" :class="{ paused: g.status !== 'active' }">
        <div class="row">
          <strong>{{ g.title }}</strong>
          <span class="badge">{{ g.status === "active" ? "进行中" : g.status === "paused" ? "暂停" : "完成" }}</span>
          <span class="spacer" />
          <button v-if="g.status === 'active'" class="btn ghost sm" @click="setGoalStatus(g, 'paused')">暂停</button>
          <button v-else class="btn ghost sm" @click="setGoalStatus(g, 'active')">继续</button>
        </div>
        <p v-if="g.detail" class="muted small">{{ g.detail }}</p>
        <div class="row wrap small metrics">
          <span>{{ g.stats.total }} 张卡 · {{ g.progress.mature }} 张已掌握</span>
          <span>{{ g.stats.due }} 张到期</span>
          <span>记住率 {{ g.progress.recall === null ? "—" : Math.round(g.progress.recall * 100) + "%" }}（近 30 天 {{ g.progress.reviews }} 次）</span>
          <span>连续 {{ g.progress.streak }} 天</span>
          <span class="muted">空间 {{ g.spaceId }} · 每天 {{ g.dailyNew }} 张新卡 · {{ g.remindAt }} 提醒</span>
        </div>
        <div v-if="g.progress.weak.length" class="small muted">反复忘记：{{ g.progress.weak.slice(0, 6).map((w) => w.front.slice(0, 24)).join("、") }}</div>
      </div>
      <form class="card pad stack" @submit.prevent="addGoal">
        <strong class="small">新的学习目标（材料放在当前空间：{{ state.space }}）</strong>
        <input v-model="goalForm.title" class="input" placeholder="学什么，如“英语：开会和写邮件的常用表达”" />
        <textarea v-model="goalForm.detail" class="textarea" rows="2" placeholder="想达到什么程度、喜欢什么样的卡片（可选）" />
        <div class="row small">
          每天 <input v-model.number="goalForm.dailyNew" class="input num" type="number" min="0" max="100" /> 张新卡，
          <input v-model="goalForm.remindAt" class="input num" placeholder="20:30" /> 提醒复习
          <span class="spacer" /><button class="btn primary sm">添加</button>
        </div>
        <p class="muted small">也可以直接对助理说“我想练英语口语，每天 15 张，晚上九点提醒我”。复习可以在这里，也可以在飞书 / Telegram 里发 /review。</p>
      </form>
    </section>

    <section v-else-if="tab === 'cards'" class="stack">
      <form class="card pad stack" @submit.prevent="add">
        <div class="grid2">
          <textarea v-model="newCard.front" class="textarea" rows="2" placeholder="正面：问题 / 提示" />
          <textarea v-model="newCard.back" class="textarea" rows="2" placeholder="背面：答案 / 解释" />
        </div>
        <div class="row"><span class="spacer" /><button class="btn primary sm">添加卡片</button></div>
      </form>
      <div class="row wrap small">
        <a class="btn sm" :href="`/api/cards/export.txt${scope === 'space' ? `?space=${state.space}` : ''}`" download><Icon name="upload" :size="14" />导出给 Anki</a>
        <label class="btn sm"><Icon name="plus" :size="14" />从 Anki 文本导入<input type="file" accept=".txt,.tsv,.csv" hidden @change="importCards" /></label>
        <span class="muted">Anki：文件 → 导出 → “纯文本格式的笔记”；导入时选择制表符分隔。</span>
      </div>
      <div class="cardlist">
        <div v-for="c in all" :key="c.id" class="cl" :class="{ suspended: c.suspended }">
          <div class="grow"><div>{{ c.front }}</div><div class="muted small">{{ c.back.slice(0, 120) }}</div></div>
          <div class="muted small right">下次 {{ fmtTime(c.dueAt, false) }}<br />复习 {{ c.reps }} 次</div>
          <button class="btn ghost sm" @click="suspend(c)">{{ c.suspended ? "恢复" : "暂停" }}</button>
        </div>
      </div>
    </section>

    <section v-else class="stack">
      <p class="muted">选择当前空间里的材料，助理会挑出值得记住的内容做成卡片（语言材料：词汇、短语、句型；知识材料：概念与区分）。</p>
      <label class="field"><span>学习重点（可选）</span><input v-model="focus" class="input" placeholder="例如：商务邮件常用表达；只要 B2 以上词汇" /></label>
      <div class="pick card">
        <label v-for="s in sources" :key="s.id" class="row pickrow"><input v-model="picked" type="checkbox" :value="s.id" /><span class="ellipsis">{{ s.title }}</span><span class="muted small">{{ s.kind }}</span></label>
        <div v-if="!sources.length" class="muted pad">当前空间没有可用材料。</div>
      </div>
      <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!picked.length" @click="generate"><Icon name="sparkles" :size="15" />生成卡片（{{ picked.length }}）</button></div>
    </section>
  </div>
</template>

<style scoped>
.goal.paused {
  opacity: 0.6;
}
.goal .metrics {
  gap: 14px;
  margin: 6px 0 2px;
}
.input.num {
  width: 70px;
  display: inline-block;
}
.study {
  max-width: 640px;
  margin: 10px auto;
  display: grid;
  gap: 16px;
}
.flash {
  min-height: 260px;
  padding: 28px 32px;
  cursor: pointer;
  display: grid;
  gap: 18px;
  align-content: center;
  box-shadow: var(--shadow);
}
.front :deep(.prose) {
  font-size: 19px;
  text-align: center;
}
.back {
  border-top: 1px dashed var(--line-strong);
  padding-top: 18px;
}
.hint {
  text-align: center;
}
.rates {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.rates .warn {
  color: var(--warn);
}
.rates .ok {
  color: var(--ok);
}
.refs {
  gap: 6px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.cardlist {
  display: grid;
}
.cl {
  display: flex;
  gap: 12px;
  align-items: center;
  border-top: 1px solid var(--line);
  padding: 10px 0;
}
.cl.suspended {
  opacity: 0.5;
}
.grow {
  flex: 1;
  min-width: 0;
}
.right {
  text-align: right;
}
.pick {
  max-height: 360px;
  overflow: auto;
  padding: 6px;
}
.pickrow {
  padding: 6px 8px;
  border-radius: 6px;
}
.pickrow:hover {
  background: var(--hover);
}
.pad {
  padding: 12px;
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
  .rates {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
