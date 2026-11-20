<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post, put } from "../../api";
import { fmtTime, relTime, toast } from "../../store";
import { setTimeZone } from "../../lib/time";
import { cronText } from "../../lib/cron-text";
import { useSettings } from "./ctx";
import CronEditor from "../../components/CronEditor.vue";
import Icon from "../../components/Icon.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSelect from "../../components/UiSelect.vue";

/**
 * 设置 → 助手 → 定时任务: the time zone, then every background task as one row (on/off, a short name,
 * when it runs, the last run), grouped by what it does. A row opens to the full description, the
 * schedule editor and the task's own settings.
 */
const { config, load, saveConfig } = useSettings();
type Schedule = { id: string; kind: string; cron: string; enabled: boolean; lastRunAt: string | null; config: Record<string, any> };
const schedules = ref<Schedule[] | null>(null);
const next = ref<Record<string, string | null>>({});
const labels = ref<Record<string, string>>({});
const rules = ref<Record<string, string>>({});
const error = ref("");
async function loadSchedules() {
  error.value = "";
  try {
    const sc = await get<{ schedules: Schedule[]; next: Record<string, string | null>; labels: Record<string, string> }>("/api/schedules");
    schedules.value = sc.schedules;
    next.value = sc.next;
    labels.value = sc.labels;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void loadSchedules();
  void get<{ id: string; name: string }[]>("/api/rules").then((list) => (rules.value = Object.fromEntries(list.map((r) => [r.id, r.name])))).catch(() => {});
});

/** A short name for each kind; the full description is a hover and the opened row away. */
const SHORT: Record<string, string> = {
  activity: "记录仓库活动", "archive-sweep": "个人空间材料归档", brief: "工作日早上的简报", digest: "整理存量材料", dream: "整理记忆与页面",
  heartbeat: "巡检", "item-digest": "事项清点", "item-sweep": "事项收尾", "lark-curate": "筛选值得关注的群", "lark-docs-watch": "检查飞书文档更新",
  "lark-kb-discover": "发现飞书知识库", "lark-kb-read": "读飞书知识库", "lark-poll": "采集飞书消息", learn: "学习卡片", "memory-organize": "整理记忆目录",
  "memory-review": "复核新记忆", "note-review": "复核原件标注", "outcome-review": "复查回复结果", "peer-backup": "备份别的设备", "platform-sync": "同步盯着的平台",
  "profile-review": "复盘 Agent 档案", "quality-audit": "每晚抽检", replay: "夜间复盘", "repo-sync": "同步代码仓库", "weekly-report": "周报",
  "wiki-coverage": "重点文档补写", "wiki-resolve": "Wiki 未决问题", "work-state": "工作近况和人物卡",
};
const GROUPS: { id: string; label: string; kinds: string[] }[] = [
  { id: "capture", label: "采集", kinds: ["lark-poll", "lark-docs-watch", "lark-kb-discover", "lark-kb-read", "lark-curate", "platform-sync", "repo-sync", "activity"] },
  { id: "organize", label: "整理", kinds: ["digest", "dream", "memory-organize", "work-state", "wiki-coverage", "wiki-resolve", "archive-sweep"] },
  { id: "items", label: "事项与流程", kinds: ["heartbeat", "item-sweep", "item-digest", "brief", "weekly-report", "rule"] },
  { id: "review", label: "复盘与质量", kinds: ["memory-review", "note-review", "quality-audit", "outcome-review", "replay", "profile-review"] },
];
const grouped = computed(() => {
  const list = schedules.value ?? [];
  const known = new Set(GROUPS.flatMap((g) => g.kinds));
  const out = GROUPS.map((g) => ({ ...g, rows: g.kinds.flatMap((k) => list.filter((s) => s.kind === k)) }));
  out.push({ id: "other", label: "其他", kinds: [], rows: list.filter((s) => !known.has(s.kind)) });
  return out.filter((g) => g.rows.length);
});
const ruleId = (s: Schedule) => (s.kind === "rule" ? String(s.config.ruleId ?? "") : "");
function nameOf(s: Schedule) {
  if (s.kind === "rule") return rules.value[ruleId(s)] ?? "规则";
  const full = labels.value[s.kind] ?? s.kind;
  return SHORT[s.kind] ?? (full.split("：")[0].length <= 16 ? full.split("：")[0] : `${full.slice(0, 16)}…`);
}
const fullOf = (s: Schedule) => (s.kind === "rule" ? `按规则「${nameOf(s)}」定时运行` : labels.value[s.kind] ?? s.kind);

