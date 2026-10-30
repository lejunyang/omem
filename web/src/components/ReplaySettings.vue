<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post, put } from "../api";
import { fmtTime, toast } from "../store";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Nightly replay (src/agents/replay.ts, docs/v2/replay.md): the scheduled job, questions per night,
 * task types, the signal → axis plan and the model ladder of the A axis. The judge's AI is chosen on
 * the Agent page (built-in role replay-judge); until then nothing runs.
 */
type Ai = { profile: string; model?: string; effort?: string };
type Replay = { max: number; days: number; taskTypes: string[]; plan: Record<string, string[]>; models: Ai[] };
type Status = { enabled: boolean; cron: string | null; judge: { profile: string; model: string | null; effort: string | null; sameFamilyAsAssistant: boolean } | null; notice: string | null; last: Record<string, unknown> | null; days28: { verdicts: Record<string, number>; judged: number; agreed: number }; pendingEffects: number };
type Option = { value: string; label: string; hint?: string };

const props = defineProps<{ value: Replay; backends: Option[]; modelOptions: (profile: string | undefined, key: "model" | "effort", current?: string, model?: string) => Option[] }>();
const emit = defineEmits<{ save: [replay: Replay, note: string] }>();

const SIGNALS: [string, string][] = [
  ["negative", "负面表情"],
  ["correction", "本人纠正"],
  ["notFound", "回答说没找到"],
  ["timeout", "超时失败"],
  ["slow", "慢（高于这类运行的 p75）"],
  ["normal", "正常完成"],
  ["positive", "正面表情（对照）"],
];
const AXES: Option[] = [
  { value: "R1", label: "R1 深检索", hint: "先列说法、scan 穷举" },
  { value: "R2", label: "R2 加空间", hint: "加相关和可访问的空间" },
  { value: "R3", label: "R3 研究档案", hint: "traits: [research] 的档案" },
  { value: "S1", label: "S1 只看重点和仅检索" },
  { value: "S2", label: "S2 连忽略的一起看" },
  { value: "M1", label: "M1 去掉碰过的记忆" },
  { value: "M2", label: "M2 不带记忆", hint: "每周最多两次" },
  { value: "M3", label: "M3 去掉整理写的经验" },
  { value: "W1", label: "W1 不看页面" },
  { value: "W2", label: "W2 先读页面" },
  { value: "A1", label: "A1 模型降一档" },
  { value: "A2", label: "A2 模型升一档" },
  { value: "random", label: "随机一个（对照）" },
];
const axisLabel = (a: string) => AXES.find((x) => x.value === a)?.label ?? a;
const DEFAULT_TYPES = ["事实查询", "汇总计数", "代码路径", "时间线与变化", "排查", "写作"];
const DEFAULT_PLAN: Record<string, string[]> = { negative: ["M1", "S1", "W1", "A2"], correction: ["M1", "S1", "W1", "A2"], notFound: ["S2", "R2", "R1", "R3", "A2"], timeout: ["A1"], slow: ["A1", "M3"], normal: ["A1"], positive: ["random"] };

const status = ref<Status | null>(null);
const failed = ref("");
async function load() {
  try {
    status.value = (await get<{ status: Status }>("/api/replays?limit=1")).status;
  } catch (e) {
    failed.value = (e as Error).message;
  }
}
onMounted(load);

const r = computed(() => props.value);
const save = (patch: Partial<Replay>, note = "已保存夜间复盘设置") => emit("save", { ...r.value, ...patch }, note);

