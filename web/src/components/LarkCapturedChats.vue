<script setup lang="ts">
import { computed, ref } from "vue";
import { put } from "../api";
import { fmtTime, relTime, state, toast } from "../store";
import { spaceOptions } from "../lib/spaces";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import VirtualList from "./VirtualList.vue";

export type Policy = "ingest" | "involved" | "store" | "skip";
/** One chat from `GET /api/lark/captured` (src/channels/lark-personal.ts `capturedChats`). */
export type CapturedChat = {
  chatId: string;
  name: string;
  kind: string;
  muted: boolean;
  involved: boolean;
  captured: boolean;
  lastMessageAt: string | null;
  policy: Policy;
  own: Policy | null;
  subscribed: boolean;
  spaceId: string;
  backfilling: boolean;
};

/**
 * Every chat capture has read, plus subscribed ones not read yet: subscription, the space its
 * capture goes to and what is done with it, in one virtualized list.
 */
const props = defineProps<{
  chats: CapturedChat[];
  policyOptions: { value: Policy; label: string; hint: string }[];
  /** The 关注 each chat is in (chips on its row). */
  listens?: Record<string, { id: string; name: string; paused: boolean }[]>;
}>();
const emit = defineEmits<{ updated: [chatId: string, chat: CapturedChat | null] }>();

