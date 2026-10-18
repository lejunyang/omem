<script setup lang="ts">
import { Cron } from "croner";
import { computed, ref, watch } from "vue";
import UiSelect from "./UiSelect.vue";

/**
 * A schedule as a few choices instead of a cron line: every N minutes, every N hours, daily, on
 * weekdays, on chosen days of the week — or a raw cron expression. Shows what it means and the
 * next run times. Emits `change` with a valid cron expression.
 */
const props = defineProps<{ modelValue: string; timezone?: string }>();
const emit = defineEmits<{ change: [cron: string] }>();

type Mode = "minutes" | "hours" | "daily" | "weekdays" | "weekly" | "custom";
type State = { mode: Mode; every: number; hour: number; minute: number; days: number[]; raw: string };

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Understand the cron forms this editor writes; anything else is "custom". */
function parse(cron: string): State {
  const base: State = { mode: "custom", every: 15, hour: 9, minute: 0, days: [1], raw: cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [mi, h, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") return base;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);
  let m: RegExpExecArray | null;
  if ((m = /^\*\/(\d+)$/.exec(mi)) && h === "*" && dow === "*") return { ...base, mode: "minutes", every: Number(m[1]) };
  if (mi === "*" && h === "*" && dow === "*") return { ...base, mode: "minutes", every: 1 };
  if (!Number.isNaN(num(mi)) && dow === "*") {
    if (h === "*") return { ...base, mode: "hours", every: 1, minute: num(mi) };
    if ((m = /^\*\/(\d+)$/.exec(h))) return { ...base, mode: "hours", every: Number(m[1]), minute: num(mi) };
  }
  if (Number.isNaN(num(mi)) || Number.isNaN(num(h))) return base;
  const at = { hour: num(h), minute: num(mi) };
  if (dow === "*") return { ...base, ...at, mode: "daily" };
  if (dow === "1-5") return { ...base, ...at, mode: "weekdays" };
  if (/^[0-7](,[0-7])*$/.test(dow)) return { ...base, ...at, mode: "weekly", days: [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort() };
  return base;
}

function build(s: State): string {
  switch (s.mode) {
    case "minutes":
      return s.every === 1 ? "* * * * *" : `*/${s.every} * * * *`;
    case "hours":
      return s.every === 1 ? `${s.minute} * * * *` : `${s.minute} */${s.every} * * *`;
    case "daily":
      return `${s.minute} ${s.hour} * * *`;
    case "weekdays":
      return `${s.minute} ${s.hour} * * 1-5`;
    case "weekly":
      return `${s.minute} ${s.hour} * * ${(s.days.length ? s.days : [1]).join(",")}`;
    default:
      return s.raw.trim();
  }
}

const state = ref<State>(parse(props.modelValue));
watch(
  () => props.modelValue,
  (v) => {
    if (v !== build(state.value)) state.value = parse(v);
  },
);

const cron = computed(() => build(state.value));
const check = computed(() => {
  try {
    const runs = new Cron(cron.value, { paused: true, timezone: props.timezone || undefined }).nextRuns(3);
    return { ok: true as const, runs };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
});

const describe = computed(() => {
  const s = state.value;
  const at = `${pad(s.hour)}:${pad(s.minute)}`;
  switch (s.mode) {
    case "minutes":
      return s.every === 1 ? "每分钟" : `每 ${s.every} 分钟`;
    case "hours":
      return `${s.every === 1 ? "每小时" : `每 ${s.every} 小时`}的第 ${s.minute} 分`;
    case "daily":
      return `每天 ${at}`;
    case "weekdays":
      return `工作日（周一到周五）${at}`;
    case "weekly":
      return `每周${s.days.map((d) => WEEK[d]).join("、")} ${at}`;
    default:
      return "自定义 cron 表达式（分 时 日 月 星期）";
  }
});

function fmt(d: Date) {
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function update(patch: Partial<State>) {
  const next = { ...state.value, ...patch };
  // Switching to custom starts from the current expression.
  if (patch.mode === "custom") next.raw = build(state.value);
  state.value = next;
  if (next.mode !== "custom") commit();
}
function commit() {
  if (check.value.ok && cron.value !== props.modelValue) emit("change", cron.value);
}
function toggleDay(d: number) {
  const days = state.value.days.includes(d) ? state.value.days.filter((x) => x !== d) : [...state.value.days, d].sort();
  if (days.length) update({ days });
}

const modes = [
  { value: "minutes", label: "每隔几分钟" },
  { value: "hours", label: "每隔几小时" },
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly", label: "每周几天" },
  { value: "custom", label: "自定义（cron）" },
] as { value: Mode; label: string }[];
const withCurrent = (list: number[], cur: number) => [...new Set([...list, cur])].sort((a, b) => a - b);
const minuteSteps = computed(() => withCurrent([1, 2, 5, 10, 15, 20, 30], state.value.every).map((n) => ({ value: n, label: `${n} 分钟` })));
const hourSteps = computed(() => withCurrent([1, 2, 3, 4, 6, 8, 12], state.value.every).map((n) => ({ value: n, label: `${n} 小时` })));
const hours = Array.from({ length: 24 }, (_, h) => ({ value: h, label: pad(h) }));
const minutes = computed(() => withCurrent([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], state.value.minute).map((m) => ({ value: m, label: pad(m) })));
</script>

<template>
  <div class="cron-editor">
    <div class="row wrap controls">
      <UiSelect :model-value="state.mode" :options="modes" size="sm" width="136px" aria-label="频率" @change="(v) => update({ mode: v as Mode })" />
      <UiSelect v-if="state.mode === 'minutes'" :model-value="state.every" :options="minuteSteps" size="sm" width="96px" aria-label="间隔" @change="(v) => update({ every: v as number })" />
      <template v-else-if="state.mode === 'hours'">
        <UiSelect :model-value="state.every" :options="hourSteps" size="sm" width="96px" aria-label="间隔" @change="(v) => update({ every: v as number })" />
        <span class="muted small">第</span>
        <UiSelect :model-value="state.minute" :options="minutes" size="sm" width="68px" aria-label="分钟" @change="(v) => update({ minute: v as number })" />
        <span class="muted small">分</span>
      </template>
      <template v-else-if="state.mode !== 'custom'">
        <div v-if="state.mode === 'weekly'" class="days" role="group" aria-label="星期">
          <button v-for="d in [1, 2, 3, 4, 5, 6, 0]" :key="d" type="button" class="day" :class="{ on: state.days.includes(d) }" :aria-pressed="state.days.includes(d)" @click="toggleDay(d)">{{ WEEK[d] }}</button>
        </div>
        <UiSelect :model-value="state.hour" :options="hours" size="sm" width="68px" aria-label="小时" @change="(v) => update({ hour: v as number })" />
        <span class="muted">:</span>
        <UiSelect :model-value="state.minute" :options="minutes" size="sm" width="68px" aria-label="分钟" @change="(v) => update({ minute: v as number })" />
      </template>
      <input v-else class="input mono raw" :value="state.raw" aria-label="cron 表达式" placeholder="分 时 日 月 星期，例如 0 9 * * 1-5" @input="state = { ...state, raw: ($event.target as HTMLInputElement).value }" @change="commit" @keydown.enter="commit" />
    </div>
    <div class="muted small">
      <template v-if="check.ok">{{ describe }} · 接下来：{{ check.runs.map(fmt).join("，") }}</template>
      <span v-else class="error">表达式无效：{{ check.error }}</span>
    </div>
  </div>
</template>

<style scoped>
.cron-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.controls {
  gap: 6px;
  align-items: center;
}
.raw {
  width: 200px;
  max-width: 100%;
}
.days {
  display: inline-flex;
  gap: 2px;
}
.day {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.day.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.error {
  color: var(--danger, #c0392b);
}
</style>
