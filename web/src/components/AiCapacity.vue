<script setup lang="ts">
import HelpText from "./HelpText.vue";
import { onMounted, ref, watch } from "vue";
import { del, get, post } from "../api";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";
import { toast } from "../store";

/**
 * How much runs at once: omem's own slots (background tasks, conversations) and each model's limit.
 * A provider's quota is per account and model, so a full model makes a run move to another model the
 * role is configured for, or wait; a limit of 0 keeps a model out of every automatic choice. Below:
 * each logged-in account's plan limits (agents/quota.ts) and when a nearly spent one goes last.
 */
type Limit = { profile: string; model?: string; max: number; perDay?: number };
type Value = { concurrency: number; interactiveConcurrency: number; perModel: number; limits: Limit[]; quotaAvoidAbove: number; quotaPerDayBelow: number };
type QuotaWindow = { name: string; used: number; model?: string; resetsAt?: string; resetsIn?: string; perDayLeft?: number };
type Quota = { profile: string; name: string; source: string; plan: string | null; readAt: string | null; windows: QuotaWindow[]; avoid?: string; error?: string };
type Load = { now: { source: string; model: string; used: number; waiting: number }[]; recent: { profile: string; model: string; done: number; failed: number; medianMinutes: number | null }[]; outOfQuota?: { source: string; account?: string; model?: string; until: string; message: string }[]; quota?: Quota[]; daily?: { profile: string; model: string; perDay: number; used: number }[] };
const props = defineProps<{ value: Value; backends: { id: string; name?: string }[]; models: Record<string, string[]> }>();
const emit = defineEmits<{ save: [value: Value] }>();
const draft = ref<Value>({ concurrency: 2, interactiveConcurrency: 4, perModel: 3, limits: [], quotaAvoidAbove: 90, quotaPerDayBelow: 0 });
// The parent passes a fresh object on every render: reset the draft only when the saved values change.
watch(() => JSON.stringify(props.value), (v) => { draft.value = JSON.parse(v); }, { immediate: true });

const load = ref<Load | null>(null);
async function refresh() {
  try {
    load.value = await get<Load>("/api/agents/load");
  } catch {
    load.value = null;
  }
}
onMounted(refresh);

const backendOptions = () => props.backends.map((b) => ({ value: b.id, label: b.name ?? b.id, hint: b.id }));
const modelOptions = (l: Limit) => {
  const list = props.models[l.profile] ?? [];
  return [{ value: "", label: "整个后端合计" }, ...[...new Set([...(l.model ? [l.model] : []), ...list])].map((m) => ({ value: m, label: m }))];
};
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
function add() {
  draft.value.limits.push({ profile: props.backends[0]?.id ?? "", max: 2 });
}
function save() {
  const d = draft.value;
  if (d.limits.some((l) => !l.profile)) return toast("每条上限都要选后端", "error");
  emit("save", {
    concurrency: clamp(d.concurrency, 1, 32),
    interactiveConcurrency: clamp(d.interactiveConcurrency, 1, 16),
    perModel: clamp(d.perModel, 1, 32),
    limits: d.limits.map((l) => {
      const perDay = l.model && l.perDay !== undefined && String(l.perDay) !== "" ? clamp(l.perDay, 0, 100000) : undefined;
      return { profile: l.profile, ...(l.model ? { model: l.model } : {}), max: clamp(l.max, 0, 32), ...(perDay !== undefined ? { perDay } : {}) };
    }),
    quotaAvoidAbove: clamp(d.quotaAvoidAbove, 50, 100),
    quotaPerDayBelow: Math.max(0, Math.min(100, Number(d.quotaPerDayBelow) || 0)),
  });
}
async function useAgain(source: string) {
  await del(`/api/agents/quota/${encodeURIComponent(source)}`);
  await refresh();
}
const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const reading = ref(false);
async function readQuota() {
  reading.value = true;
  try {
    await post("/api/agents/quota/refresh", {});
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    reading.value = false;
  }
}
const windowLabel = (n: string) => n.replace(/^5h/, "5 小时").replace(/^7d/, "一周");
const rec = (source: string, model: string) => load.value?.recent.find((r) => r.profile === source && r.model === model);
const today = (l: Limit) => load.value?.daily?.find((d) => d.profile === l.profile && d.model === l.model);
</script>

