<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";

/**
 * Date-time picker without the native control. v-model is an ISO string (or null);
 * the calendar shows local time. Quick picks cover the usual reminder times.
 */
const props = withDefaults(defineProps<{ modelValue: string | null; placeholder?: string; ariaLabel?: string; clearable?: boolean }>(), { placeholder: "未设置", clearable: true });
const emit = defineEmits<{ "update:modelValue": [value: string | null]; change: [value: string | null] }>();

const open = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0, up: false });
const value = computed(() => (props.modelValue ? new Date(props.modelValue) : null));
const view = ref(new Date());
const time = ref("09:00");

const pad = (n: number) => String(n).padStart(2, "0");
const label = computed(() => {
  const d = value.value;
  if (!d || Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${sameYear ? "" : d.getFullYear() + "年"}${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
});

const days = computed(() => {
  const y = view.value.getFullYear();
  const m = view.value.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
});
const same = (a: Date | null, b: Date) => !!a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function emitDate(d: Date | null) {
  const v = d ? d.toISOString() : null;
  emit("update:modelValue", v);
  emit("change", v);
}
function at(day: Date, hhmm = time.value) {
  const [h, mi] = (/^(\d{1,2}):(\d{2})$/.exec(hhmm.trim()) ?? [, "9", "00"]).slice(1).map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.min(23, h), Math.min(59, mi));
}
function pickDay(day: Date) {
  emitDate(at(day));
  close();
}
function applyTime() {
  if (!/^\d{1,2}:\d{2}$/.test(time.value.trim())) return;
  emitDate(at(value.value ?? new Date()));
}
const quick = computed(() => {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((8 - now.getDay()) % 7 || 7));
  return [
    { label: "1 小时后", d: new Date(Math.ceil((now.getTime() + 3600_000) / 300_000) * 300_000) },
    { label: "今晚 20:00", d: at(now, "20:00") },
    { label: "明天 9:00", d: at(tomorrow, "09:00") },
    { label: "下周一 9:00", d: at(monday, "09:00") },
  ].filter((q) => q.d.getTime() > now.getTime());
});

function place() {
  const r = trigger.value?.getBoundingClientRect();
  if (!r) return;
  const h = 360;
  const up = window.innerHeight - r.bottom < h + 12 && r.top > h + 12;
  pos.value = { top: up ? r.top - 4 : r.bottom + 4, left: Math.min(Math.max(8, r.left), window.innerWidth - 300), up };
}
async function show() {
  view.value = value.value && !Number.isNaN(value.value.getTime()) ? new Date(value.value) : new Date();
  time.value = value.value ? `${pad(value.value.getHours())}:${pad(value.value.getMinutes())}` : "09:00";
  place();
  open.value = true;
  await nextTick();
  pop.value?.querySelector<HTMLButtonElement>(".day.sel, .day.today")?.focus();
}
function close(refocus = true) {
  open.value = false;
  if (refocus) trigger.value?.focus();
}
function shiftMonth(d: number) {
  view.value = new Date(view.value.getFullYear(), view.value.getMonth() + d, 1);
}
function onPopKey(e: KeyboardEvent) {
  if (e.key === "Escape") (e.preventDefault(), close());
  const el = document.activeElement as HTMLElement | null;
  if (!el?.classList.contains("day")) return;
  const i = Number(el.dataset.i);
  const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (d === undefined) return;
  e.preventDefault();
  const j = i + d;
  if (j < 0 || j >= 42) {
    shiftMonth(j < 0 ? -1 : 1);
    return;
  }
  pop.value?.querySelector<HTMLElement>(`.day[data-i="${j}"]`)?.focus();
}
function onDoc(e: MouseEvent) {
  const t = e.target as Node;
  if (!trigger.value?.contains(t) && !pop.value?.contains(t)) close(false);
}
watch(open, (v) => (v ? document.addEventListener("mousedown", onDoc, true) : document.removeEventListener("mousedown", onDoc, true)));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDoc, true));
</script>

