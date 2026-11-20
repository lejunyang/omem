<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, onServerResync, post, type Run } from "../api";
import BarChart from "../components/charts/BarChart.vue";
import FlowBoard from "../components/FlowBoard.vue";
import Icon from "../components/Icon.vue";
import PluginSlots from "../components/PluginSlots.vue";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import WorkChange from "../components/WorkChange.vue";
import WorkLine from "../components/WorkLine.vue";
import WorkSheet from "../components/WorkSheet.vue";
import WorkWaiting, { type Waiting } from "../components/WorkWaiting.vue";
import { promptDialog } from "../lib/dialog";
import { dayKey, fmt } from "../lib/time";
import { dayKeyLabel, ORIGIN_FILTERS, TYPE_FILTERS, type ChangeLite, type ItemLite, type Line, type NextLite, type Place } from "../lib/work";
import { fmtTime, itemKindLabel, relTime, runKindLabel, state, statusLabel, toast } from "../store";

/**
 * The work page, the start page (docs/v2/status.md “工作线”): what the owner is pushing on this month,
 * three ways. 按工作线: a card per line with where it stands, its last key changes ending in its next
 * steps and its work items. 按时间: every key change by day, filtered by kind and where it came from.
 * 按阶段: items moving through flows by stage (the flow board). On the right, everything waiting for the
 * owner; below, items under no line and what ran lately.
 */
type View = "lines" | "time" | "stage";
type Overview = { lines: Line[]; loose: ItemLite[]; waiting: Waiting; places: Place[] };
type HomeBits = { runs: Run[]; study: { total: number; due: number; reviewedToday: number }; notifications: { id: string; at: string; title: string; body: string; link: string | null; unread?: boolean }[] };

const route = useRoute(), router = useRouter();
const view = computed<View>({
  get: () => (["time", "stage"].includes(String(route.query.view)) ? (route.query.view as View) : "lines"),
  set: (v) => void router.replace({ path: "/", query: v === "lines" ? {} : { view: v } }),
});
const views = [{ value: "lines" as View, label: "按工作线" }, { value: "time" as View, label: "按时间" }, { value: "stage" as View, label: "按阶段" }];

const data = ref<Overview | null>(null), error = ref("");
const home = ref<HomeBits | null>(null);
let seq = 0;
async function load() {
  const n = ++seq;
  try {
    const d = await get<Overview>("/api/work");
    if (n === seq) { data.value = d; error.value = ""; }
  } catch (e) {
    if (n === seq) error.value = (e as Error).message;
  }
}
async function loadHome() {
  home.value = await get<HomeBits>("/api/home").catch(() => home.value);
}
void load();
void loadHome();

// ---- 按时间 ------------------------------------------------------------------------------------
const types = ref<string[]>([]), origins = ref<string[]>([]);
const acts = ref<{ days: { date: string; count: number }[]; items: ChangeLite[] } | null>(null);
let actSeq = 0;
async function loadActs() {
  if (view.value !== "time") return;
  const n = ++actSeq;
  const type = TYPE_FILTERS.filter((f) => types.value.includes(f.key)).flatMap((f) => f.types).join(",");
  const q = new URLSearchParams({ ...(type ? { type } : {}), ...(origins.value.length ? { origin: origins.value.join(",") } : {}) });
  try {
    const qs = q.toString();
    const r = await get<NonNullable<typeof acts.value>>(`/api/work/activities${qs ? `?${qs}` : ""}`);
    if (n === actSeq) acts.value = r;
  } catch (e) {
    if (n === actSeq) toast((e as Error).message, "error");
  }
}
watch([view, types, origins], () => void loadActs(), { immediate: true, deep: true });
const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
const day = computed(() => (typeof route.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(route.query.day) ? route.query.day : ""));
const today = computed(() => dayKey(Date.now()));
const shownLimit = ref(60);
watch([types, origins, day], () => (shownLimit.value = 60), { deep: true });
const filtered = computed(() => (acts.value?.items ?? []).filter((c) => !day.value || dayKey(c.at) === day.value));
const byDay = computed(() => {
  const out: { day: string; items: ChangeLite[] }[] = [];
  for (const c of filtered.value.slice(0, shownLimit.value)) {
    const d = dayKey(c.at);
    const last = out[out.length - 1];
    if (last?.day === d) last.items.push(c);
    else out.push({ day: d, items: [c] });
  }
  return out;
});
const dayCount = (d: string) => filtered.value.filter((c) => dayKey(c.at) === d).length;
const chart = computed(() => {
  const days = acts.value?.days ?? [];
  return {
    labels: days.map((d) => d.date.slice(5).replace("-", "/")),
    series: [{ name: "变化", values: days.map((d) => d.count) }],
    links: days.map((d) => `#/?view=time&day=${d.date}`),
    highlight: day.value ? day.value.slice(5).replace("-", "/") : undefined,
  };
});