const kindLabel: Record<string, string> = { p2p: "单聊", bot: "机器人单聊", "own-bot": "omem 机器人", group: "群聊", topic: "话题群" };
const filter = ref("");
const only = ref<"all" | "subscribed">("all");
const subscribedCount = computed(() => props.chats.filter((c) => c.subscribed).length);
const shown = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return props.chats.filter((c) => (only.value === "all" || c.subscribed) && (!f || c.name.toLowerCase().includes(f) || c.chatId === f));
});
const spaces = computed(() => spaceOptions(state.spaces));
const policyLabel = computed(() => Object.fromEntries(props.policyOptions.map((o) => [o.value, o.label])) as Record<Policy, string>);
/** Names can carry line breaks (a group named after a ticket): one line in the row, all of it on hover. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

async function call(c: CapturedChat, path: string, body: unknown, done: string) {
  try {
    const r = await put<{ chat: CapturedChat | null }>(`/api/lark/chats/${encodeURIComponent(c.chatId)}/${path}`, body);
    emit("updated", c.chatId, r.chat);
    toast(done, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const subscribe = (c: CapturedChat, on: boolean) => call(c, "subscription", { subscribed: on, name: c.name }, on ? `已订阅：${oneLine(c.name)}` : `已取消订阅：${oneLine(c.name)}`);
const setSpace = (c: CapturedChat, spaceId: string) => call(c, "space", { spaceId }, `之后的消息采集到：${state.spaces.find((s) => s.id === spaceId)?.name ?? spaceId}`);
const setPolicy = (c: CapturedChat, policy: Policy | "") => call(c, "policy", { policy: policy || null }, policy ? `已改为：${policyLabel.value[policy]}` : "已恢复默认");
</script>

<template>
  <div class="lark-chats stack">
    <div class="head row wrap">
      <div class="grow">
        <div class="section-title">飞书会话</div>
        <div class="muted small">共 {{ chats.length }} 个，订阅 {{ subscribedCount }} 个</div>
      </div>
      <UiSegmented v-model="only" size="sm" aria-label="显示哪些会话" :options="[{ value: 'all', label: '全部' }, { value: 'subscribed', label: '已订阅' }]" />
      <label class="search-mini row"><Icon name="search" :size="13" /><input v-model="filter" placeholder="按名称筛选" aria-label="按名称筛选会话" /></label>
    </div>
    <p class="note muted small">打开开关即订阅：一定读取，按“保存并整理”。空间只影响之后采集的消息，已保存的不搬。</p>
    <div v-if="!shown.length" class="muted small empty">{{ filter ? "没有名称匹配的会话" : "还没有订阅的会话" }}</div>
    <div v-else class="scroller">
      <VirtualList :items="shown" :item-key="(c) => c.chatId" :estimate="62">
        <template #default="{ item: c }">
          <div class="chat" :class="{ on: c.subscribed }">
            <UiCheckbox switch size="sm" :model-value="c.subscribed" :aria-label="`订阅 ${oneLine(c.name)}`" @change="(v) => subscribe(c, v)" />
            <div class="main">
              <router-link v-if="c.kind === 'group' || c.kind === 'topic'" :to="`/lark/chats/${encodeURIComponent(c.chatId)}`" class="name ellipsis" :title="`${c.name}：看它在哪些关注里、案例和记忆`">{{ oneLine(c.name) || c.chatId }}</router-link>
              <div v-else class="name ellipsis" :title="c.name">{{ oneLine(c.name) || c.chatId }}</div>
              <div v-if="listens?.[c.chatId]?.length" class="in-listen">
                <router-link v-for="l in listens[c.chatId]" :key="l.id" :to="`/listen/${encodeURIComponent(l.id)}`" class="badge" :class="{ accent: !l.paused }" :title="l.paused ? `关注「${l.name}」（已暂停）` : `在关注「${l.name}」里`">{{ l.name }}</router-link>
              </div>
              <div class="meta muted small">
                <span>{{ kindLabel[c.kind] ?? c.kind }}</span>
                <span v-if="c.muted">免打扰</span>
                <span v-if="c.involved" title="你在这里发过言或被 @ 过">参与过</span>
                <span v-if="!c.captured">还没采集</span>
                <span v-else-if="c.lastMessageAt" :title="fmtTime(c.lastMessageAt)">最近消息 {{ relTime(c.lastMessageAt) }}</span>
                <span v-if="c.backfilling">正在回溯历史</span>
              </div>
            </div>
            <div class="controls">
              <UiSelect :model-value="c.spaceId"  size="sm" :aria-label="`${oneLine(c.name)} 采集到的空间`" :options="spaces" @change="(v) => setSpace(c, v as string)" />
              <UiSelect
                :model-value="c.own ?? ''"
                size="sm"
                :aria-label="`${oneLine(c.name)} 的处理方式`"
                :options="[{ value: '', label: `默认（${policyLabel[c.policy]}）` }, ...policyOptions]"
                @change="(v) => setPolicy(c, v as Policy | '')"
              />
            </div>
          </div>
        </template>
      </VirtualList>
    </div>
  </div>
</template>

<style scoped>
.lark-chats {
  container-type: inline-size;
  min-width: 0;
}
.head {
  gap: 10px;
  align-items: center;
}
.search-mini {
  height: 28px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  padding: 0 8px;
  color: var(--muted);
  gap: 4px;
}
.search-mini input {
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  width: 140px;
  font: inherit;
  font-size: 13px;
}
.note {
  margin: 0;
}
.empty {
  padding: 12px 0;
}
.scroller {
  max-height: 560px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.chat {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  row-gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}
.main {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.name {
  font-weight: 500;
  color: var(--ink);
}
a.name {
  text-decoration: none;
  justify-self: start;
  max-width: 100%;
}
a.name:hover {
  text-decoration: underline;
}
.chat:not(.on) .name {
  color: var(--ink-2);
}
.in-listen {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.in-listen .badge {
  display: inline-block;
  line-height: 20px;
  text-decoration: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 0;
}
.meta > span + span::before {
  content: "·";
  margin: 0 6px;
}
/* Space, then policy: the policy picker fits “默认（与我有关时整理）”. */
.controls {
  display: grid;
  grid-template-columns: 150px 210px;
  gap: 8px;
  align-items: center;
}
/* Narrow: the two pickers go under the name, side by side, lined up with it. */
@container (max-width: 640px) {
  .chat {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .controls {
    grid-column: 2;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  }
}
</style>