<template>
  <button ref="trigger" type="button" class="ui-dt" :class="{ open, empty: !label }" :aria-label="ariaLabel" aria-haspopup="dialog" :aria-expanded="open" @click="open ? close() : show()">
    <Icon name="clock" :size="15" class="ic" />
    <span class="value ellipsis">{{ label || placeholder }}</span>
    <span v-if="clearable && label" class="clear" role="button" tabindex="-1" aria-label="清除" @click.stop="emitDate(null)"><Icon name="x" :size="13" /></span>
  </button>
  <Teleport to="body">
    <div v-if="open" ref="pop" class="ui-dt-pop" :class="{ up: pos.up }" :style="{ top: `${pos.top}px`, left: `${pos.left}px` }" role="dialog" :aria-label="ariaLabel ?? '选择时间'" @keydown="onPopKey">
      <div class="quick">
        <button v-for="q in quick" :key="q.label" type="button" class="chip" @click="emitDate(q.d), close()">{{ q.label }}</button>
      </div>
      <div class="head row">
        <button type="button" class="btn ghost sm icon" aria-label="上个月" @click="shiftMonth(-1)"><Icon name="left" :size="15" /></button>
        <strong>{{ view.getFullYear() }} 年 {{ view.getMonth() + 1 }} 月</strong>
        <button type="button" class="btn ghost sm icon" aria-label="下个月" @click="shiftMonth(1)"><Icon name="right" :size="15" /></button>
      </div>
      <div class="grid">
        <span v-for="w in '一二三四五六日'" :key="w" class="wd">{{ w }}</span>
        <button
          v-for="(d, i) in days"
          :key="d.toDateString()"
          type="button"
          class="day"
          :data-i="i"
          :class="{ out: d.getMonth() !== view.getMonth(), today: same(new Date(), d), sel: same(value, d) }"
          :aria-pressed="same(value, d)"
          :aria-label="`${d.getMonth() + 1}月${d.getDate()}日`"
          @click="pickDay(d)"
        >
          {{ d.getDate() }}
        </button>
      </div>
      <div class="foot row">
        <span class="muted small">时间</span>
        <input v-model="time" class="input time" inputmode="numeric" placeholder="09:00" aria-label="时间（时:分）" @change="applyTime" @keydown.enter.prevent="applyTime(), close()" />
        <span class="spacer" />
        <button v-if="clearable" type="button" class="btn ghost sm" @click="emitDate(null), close()">清除</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-dt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 36px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
  text-align: left;
}
.ui-dt:hover {
  border-color: var(--muted);
}
.ui-dt:focus-visible,
.ui-dt.open {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ui-dt.empty .value {
  color: var(--muted);
}
.ic {
  color: var(--muted);
  flex: none;
}
.value {
  flex: 1;
  min-width: 0;
}
.clear {
  display: inline-flex;
  padding: 3px;
  border-radius: 5px;
  color: var(--muted);
}
.clear:hover {
  background: var(--hover);
  color: var(--ink);
}
</style>

<style>
.ui-dt-pop {
  position: fixed;
  z-index: 200;
  width: 288px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  padding: 10px;
  display: grid;
  gap: 8px;
  animation: ui-pop 0.12s ease-out;
}
.ui-dt-pop.up {
  transform: translateY(-100%);
  animation-name: ui-pop-up;
}
.ui-dt-pop .quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ui-dt-pop .chip {
  border: 1px solid var(--line);
  background: var(--sunken);
  color: var(--ink-2);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 12px;
  cursor: pointer;
}
.ui-dt-pop .chip:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}
.ui-dt-pop .head {
  justify-content: space-between;
}
.ui-dt-pop .grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  text-align: center;
}
.ui-dt-pop .wd {
  font-size: 11.5px;
  color: var(--muted);
  padding: 2px 0;
}
.ui-dt-pop .day {
  height: 32px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.ui-dt-pop .day:hover {
  background: var(--hover);
}
.ui-dt-pop .day.out {
  color: var(--muted);
  opacity: 0.6;
}
.ui-dt-pop .day.today {
  box-shadow: inset 0 0 0 1px var(--line-strong);
  font-weight: 600;
}
.ui-dt-pop .day.sel {
  background: var(--accent);
  color: var(--accent-ink);
}
.ui-dt-pop .day:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ui-dt-pop .foot {
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.ui-dt-pop .time {
  width: 80px;
  height: 30px;
  padding: 4px 8px;
  font-variant-numeric: tabular-nums;
}
</style>