const open = ref<string | null>(null);
async function toggleSchedule(s: Schedule) {
  await put(`/api/schedules/${s.id}`, { enabled: !s.enabled });
  void loadSchedules();
}
async function saveCron(s: Schedule, cron: string) {
  try {
    await put(`/api/schedules/${s.id}`, { cron });
    toast("已更新", "ok");
    void loadSchedules();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function runNow(s: Schedule) {
  await post(`/api/schedules/${s.id}/run`);
  toast("已触发", "ok", "#/runs");
}
async function saveScheduleConfig(s: Schedule, cfg: Record<string, unknown>) {
  await put(`/api/schedules/${s.id}`, { config: { ...s.config, ...cfg } });
  toast("已保存", "ok");
  void loadSchedules();
}

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function zoneOffset(z: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
const zoneOptions = computed(() => {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const cur = config.value?.timezone as string | undefined;
  return [...new Set([...(cur ? [cur] : []), browserZone, "UTC", ...all])].map((z) => ({ value: z, label: z, hint: zoneOffset(z) }));
});
async function saveTimezone(z: string) {
  if (!z || z === config.value?.timezone) return;
  await saveConfig({ timezone: z }, `时区改为 ${z}`);
  setTimeZone(config.value?.timezone);
  void load();
  void loadSchedules();
}

// The settings of single tasks, shown in their opened row.
async function saveCoverage(key: "nightly" | "perSpace", event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!input.value.trim() || !Number.isSafeInteger(value) || value < 0) {
    input.value = String(config.value.wiki.coverage[key]);
    toast("请填写 0 或正整数", "error");
    return;
  }
  await saveConfig({ wiki: { ...config.value.wiki, coverage: { ...config.value.wiki.coverage, [key]: value } } });
}
async function saveHeartbeat(patch: { gate?: "off" | "decision"; sweepHours?: number }) {
  await saveConfig({ heartbeat: { ...config.value.heartbeat, ...patch } }, "已保存巡检预筛设置");
}
async function saveSweepHours(raw: string) {
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || n < 1 || n > 72) return toast("小时数要在 1 到 72 之间", "error");
  await saveHeartbeat({ sweepHours: n });
}
async function saveWorkState(key: "days" | "people", raw: string, min: number, max: number) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) return toast(`要在 ${min} 到 ${max} 之间`, "error");
  await saveConfig({ workState: { ...config.value.workState, [key]: n } }, "已保存");
}
</script>

