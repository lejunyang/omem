<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import { runKindLabel, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import HelpText from "./HelpText.vue";
import Skeleton from "./Skeleton.vue";

/**
 * 提醒的效果: what became of the last 30 days of reminders, by who sent them and by chat, with a way
 * to stop reminders from a chat nobody acts on. Data, not a setting: shown on the 数据 page.
 */
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
.table-scroll { overflow-x: auto; min-width: 0; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border-bottom: 1px solid var(--line); padding: 8px 5px; text-align: left; }
thead th { white-space: nowrap; } tbody th { min-width: 100px; max-width: 200px; overflow-wrap: anywhere; font-weight: normal; }
</style>
