<script setup lang="ts">
import { toast } from "../store";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";

/** 设置 → 通知与打扰 → 通知时间: quiet hours, when the not-urgent ones go out together, learning from negative reactions. */
const props = defineProps<{ config: any; save: (patch: Record<string, unknown>) => Promise<unknown> }>();
function saveNotify(change: Record<string, unknown>) { return props.save({ notify: { ...props.config.notify, ...change } }); }
function times(next: string[]) { return saveNotify({ laterTimes: [...new Set(next)].sort() }); }
function editTime(index: number, event: Event) {
  const el = event.target as HTMLInputElement;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(el.value)) { el.value = props.config.notify.laterTimes[index]; toast("时间请写成 HH:mm", "error"); return; }
  void times(props.config.notify.laterTimes.map((t: string, i: number) => i === index ? el.value : t));
}
/** notify.today: the morning card (src/items/today.ts). */
const today = () => props.config.notify.today ?? { enabled: true, at: "09:30" };
function saveToday(change: { enabled?: boolean; at?: string }) { return saveNotify({ today: { ...today(), ...change } }); }
function editTodayTime(event: Event) {
  const el = event.target as HTMLInputElement;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(el.value)) { el.value = today().at; toast("时间请写成 HH:mm", "error"); return; }
  void saveToday({ at: el.value });
}
function addTime() {
  const free = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:30`).find((t) => !props.config.notify.laterTimes.includes(t));
  if (free) void times([...props.config.notify.laterTimes, free]);
}
</script>
<template>
  <SetCard id="set-notify-times" title="通知时间">
    <SetRow label="免打扰" hint="这段时间里不紧急的通知先不发到飞书；按定时任务页的时区">
      <label class="hour-pair">
        <input class="input set-num" type="number" min="0" max="23" aria-label="免打扰开始（时）" :value="config.notify.quietStart" @change="saveNotify({ quietStart: Number(($event.target as HTMLInputElement).value) })" />
        <span class="muted small">点到</span>
        <input class="input set-num" type="number" min="0" max="23" aria-label="免打扰结束（时）" :value="config.notify.quietEnd" @change="saveNotify({ quietEnd: Number(($event.target as HTMLInputElement).value) })" />
        <span class="muted small">点</span>
      </label>
    </SetRow>
    <SetRow label="早上一张“今天”" hint="每天早上一张：各条线的下一步、等你处理的、夜里整理出来的提议。关掉以后它们各自按原来的时间发">
      <div class="today">
        <span v-if="today().enabled" class="time-chip">
          <input class="time" :value="today().at" aria-label="“今天”发出的时间" placeholder="HH:mm" maxlength="5" @change="editTodayTime" />
        </span>
        <UiCheckbox switch :model-value="today().enabled" aria-label="早上一张“今天”" @change="saveToday({ enabled: $event })" />
      </div>
    </SetRow>
    <SetRow label="不急的通知一起发" block>
      <template #hint>{{ config.notify.laterTimes.length ? "先进网页的通知，到这些时点一起发到飞书，超过两条合成一条清单；要你处理的照常立即发" : "不攒，照常立即发" }}</template>
      <div class="times">
        <span v-for="(time, i) in config.notify.laterTimes" :key="i" class="time-chip">
          <input class="time" :value="time" :aria-label="`汇总时间 ${i + 1}`" placeholder="HH:mm" maxlength="5" @change="editTime(i, $event)" />
          <button class="x" type="button" :aria-label="`移除 ${time}`" @click="times(config.notify.laterTimes.filter((_: string, j: number) => j !== i))"><Icon name="x" :size="12" /></button>
        </span>
        <button class="btn ghost sm" :disabled="config.notify.laterTimes.length >= 12" @click="addTime"><Icon name="plus" :size="13" />添加时间</button>
      </div>
    </SetRow>
    <SetRow label="从负面表情学习不再提醒的事" hint="你对通知回了负面表情，这类以后不再提醒；紧急提醒不受影响">
      <UiCheckbox switch :model-value="config.notify.learnFromReactions" aria-label="从负面表情学习不再提醒的事" @change="saveNotify({ learnFromReactions: $event })" />
    </SetRow>
  </SetCard>
</template>
<style scoped>
.hour-pair { display: flex; align-items: center; gap: 8px; }
.hour-pair .set-num.input { width: 64px; }
.today { display: flex; align-items: center; gap: 12px; }
.today .time-chip { padding-right: 10px; }
.times { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.time-chip { display: inline-flex; align-items: center; height: 30px; padding: 0 4px 0 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.time { width: 46px; border: 0; background: none; font: inherit; font-size: 13px; font-family: var(--mono); color: var(--ink); padding: 0; }
.time:focus { outline: none; }
.time-chip:focus-within { border-color: var(--accent); }
.x { border: 0; background: none; color: var(--muted); cursor: pointer; display: inline-flex; padding: 4px; border-radius: 999px; }
.x:hover { color: var(--danger); }
</style>