<template>
  <div class="card pad stack">
    <div class="section-title">并行</div>
    <HelpText>后台任务（整理、Wiki、评审、存量整理的每一批）和对话各有总数；每个模型另有上限，满了的任务会换到这个角色配置过的其他模型（Agent 档案里按后端设的模型）和兜底，都满了就排队。同一账号的 ACP 和命令行后端算一个。对话回复不排队，但算在模型的占用里。</HelpText>
    <div class="grid">
      <label class="field"><span>后台任务同时最多（1–32）</span><input v-model.number="draft.concurrency" class="input" type="number" inputmode="numeric" min="1" max="32" /></label>
      <label class="field"><span>对话同时最多（1–16）</span><input v-model.number="draft.interactiveConcurrency" class="input" type="number" inputmode="numeric" min="1" max="16" /></label>
      <label class="field"><span>每个模型默认最多（1–32）</span><input v-model.number="draft.perModel" class="input" type="number" inputmode="numeric" min="1" max="32" /></label>
    </div>
    <HelpText>单独的上限：选具体模型是这个模型的上限，选“整个后端合计”是这个后端所有模型加起来的上限（可以不设，只靠模型上限）。设成 0 的不会被自动换用或被助手选中，只有你点名时才用。有的后端给部分模型设了每天的次数、又不告诉 omem 还剩多少：给这个模型填“每天最多”，omem 按自己记的当天（你的时区）在它上面开始的运行数算，到了就不再自动选它，直到第二天；后端报“今日额度用完”这类错误时，也会自动避开这个模型到第二天。</HelpText>
    <div v-for="(l, i) in draft.limits" :key="i" class="row wrap lim">
      <UiSelect v-model="l.profile" size="sm" width="200px" aria-label="后端" :options="backendOptions()" @change="l.model = undefined" />
      <UiSelect :model-value="l.model ?? ''" size="sm" width="220px" aria-label="模型" :options="modelOptions(l)" @change="(v) => (l.model = v || undefined)" />
      <label class="row small">同时最多<input v-model.number="l.max" class="input sm num" type="number" inputmode="numeric" min="0" max="32" aria-label="上限" />个</label>
      <label v-if="l.model" class="row small">每天最多<input v-model.number="l.perDay" class="input sm num" type="number" inputmode="numeric" min="0" placeholder="不限" aria-label="每天最多" />次<span v-if="today(l)" class="muted">（今天 {{ today(l)!.used }}）</span></label>
      <span class="spacer" />
      <button class="btn ghost sm icon" aria-label="移除" @click="draft.limits.splice(i, 1)"><Icon name="x" :size="14" /></button>
    </div>
    <div><button class="btn sm" :disabled="draft.limits.length >= 100" @click="add"><Icon name="plus" :size="13" />添加上限</button></div>
    <div class="section-title">额度快用完时</div>
    <HelpText>按下面读到的 Codex、Claude Code 套餐额度：满足任一条件的账号排到最后，后台任务先换用这个角色配置过的其他后端和兜底，助手交办时也会看到“避开”；本人发起的对话、点名用它的任务不受影响。</HelpText>
    <div class="grid">
      <label class="field"><span>任一窗口用到（%）以上时避开（100 = 不避开）</span><input v-model.number="draft.quotaAvoidAbove" class="input" type="number" inputmode="numeric" min="50" max="100" /></label>
      <label class="field"><span>周额度剩余 ÷ 距重置天数 低于（%/天）时避开（0 = 不看）</span><input v-model.number="draft.quotaPerDayBelow" class="input" type="number" inputmode="decimal" min="0" max="100" step="0.5" /></label>
    </div>
    <div class="row wrap"><span class="spacer" /><button class="btn primary sm" @click="save">保存并行设置</button></div>
    <section class="blk">
      <div class="blk-head"><span class="section-title">现在</span><span class="spacer" /><button class="btn ghost sm" @click="refresh">刷新</button></div>
      <div v-if="load?.now.length" class="lines small">
        <template v-for="n in load.now" :key="n.source + n.model">
          <span class="mono">{{ n.source }}{{ n.model ? ` · ${n.model}` : "" }}</span>
          <span>正在用 {{ n.used }}<template v-if="n.waiting">，等 {{ n.waiting }}</template><span v-if="rec(n.source, n.model)" class="muted">（近 7 天完成 {{ rec(n.source, n.model)!.done }}、失败 {{ rec(n.source, n.model)!.failed }}）</span></span>
        </template>
      </div>
      <p v-else class="muted small">现在没有在用的模型。</p>
    </section>
    <section class="blk">
      <div class="blk-head"><span class="section-title">账号额度</span><span class="muted small">本机登录的账号，几分钟读一次，不耗额度</span><span class="spacer" /><button v-if="load?.quota?.length" class="btn ghost sm" :disabled="reading" @click="readQuota">{{ reading ? "读取中…" : "现在读取" }}</button></div>
      <div v-if="load?.quota?.length" class="lines small">
        <template v-for="q in load.quota" :key="q.source">
          <span><span class="mono">{{ q.source }}</span><span v-if="q.plan" class="muted">（{{ q.plan }}）</span></span>
          <span>
            <template v-if="q.windows.length"><span v-for="(w, i) in q.windows" :key="w.name">{{ i ? "；" : "" }}{{ windowLabel(w.name) }}已用 {{ w.used }}%<span v-if="w.resetsIn" class="muted">，{{ w.resetsIn }}后重置</span><span v-if="w.perDayLeft !== undefined" class="muted">，每天约 {{ w.perDayLeft }}%</span></span></template>
            <span v-else class="muted">{{ q.error ? `读不到：${q.error.slice(0, 80)}` : "还没读过" }}</span>
            <span v-if="q.avoid" class="badge warn">避开：{{ q.avoid }}</span>
          </span>
        </template>
      </div>
      <p v-else class="muted small">本机没有能读额度的后端（Codex、Claude Code 登录的账号；API Key 的没有套餐额度）。</p>
    </section>
    <template v-if="load?.outOfQuota?.length">
      <div class="section-title">额度用完</div>
      <p class="muted small">这些账号的额度用完了，到恢复时间前不会被自动选用，任务改用兜底和其他配置过的后端。已经充值或换了套餐可以提前恢复。</p>
      <div v-for="q in load.outOfQuota" :key="q.source" class="row wrap small">
        <span class="mono">{{ q.model ? `${q.account} · ${q.model}` : q.source }}</span><span class="muted">{{ when(q.until) }} 恢复</span><span class="spacer" />
        <button class="btn ghost sm" @click="useAgain(q.source)">现在恢复使用</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}
.lim {
  gap: 8px;
}
.num {
  width: 64px;
  margin: 0 4px;
}
/* A heading with its lines, kept together: the card's own gap only separates blocks. */
.blk {
  display: grid;
  gap: 4px;
}
.blk-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}
.blk-head > .section-title {
  white-space: nowrap;
}
.blk p {
  margin: 0;
}
/* Name | what it is doing, aligned in two columns; on a phone the details wrap under the name. */
.lines {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  align-items: baseline;
}
@media (max-width: 560px) {
  .lines {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .lines > :nth-child(2n) {
    margin-bottom: 6px;
  }
}
</style>