// ---- the side sheet ----------------------------------------------------------------------------
const sheet = ref<{ change?: ChangeLite; next?: NextLite; lineTitle?: string } | null>(null);
const openChange = (c: ChangeLite) => (sheet.value = { change: c });
const openNext = (n: NextLite, l: Line) => (sheet.value = { next: n, lineTitle: l.title });
function changed() {
  void load();
  void loadActs();
}

// ---- live ---------------------------------------------------------------------------------------
let timer: ReturnType<typeof setTimeout> | undefined;
function soon() {
  clearTimeout(timer);
  timer = setTimeout(() => { void load(); void loadActs(); }, 400);
}
const off = onServerEvent((e) => {
  if ((e.type === "changed" && e.entity === "item") || e.type === "ask") soon();
  if (e.type === "run" || e.type === "notification") void loadHome();
});
const offResync = onServerResync(() => { void load(); void loadHome(); void loadActs(); });
onBeforeUnmount(() => { ++seq; ++actSeq; off(); offResync(); clearTimeout(timer); });

// ---- the rest ------------------------------------------------------------------------------------
const dateLine = computed(() => fmt(Date.now(), { month: "long", day: "numeric", weekday: "long" }));
const todayChanges = computed(() => (data.value?.lines ?? []).reduce((n, l) => n + l.counts.today, 0));
const looseShown = computed(() => (data.value?.loose ?? []).slice(0, 30));
const looseWhen = (i: ItemLite) => [itemKindLabel[i.kind] ?? i.kind, i.waitingOn ? `等 ${i.waitingOn}` : "", i.dueAt ? `截止 ${fmtTime(i.dueAt)}` : "", i.remindAt ? `提醒 ${fmtTime(i.remindAt)}` : ""].filter(Boolean).join(" · ");
const looseIcon = (k: string) => ({ waiting: "user", reminder: "bell", decision: "alert", watch: "eye" })[k] ?? "checkbox";
function toWaiting() {
  document.getElementById("work-waiting")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function newLine() {
  const r = await promptDialog("新建工作线", {
    message: "这几周你在推进的一件事，比如“退款改造”。建好后把相关的事项挂到它下面，每天整理一句现状和下一步。",
    fields: [{ id: "title", label: "名字", value: "", required: true, maxLength: 80 }, { id: "goal", label: "目标（一句话，可不填）", value: "", maxLength: 400 }],
    okText: "建",
  });
  if (!r?.title?.trim()) return;
  try {
    const made = await post<{ id: string }>("/api/items", { kind: "line", title: r.title.trim(), detail: r.goal?.trim() ?? "", space: state.space });
    void router.push(`/work/${made.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// The question box on the right: a question goes to the assistant like on 问答.
const question = ref("");
const asking = ref(false);
const prompts = ["今天有什么要我处理的？", "这周各条线进展怎么样？", "哪条线有风险，卡在哪？"];
async function ask(text = question.value) {
  if (!text.trim() || asking.value) return;
  asking.value = true;
  try {
    const r = await post<{ conversationId: string }>("/api/ask", { text, space: state.space });
    void router.push(`/ask/${r.conversationId}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    asking.value = false;
  }
}
</script>

<template>
  <div class="page work">
    <header class="top">
      <div class="title">
        <div class="muted small">{{ dateLine }}</div>
        <h1>本月在推进</h1>
        <p v-if="data" class="muted small">{{ data.lines.length }} 条工作线{{ todayChanges ? ` · 今天 ${todayChanges} 条变化` : "" }}</p>
      </div>
      <span class="spacer" />
      <div class="tools row wrap">
        <button v-if="data?.waiting.total" type="button" class="confirm-pill" @click="toWaiting"><Icon name="inbox" :size="14" />共 {{ data.waiting.total }} 条需要你确认</button>
        <UiSegmented v-model="view" size="sm" aria-label="怎么看" :options="views" />
        <button type="button" class="btn ghost sm" @click="newLine"><Icon name="plus" :size="14" />工作线</button>
      </div>
    </header>

    <p v-if="error && !data" class="err" role="alert">{{ error }} <button class="btn ghost sm" @click="load">重试</button></p>

    <div class="grid">
      <main class="main">
        <!-- 按工作线 -->
        <template v-if="view === 'lines'">
          <Skeleton v-if="!data && !error" variant="cards" :rows="3" />
          <template v-else-if="data">
            <div v-if="!data.lines.length" class="card pad empty-lines">
              <strong>还没有工作线</strong>
              <p class="muted small">工作线是这几周你在推进的一件事，相关的需求、缺陷、待办挂在它下面。每晚整理近况时，助手会从你做过的事里提议几条，你在卡片上点“建”；也可以自己建。走流程的事项、挂了别的事项的事项也会显示在这里。</p>
              <div><button class="btn sm primary" @click="newLine"><Icon name="plus" :size="14" />新建工作线</button></div>
            </div>
            <WorkLine v-for="l in data.lines" :key="l.id" :line="l" @change="openChange" @next="openNext" />

            <section v-if="data.loose.length" class="loose">
              <h2 class="section-title row">不在任何线里的事项 <span class="count">{{ data.loose.length }}</span><span class="spacer" /><router-link to="/items" class="small">全部事项</router-link></h2>
              <div class="list">
                <router-link v-for="i in looseShown" :key="i.id" :to="`/items/${i.id}`" class="li">
                  <Icon :name="looseIcon(i.kind)" :size="15" />
                  <span class="grow"><span class="lt">{{ i.title }}</span><span class="muted small">{{ looseWhen(i) }}</span></span>
                </router-link>
              </div>
              <router-link v-if="data.loose.length > looseShown.length" to="/items" class="small more">还有 {{ data.loose.length - looseShown.length }} 件，在事项页看</router-link>
            </section>
          </template>
        </template>

        <!-- 按时间 -->
        <template v-else-if="view === 'time'">
          <div class="filters">
            <div class="chips" role="group" aria-label="变化的种类">
              <button v-for="f in TYPE_FILTERS" :key="f.key" type="button" class="chip" :aria-pressed="types.includes(f.key)" @click="types = toggle(types, f.key)">{{ f.label }}</button>
            </div>
            <div class="chips" role="group" aria-label="从哪里看到的">
              <button v-for="f in ORIGIN_FILTERS" :key="f.key" type="button" class="chip" :aria-pressed="origins.includes(f.key)" @click="origins = toggle(origins, f.key)">{{ f.label }}</button>
            </div>
          </div>
          <Skeleton v-if="!acts" variant="cards" :rows="3" />
          <template v-else>
            <div class="days card pad narrow-only">
              <BarChart title="最近 30 天的变化" caption="一根一天 · 点一根只看那天" unit="条" :labels="chart.labels" :series="chart.series" :links="chart.links" :highlight="chart.highlight" :table="false" />
            </div>
            <p v-if="day" class="small dayf">只看 {{ dayKeyLabel(day, today) }} · <router-link :to="{ path: '/', query: { view: 'time' } }">看全部</router-link></p>
            <p v-if="!filtered.length" class="muted">{{ types.length || origins.length || day ? "这些条件下没有变化。" : "最近 30 天还没有记下的变化。事项跟进、流程、指标和在跟的问题有了结论会记在这里。" }}</p>
            <section v-for="g in byDay" :key="g.day" class="day">
              <h2 class="day-head"><span>{{ dayKeyLabel(g.day, today) }}</span><span class="muted">{{ dayCount(g.day) }} 条</span></h2>
              <WorkChange v-for="c in g.items" :key="c.id" :change="c" line @open="openChange" @changed="changed" />
            </section>
            <button v-if="filtered.length > shownLimit" type="button" class="btn sm more-btn" @click="shownLimit += 60">再看 {{ Math.min(60, filtered.length - shownLimit) }} 条（共 {{ filtered.length }} 条）</button>
          </template>
        </template>

        <!-- 按阶段 -->
        <FlowBoard v-else />

        <section v-if="home && (home.notifications.length || home.runs.length)" class="recent">
          <div v-if="home.notifications.length" class="block">
            <h2 class="section-title row">最近通知<span class="spacer" /><router-link to="/notifications" class="small muted">全部</router-link></h2>
            <div class="list">
              <a v-for="n in home.notifications.slice(0, 5)" :key="n.id" :href="n.link ?? '#/notifications'" class="li" :class="{ unread: n.unread }"><Icon name="bell" :size="15" /><span class="grow"><span class="lt">{{ n.title }}</span><span class="muted small">{{ relTime(n.at) }}</span></span></a>
            </div>
          </div>
          <div v-if="home.runs.length" class="block">
            <h2 class="section-title row">后台运行<span class="spacer" /><router-link to="/runs" class="small muted">全部</router-link></h2>
            <div class="list">
              <router-link v-for="r in home.runs.slice(0, 5)" :key="r.id" :to="`/runs/${r.id}`" class="li">
                <span class="status" :class="r.status" />
                <span class="grow"><span class="lt">{{ r.title }}</span><span class="muted small">{{ runKindLabel[r.kind] ?? r.kind }} · {{ statusLabel[r.status] ?? r.status }} · {{ relTime(r.createdAt) }}</span></span>
              </router-link>
            </div>
          </div>
        </section>
      </main>

      <aside class="rail">
        <!-- 按时间: the days, a column each, beside the list (a column opens that day). -->
        <div v-if="view === 'time' && acts" class="days card pad wide-only">
          <BarChart title="最近 30 天的变化" caption="一根一天 · 点一根只看那天" unit="条" :labels="chart.labels" :series="chart.series" :links="chart.links" :highlight="chart.highlight" :table="false" />
        </div>
        <form class="askbox card" @submit.prevent="ask()">
          <label for="work-ask" class="ask-head">问点什么</label>
          <textarea id="work-ask" v-model="question" rows="2" placeholder="问一条线的进展，或交代一件事" @keydown.enter.exact.prevent="ask()" />
          <div class="row wrap prompts">
            <button v-for="p in prompts" :key="p" type="button" class="chip" :disabled="asking" @click="ask(p)">{{ p }}</button>
          </div>
        </form>
        <Skeleton v-if="!data" variant="list" :rows="4" />
        <WorkWaiting v-else :waiting="data.waiting" @changed="load" @change="openChange" />
        <PluginSlots at="today" />
        <section v-if="data?.places.length" class="places">
          <h2 class="section-title">在跟的问题</h2>
          <router-link v-for="p in data.places" :key="p.id" :to="`/listen/${p.id}`" class="place">
            <Icon name="eye" :size="15" />
            <span class="grow">{{ p.name }}</span>
            <span class="n" :class="{ zero: !p.openProblems }">{{ p.openProblems ? `${p.openProblems} 个` : "没有" }}</span>
          </router-link>
        </section>
        <router-link v-if="home?.study.due" to="/learn" class="card pad study"><Icon name="cap" :size="16" /><span><strong>{{ home.study.due }} 张卡片待复习</strong><span class="muted small"> · 今天已复习 {{ home.study.reviewedToday }} 张</span></span></router-link>
      </aside>
    </div>

    <WorkSheet v-if="sheet" :change="sheet.change" :next="sheet.next" :line-title="sheet.lineTitle" @close="sheet = null" @changed="changed" />
  </div>
</template>

<style scoped>
.work { max-width: 1320px; }
.top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; margin: 4px 0 22px; }
.title h1 { font-family: var(--serif); font-size: 28px; font-weight: 650; margin: 2px 0; }
.title p { margin: 0; }
.tools { gap: 10px; align-items: center; }
.confirm-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
  background: var(--warn-soft); color: var(--warn); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: var(--shadow);
}
.confirm-pill:hover { background-image: linear-gradient(var(--hover), var(--hover)); }
.err { color: var(--danger); }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: start; }
.main { display: grid; gap: 14px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.rail { display: grid; gap: 22px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.empty-lines { display: grid; gap: 8px; }
.count { margin-left: 4px; color: var(--muted); font-weight: 400; }
.loose { margin-top: 14px; }
.loose .list, .recent .list { margin: 0 -12px; }
.li { padding: 8px 12px !important; }
.li :deep(svg) { margin-top: 3px; flex: none; color: var(--muted); }
.grow { flex: 1; min-width: 0; display: grid; gap: 1px; }
.lt { overflow-wrap: anywhere; font-size: 14px; }
.more { display: inline-block; margin-top: 6px; }
.recent { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
.recent .lt { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.unread .lt { font-weight: 600; }
.status { width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; background: var(--line-strong); flex: none; }
.status.running, .status.queued { background: var(--accent); }
.status.done { background: var(--ok); }
.status.failed { background: var(--danger); }

.filters { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 3px 11px; font: inherit; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
.chip:hover { border-color: var(--line-strong); }
.chip[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--panel); }
.chip:disabled { opacity: 0.6; cursor: default; }
.days { display: grid; gap: 6px; --chart-surface: var(--panel); }
.dayf { margin: 0; color: var(--ink-2); }
.day { display: grid; gap: 8px; min-width: 0; }
.day-head { display: flex; gap: 10px; align-items: baseline; font-family: var(--serif); font-size: 16px; font-weight: 650; margin: 10px 0 0; }
.day-head .muted { font-family: var(--sans); font-size: 12px; font-weight: 400; }
.more-btn { justify-self: start; }

.askbox { padding: 12px 14px; display: grid; gap: 8px; box-shadow: var(--shadow); }
.ask-head { font-family: var(--serif); font-size: 15px; font-weight: 650; }
.askbox textarea { border: 0; outline: 0; resize: none; background: none; font: inherit; font-size: 14.5px; line-height: 1.6; color: var(--ink); padding: 0; }
.prompts { gap: 6px; }
.places { display: grid; gap: 2px; }
.place { display: flex; gap: 8px; align-items: center; padding: 7px 8px; margin: 0 -8px; border-radius: 8px; color: inherit; font-size: 13.5px; }
.place:hover { background: var(--hover); text-decoration: none; }
.place :deep(svg) { color: var(--muted); flex: none; }
.place .n { font-size: 12px; color: var(--warn); font-weight: 600; }
.place .n.zero { color: var(--muted); font-weight: 400; }
.study { display: flex; gap: 10px; align-items: center; color: inherit; }
.study:hover { text-decoration: none; border-color: var(--line-strong); }
.narrow-only { display: none; }
@media (max-width: 1000px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .narrow-only { display: grid; }
  .wide-only { display: none; }
}
</style>