async function toggle(on: boolean) {
  try {
    await put("/api/schedules/replay", { enabled: on });
    toast(on ? "已打开夜间复盘（每天 4:30）" : "已关闭夜间复盘", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const running = ref(false);
async function runNow() {
  running.value = true;
  try {
    const res = await post<{ skipped: string | null; runs: string[] }>("/api/replays/run", {});
    if (res.skipped) toast(res.skipped, "error");
    else toast(res.runs.length ? `已排队 ${res.runs.length} 题` : "最近没有可以复盘的问题", "ok", res.runs.length ? "#/runs" : undefined);
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    running.value = false;
  }
}

const maxOptions = [1, 2, 3, 5, 8].map((n) => ({ value: String(n), label: `${n} 题` }));
const dayOptions = [1, 2, 3, 5, 7, 14].map((n) => ({ value: String(n), label: `最近 ${n} 天` }));

const typeDraft = ref("");
function addType() {
  const t = typeDraft.value.trim();
  if (!t || r.value.taskTypes.includes(t)) return;
  save({ taskTypes: [...r.value.taskTypes, t] }, "已添加题型");
  typeDraft.value = "";
}
function removeType(t: string) {
  if (r.value.taskTypes.length <= 1) return toast("至少留一个题型", "error");
  save({ taskTypes: r.value.taskTypes.filter((x) => x !== t) }, "已移除题型");
}

const planOf = (s: string) => r.value.plan[s] ?? DEFAULT_PLAN[s] ?? [];
function setPlan(s: string, list: string[]) {
  save({ plan: { ...DEFAULT_PLAN, ...r.value.plan, [s]: list } }, "已保存选轴顺序");
}
const addOptions = (s: string) => AXES.filter((a) => !planOf(s).includes(a.value));

function setStep(i: number, patch: Partial<Ai>) {
  const list = r.value.models.map((m, k) => (k === i ? { ...m, ...patch } : m));
  save({ models: list }, "已保存模型阶梯");
}
function moveStep(i: number) {
  const list = [...r.value.models];
  [list[i - 1], list[i]] = [list[i], list[i - 1]];
  save({ models: list }, "已调整顺序");
}
const verdicts = computed(() => status.value?.days28.verdicts ?? {});
const lastText = computed(() => {
  const l = status.value?.last;
  if (!l) return "还没有运行过";
  const when = typeof l.at === "string" ? fmtTime(l.at) : "";
  if (typeof l.skipped === "string") return `${when} 没有运行：${l.skipped}`;
  if (typeof l.verdict === "string") return `${when} 复盘 ${l.replayId ?? ""} 完成`;
  if (typeof l.scheduled === "number") return `${when} 排了 ${l.scheduled} 题${typeof l.note === "string" ? `（${l.note}）` : ""}`;
  return when;
});
</script>

<template>
  <div class="card pad stack replay">
    <div class="row wrap">
      <div class="section-title">夜间复盘</div>
      <span class="spacer" />
      <UiCheckbox v-if="status" :model-value="status.enabled" switch @change="toggle">每天 4:30 运行</UiCheckbox>
      <button class="btn sm" :disabled="running" @click="runNow"><Icon name="play" :size="13" />{{ running ? "排队中…" : "立即运行" }}</button>
    </div>
    <p class="muted small">挑最近的问题，回到提问时（那时的记忆、聊天和原件）重答两次：一次设置不变，一次只改一处（检索方式、原件级别、记忆、页面或模型）。两份回答先过引用检查，再由 replay-judge 两种顺序各评一次，一致才算胜负。结论用来把误导的记忆送回复核、给页面排检查、提原件级别的建议，并作为任务选型的参考；模型不会被自动换掉。</p>
    <p v-if="failed" class="muted small">{{ failed }}</p>
    <template v-else-if="status">
      <p v-if="status.notice" class="warn small">
        {{ status.notice }}
        <RouterLink :to="{ path: '/agents', query: { tab: 'agents', role: 'replay-judge' } }">去设置</RouterLink>
      </p>
      <p v-else-if="status.judge" class="small">
        评判：<span class="mono">{{ [status.judge.profile, status.judge.model, status.judge.effort].filter(Boolean).join(" · ") }}</span>
        <RouterLink class="muted" :to="{ path: '/agents', query: { tab: 'agents', role: 'replay-judge' } }">改</RouterLink>
        <span v-if="status.judge.sameFamilyAsAssistant" class="muted">（和主助手是同一家的模型，评判可能偏向同类写法；能选别家的更好）</span>
      </p>
      <p class="muted small">
        上次：{{ lastText }}。近 28 天：变体胜 {{ verdicts.win ?? 0 }}、基线胜 {{ verdicts.loss ?? 0 }}、持平 {{ verdicts.tie ?? 0 }}、作废 {{ verdicts.void ?? 0 }}<template v-if="status.days28.judged">；评判两种顺序一致 {{ status.days28.agreed }}/{{ status.days28.judged }}</template><template v-if="status.pendingEffects">；{{ status.pendingEffects }} 条建议待你决定（<RouterLink to="/agents">Agent 页</RouterLink>）</template>。
      </p>
    </template>

    <div class="row wrap">
      <span class="small">每晚</span>
      <UiSelect :model-value="String(r.max)" size="sm" width="110px" aria-label="每晚题数" :options="maxOptions" @change="(v) => save({ max: Number(v) })" />
      <span class="small">从</span>
      <UiSelect :model-value="String(r.days)" size="sm" width="130px" aria-label="选题范围" :options="dayOptions" @change="(v) => save({ days: Number(v) })" />
      <span class="muted small">的问答和档案运行里挑；没有 token 上限，每一臂照常受空闲超时限制</span>
    </div>

    <div class="field">
      <span class="small">题型（评判给每题标一个，选型证据按题型分开统计）</span>
      <div class="row wrap">
        <span v-for="t in r.taskTypes" :key="t" class="chip on">{{ t }}<button class="x" :aria-label="`移除 ${t}`" @click="removeType(t)"><Icon name="x" :size="11" /></button></span>
        <input v-model="typeDraft" class="input sm-input" placeholder="新题型" @keydown.enter="addType" />
        <button class="btn ghost sm" :disabled="!typeDraft.trim()" @click="addType">添加</button>
        <button v-if="r.taskTypes.join() !== DEFAULT_TYPES.join()" class="btn ghost sm" @click="save({ taskTypes: DEFAULT_TYPES }, '已恢复默认题型')">恢复默认</button>
      </div>
    </div>

    <details class="more">
      <summary class="small">按信号选轴（每题只改一处：按顺序取第一个适用、这题没试过的）</summary>
      <div v-for="[s, label] in SIGNALS" :key="s" class="plan-row">
        <span class="small plan-label">{{ label }}</span>
        <div class="row wrap grow">
          <span v-for="(a, i) in planOf(s)" :key="a" class="chip">{{ i + 1 }}. {{ axisLabel(a) }}<button class="x" :aria-label="`移除 ${a}`" @click="setPlan(s, planOf(s).filter((x) => x !== a))"><Icon name="x" :size="11" /></button></span>
          <UiSelect v-if="addOptions(s).length" model-value="" size="sm" width="150px" :aria-label="`给${label}加一个轴`" placeholder="＋ 轴" :options="addOptions(s)" @change="(v) => v && setPlan(s, [...planOf(s), v])" />
        </div>
      </div>
      <div class="row"><span class="spacer" /><button class="btn ghost sm" @click="save({ plan: DEFAULT_PLAN }, '已恢复默认选轴')">恢复默认</button></div>
    </details>

    <details class="more">
      <summary class="small">模型阶梯（A1 / A2 用；从便宜到强排，不填时在同一模型上降或升一档思考强度）</summary>
      <div v-for="(m, i) in r.models" :key="i" class="row wrap step-row">
        <span class="small muted step-n">{{ i + 1 }}</span>
        <UiSelect :model-value="m.profile" size="sm" width="180px" aria-label="后端" :options="backends" @change="(v) => setStep(i, { profile: v, model: undefined, effort: undefined })" />
        <UiSelect :model-value="m.model ?? ''" size="sm" width="170px" aria-label="模型" :options="modelOptions(m.profile, 'model', m.model)" @change="(v) => setStep(i, { model: v || undefined, effort: undefined })" />
        <UiSelect :model-value="m.effort ?? ''" size="sm" width="120px" aria-label="强度" :options="modelOptions(m.profile, 'effort', m.effort, m.model)" @change="(v) => setStep(i, { effort: v || undefined })" />
        <span class="spacer" />
        <button class="btn ghost sm" :disabled="i === 0" @click="moveStep(i)">上移</button>
        <button class="btn ghost sm icon" aria-label="移除" @click="save({ models: r.models.filter((_, k) => k !== i) }, '已移除')"><Icon name="x" :size="14" /></button>
      </div>
      <div class="row"><button class="btn sm" :disabled="!backends.length" @click="save({ models: [...r.models, { profile: backends[0].value }] }, '已添加一档')"><Icon name="plus" :size="13" />添加一档</button></div>
    </details>
  </div>
</template>

<style scoped>
.warn {
  color: var(--warn);
  margin: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 999px;
  padding: 1px 6px 1px 10px;
  font-size: 12px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
}
.chip .x {
  border: 0;
  background: transparent;
  padding: 0 0 0 4px;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.sm-input {
  width: 120px;
}
.plan-row {
  display: grid;
  grid-template-columns: minmax(0, 150px) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  border-top: 1px solid var(--line);
}
.plan-label {
  min-width: 0;
}
.step-row {
  padding: 6px 0;
  border-top: 1px solid var(--line);
}
.step-n {
  width: 16px;
}
@media (max-width: 760px) {
  .plan-row {
    grid-template-columns: 1fr;
  }
}
</style>
