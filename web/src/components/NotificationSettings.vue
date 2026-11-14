<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import { runKindLabel, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import HelpText from "./HelpText.vue";
import Skeleton from "./Skeleton.vue";
const props = defineProps<{ config: any; save: (patch: Record<string, unknown>) => Promise<void> }>();
type Counts = { sent: number; acted: number; known: number; read: number; unread: number; negative: number };
type Chat = Counts & { sourceId: string; title: string };
const data = ref<{ senders: (Counts & { sender: string })[]; sources: Chat[] } | null>(null);
const error = ref("");
const busy = ref(false);
const muted = ref<string[]>([]);
const columns = [{ key: "sent", label: "发了" }, { key: "acted", label: "处理了" }, { key: "known", label: "你已先知道" }, { key: "read", label: "只看了" }, { key: "unread", label: "没看" }, { key: "negative", label: "反感" }] as const;
async function load() {
  error.value = "";
  try { data.value = await get("/api/notifications/outcomes?days=30"); }
  catch (e) { error.value = (e as Error).message; }
}
onMounted(load);
function saveNotify(change: Record<string, unknown>) { return props.save({ notify: { ...props.config.notify, ...change } }); }
function times(next: string[]) { return saveNotify({ laterTimes: [...new Set(next)].sort() }); }
function editTime(index: number, event: Event) {
  const el = event.target as HTMLInputElement;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(el.value)) { el.value = props.config.notify.laterTimes[index]; toast("时间请写成 HH:mm", "error"); return; }
  void times(props.config.notify.laterTimes.map((t: string, i: number) => i === index ? el.value : t));
}
async function ignore(chat: Chat) {
  const rule = `${chat.title} 里的消息不用提醒我，点名我或限时的事除外`;
  if (!(await confirmDialog("这个会话以后不提醒？", { message: rule, okText: "不再提醒" }))) return;
  busy.value = true;
  try { await post("/api/notifications/outcomes/ignore", { sourceId: chat.sourceId }); muted.value.push(chat.sourceId); toast("已记录免提醒规则", "ok"); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="card pad stack">
    <strong>通知时间</strong>
    <div class="row wrap">
      <label class="field">免打扰开始（时）<input class="input hour" type="number" min="0" max="23" :value="config.notify.quietStart" @change="saveNotify({ quietStart: Number(($event.target as HTMLInputElement).value) })" /></label>
      <label class="field">免打扰结束（时）<input class="input hour" type="number" min="0" max="23" :value="config.notify.quietEnd" @change="saveNotify({ quietEnd: Number(($event.target as HTMLInputElement).value) })" /></label>
    </div>
    <span>不急的通知什么时候一起发</span>
    <HelpText>助手把“不需要你现在做什么”的进展和结果标成不急；它们先出现在网页的通知里，到这些时点再一起发到飞书，超过两条合成一条清单。需要你处理或决定的照常立即发。</HelpText>
    <div v-for="(time, i) in config.notify.laterTimes" :key="i" class="row">
      <input class="input time" :value="time" :aria-label="`汇总时间 ${i + 1}`" placeholder="HH:mm" maxlength="5" @change="editTime(i, $event)" />
      <button class="btn sm" @click="times(config.notify.laterTimes.filter((_: string, j: number) => j !== i))">移除</button>
    </div>
    <p class="hint">按服务器时钟。{{ config.notify.laterTimes.length ? '到时一起发。' : '不攒，照常立即发。' }}</p>
    <button class="btn sm" :disabled="config.notify.laterTimes.length >= 12" @click="times([...config.notify.laterTimes, Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:30`).find((t) => !config.notify.laterTimes.includes(t))!])">添加时间</button>
  </div>
  <div class="card pad stack">
    <strong>提醒的效果</strong>
    <HelpText>近 30 天的提醒在发出 48 小时后统计。处理包括一天内点按钮、回应表情、修改事项或在来源会话里发言；这是可观察的反应，不代表每条都由提醒促成。并进清单一起发的不单独统计。</HelpText>
    <p v-if="error" role="alert">{{ error }} <button class="btn sm" @click="load">重试</button></p>
    <Skeleton v-else-if="!data" :rows="3" />
    <template v-else>
      <div v-for="group in ['senders', 'sources'] as const" :key="group" class="stack">
        <span>{{ group === 'senders' ? '按运行类型' : '通知最多的 20 个会话' }}</span>
        <p v-if="!data[group].length" class="muted small">还没有到统计时间的提醒。</p>
        <div v-else class="table-scroll" tabindex="0" :aria-label="group === 'senders' ? '按运行类型的效果' : '按会话的效果'">
          <table><thead><tr><th>{{ group === 'senders' ? '来源' : '会话' }}</th><th v-for="c in columns" :key="c.key">{{ c.label }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in data[group]" :key="i"><th>
              <template v-if="'sender' in r">{{ runKindLabel[r.sender] ?? (r.sender === 'host' ? '宿主' : r.sender) }}</template>
              <template v-else>{{ r.title }}<br><button v-if="r.sent >= 8 && !r.acted" class="btn sm" :disabled="busy || muted.includes(r.sourceId)" @click="ignore(r)">{{ muted.includes(r.sourceId) ? '已设免提醒' : '这个会话以后不提醒' }}</button></template>
            </th><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.hour { width: 90px; } .time { width: 110px; }
.table-scroll { overflow-x: auto; min-width: 0; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border-bottom: 1px solid var(--line); padding: 8px 5px; text-align: left; }
thead th { white-space: nowrap; } tbody th { min-width: 100px; max-width: 200px; overflow-wrap: anywhere; font-weight: normal; }
.wrap { flex-wrap: wrap; }
</style>