<template>
  <div class="stack">
    <SetCard v-if="config" id="set-timezone" title="时区">
      <template #help>任务的时间、免打扰和稍后汇总的时刻、每天的计数和额度，以及网页、飞书消息、给助手的材料里的时间，都按这个时区算，不看服务器和浏览器所在的时区。服务和它启动的 Agent 也用这个时区。改了马上生效，定时任务按新时区重新排。</template>
      <SetRow label="时区" :hint="browserZone !== config.timezone ? `这个浏览器在 ${browserZone}` : '和这个浏览器一致'">
        <UiSelect :model-value="config.timezone" :options="zoneOptions" size="sm" width="240px" aria-label="时区" @change="(z) => saveTimezone(z as string)" />
      </SetRow>
    </SetCard>

    <p v-if="error" class="card set-link" role="alert"><span class="grow">读不到定时任务：{{ error }}</span><button class="btn sm" @click="loadSchedules">重试</button></p>
    <Skeleton v-else-if="!schedules" variant="list" :rows="6" />
    <p v-else-if="!schedules.length" class="card set-link"><span class="grow">还没有定时任务：服务启动时会建好内置的那些，规则里的定时会自己加进来。</span><button class="btn sm" @click="loadSchedules">刷新</button></p>
    <SetCard v-for="g in grouped" v-else :id="`set-sched-${g.id}`" :key="g.id" :title="g.label">
      <template #aside><span class="muted small">{{ g.rows.filter((s) => s.enabled).length }}/{{ g.rows.length }} 开着</span></template>
      <div v-for="s in g.rows" :key="s.id" class="job" :class="{ open: open === s.id, off: !s.enabled }">
        <div class="job-row">
          <UiCheckbox :model-value="s.enabled" switch size="sm" :aria-label="`${nameOf(s)}：${s.enabled ? '开着' : '关着'}`" @change="toggleSchedule(s)" />
          <button type="button" class="job-name" :title="fullOf(s)" :aria-expanded="open === s.id" @click="open = open === s.id ? null : s.id">
            <span class="ellipsis">{{ nameOf(s) }}</span>
          </button>
          <span class="job-when">{{ cronText(s.cron) }}</span>
          <span class="job-last" :title="s.lastRunAt ? fmtTime(s.lastRunAt) : ''">{{ s.lastRunAt ? relTime(s.lastRunAt) : "从未运行" }}</span>
          <button class="btn ghost sm icon" :aria-label="`立即运行 ${nameOf(s)}`" title="立即运行" @click="runNow(s)"><Icon name="play" :size="14" /></button>
          <button class="btn ghost sm icon chev" :aria-label="open === s.id ? '收起' : '展开'" :aria-expanded="open === s.id" @click="open = open === s.id ? null : s.id"><Icon name="down" :size="14" /></button>
        </div>
        <div v-if="open === s.id" class="job-body">
          <p class="small job-full">
            {{ fullOf(s) }}
            <RouterLink v-if="s.kind === 'rule'" :to="{ path: '/rules', query: { id: ruleId(s) } }">打开这条规则</RouterLink>
          </p>
          <CronEditor :model-value="s.cron" :timezone="config?.timezone" @change="(c) => saveCron(s, c)" />
          <p v-if="next[s.id]" class="small muted">下一次：{{ fmtTime(next[s.id]!) }}</p>

          <div v-if="s.kind === 'heartbeat' && config?.heartbeat" class="job-opts">
            <SetRow label="先预筛新材料">
              <template #hint><span>先让决策模型看新材料和关注、等待中的事项有没有关系，没关系就不启动助手；没配决策模型时不起作用（<RouterLink :to="{ path: '/settings', query: { tab: 'agents', section: 'decision' } }">AI → 决策</RouterLink>）</span></template>
              <UiCheckbox :model-value="config.heartbeat.gate === 'decision'" switch aria-label="先预筛新材料" @change="(v) => saveHeartbeat({ gate: v ? 'decision' : 'off' })" />
            </SetRow>
            <SetRow label="跳过的材料隔几小时完整补看" hint="1–72">
              <input class="input set-num" type="number" inputmode="decimal" min="1" max="72" step="any" aria-label="完整补看的间隔（小时）" :value="config.heartbeat.sweepHours" @change="saveSweepHours(($event.target as HTMLInputElement).value)" />
            </SetRow>
          </div>
          <div v-else-if="s.kind === 'wiki-coverage' && config?.wiki?.coverage" class="job-opts">
            <SetRow label="每晚总额（份）" hint="0 停止自动补写">
              <input class="input set-num" type="number" min="0" step="1" inputmode="numeric" aria-label="每晚总额（份）" :value="config.wiki.coverage.nightly" @change="saveCoverage('nightly', $event)" />
            </SetRow>
            <SetRow label="每空间最多（份）" hint="0 时手动补写也暂停">
              <input class="input set-num" type="number" min="0" step="1" inputmode="numeric" aria-label="每空间最多（份）" :value="config.wiki.coverage.perSpace" @change="saveCoverage('perSpace', $event)" />
            </SetRow>
          </div>
          <div v-else-if="s.kind === 'work-state' && config?.workState" class="job-opts">
            <p class="small muted">结果在 Wiki 的个人空间：<a href="#/wiki/personal/state/work">工作近况</a>和 people/ 下的人物卡，可以直接改；页面里“本人补充”一节整理时原样保留。</p>
            <SetRow label="看最近几天" hint="3–60">
              <input class="input set-num" type="number" inputmode="numeric" min="3" max="60" aria-label="看最近几天" :value="config.workState.days" @change="saveWorkState('days', ($event.target as HTMLInputElement).value, 3, 60)" />
            </SetRow>
            <SetRow label="每晚最多更新几张人物卡" hint="0–50">
              <input class="input set-num" type="number" inputmode="numeric" min="0" max="50" aria-label="每晚最多更新几张人物卡" :value="config.workState.people" @change="saveWorkState('people', ($event.target as HTMLInputElement).value, 0, 50)" />
            </SetRow>
            <SetRow label="把近况摘要带进对话" hint="也带进巡检、有人找你的分诊和会后说明">
              <UiCheckbox :model-value="config.workState.inject" switch aria-label="把近况摘要带进对话" @change="(v) => saveConfig({ workState: { ...config.workState, inject: v } }, '已保存')" />
            </SetRow>
          </div>
          <div v-else-if="s.kind === 'lark-curate'" class="job-opts">
            <SetRow label="筛选方向" block>
              <textarea class="textarea" rows="2" aria-label="筛选方向" :value="s.config.direction ?? ''" placeholder="例如：和项目A、后端架构、我负责的模块相关的群；需要我回复或决定的讨论" @change="saveScheduleConfig(s, { direction: ($event.target as HTMLTextAreaElement).value })" />
            </SetRow>
          </div>
          <p v-else-if="s.kind === 'item-sweep'" class="small muted">多少天没进展算过期，在 <RouterLink :to="{ path: '/settings', query: { card: 'item-expiry' } }">推进工作 → 事项自动收尾</RouterLink> 里设。</p>
          <p v-else-if="s.kind === 'quality-audit' || s.kind === 'replay'" class="small muted">每晚抽几页、几题，在 <RouterLink :to="{ path: '/settings', query: { tab: 'review' } }">自检与复盘</RouterLink> 里设。</p>
          <p v-else-if="s.kind === 'outcome-review'" class="small muted">每晚复查几条，在 <RouterLink :to="{ path: '/settings', query: { card: 'reply-outcome' } }">代你回复 → 回复发出后看有没有用</RouterLink> 里设。</p>
        </div>
      </div>
    </SetCard>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
.job {
  border-top: 1px solid var(--line);
  min-width: 0;
}
.job-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 128px 92px auto auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 8px 18px;
  min-width: 0;
}
.job-name {
  display: flex;
  min-width: 0;
  border: 0;
  background: none;
  padding: 4px 0;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.job.off .job-name {
  color: var(--muted);
}
.job-when {
  font-size: 13px;
  color: var(--ink-2);
  white-space: nowrap;
}
.job-last {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  text-align: right;
}
.chev :deep(svg) {
  transition: transform 0.15s ease;
}
.job.open .chev :deep(svg) {
  transform: rotate(180deg);
}
.job-body {
  display: grid;
  gap: 12px;
  padding: 4px 18px 16px 62px;
  min-width: 0;
}
.job-full {
  margin: 0;
  color: var(--ink-2);
  line-height: 1.6;
}
.job-full a {
  margin-left: 4px;
}
/* The task's own settings: rows without the card's inset. */
.job-opts {
  display: grid;
  border-bottom: 1px solid var(--line);
}
.job-opts > :deep(.set-row) {
  padding-left: 0;
  padding-right: 0;
}
.job-opts > p {
  margin: 0 0 8px;
}
@media (max-width: 640px) {
  .job-row {
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    grid-template-areas: "sw name run chev" ". when when when";
    gap: 2px 10px;
    padding: 8px 8px 8px 14px;
  }
  .job-row > :nth-child(1) {
    grid-area: sw;
  }
  .job-row > .job-name {
    grid-area: name;
  }
  .job-row > .job-when {
    grid-area: when;
    font-size: 12px;
    color: var(--muted);
  }
  .job-row > .job-last {
    display: none;
  }
  .job-row > :nth-child(5) {
    grid-area: run;
  }
  .job-row > .chev {
    grid-area: chev;
  }
  .job-body {
    padding: 4px 14px 16px;
  }
}
</style>
