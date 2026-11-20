<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { fmtTime, relTime } from "../store";
import { KIND_LABEL, replyLabel, type ListenView } from "../lib/listen";
import HelpText from "./HelpText.vue";
import Icon from "./Icon.vue";
import ListenNewDialog from "./ListenNewDialog.vue";
import Skeleton from "./Skeleton.vue";

/**
 * Every 关注 (once listed under 设置 → 连接; unused since the settings regrouping), the built-in 有人找你 first, each opening its page; and a new one.
 * `defaultReply`: how 有人找你 replies, which lives in 渠道 → 有人找你 rather than on the 关注.
 */
const props = defineProps<{ items: ListenView[] | null; groups: { value: string; label: string; hint?: string }[]; defaultReply: string }>();
const emit = defineEmits<{ created: [view: ListenView] }>();
const router = useRouter();

const sorted = computed(() => (props.items ?? []).slice().sort((a, b) => (a.kind === "default" ? -1 : b.kind === "default" ? 1 : 0) || (a.status === b.status ? 0 : a.status === "active" ? -1 : 1)));
const creating = ref(false);
const where = (v: ListenView) =>
  v.kind === "default" ? "所有私聊和 @ 你的消息" : v.groups.length ? v.groups.map((g) => g.name.replace(/\s+/g, " ")).join("、") : v.item ? `事项：${v.item.title}` : "还没有群";
function created(v: ListenView) {
  creating.value = false;
  emit("created", v);
  void router.push(`/listen/${encodeURIComponent(v.id)}`);
}
</script>

<template>
  <div class="card pad stack listen-card">
    <div class="row wrap">
      <strong>关注</strong>
      <span class="spacer" />
      <button class="btn sm" type="button" @click="creating = true"><Icon name="plus" :size="14" />新建关注</button>
    </div>
    <HelpText>关注是助手替你看着的一件事，带着自己的上下文：一个或几个群、一件事情，或默认的“有人找你”。每个关注有自己的说明、回复方式、案例和经验，点开看它在聊什么、做得怎么样，并纠正它。</HelpText>
    <Skeleton v-if="!items" variant="list" :rows="3" />
    <ul v-else class="ctx-list">
      <li v-for="v in sorted" :key="v.id">
        <router-link :to="`/listen/${encodeURIComponent(v.id)}`" class="ctx" :class="{ paused: v.status !== 'active' }">
          <div class="top">
            <span class="name ellipsis">{{ v.name }}</span>
            <span class="badge">{{ KIND_LABEL[v.kind] }}</span>
            <span v-if="v.status !== 'active'" class="badge warn">已暂停</span>
            <span v-else-if="v.expiresAt" class="badge" :title="fmtTime(v.expiresAt)">{{ relTime(v.expiresAt) }}停止</span>
          </div>
          <div class="groups small muted clamp" :title="where(v)">{{ where(v) }}</div>
          <div class="facts small muted">
            <span>{{ v.kind === "default" ? defaultReply : `回复：${replyLabel(v.knobs)}` }}</span>
            <span>案例 {{ v.stats.cases }}</span>
            <span v-if="v.stats.corrections">本人纠正 {{ v.stats.corrections }}</span>
            <span v-if="v.stats.lastCase" :title="fmtTime(v.stats.lastCase)">最近 {{ relTime(v.stats.lastCase) }}</span>
          </div>
        </router-link>
      </li>
    </ul>
    <p v-if="items && items.length <= 1" class="muted small">还没有自己建的关注。点“新建关注”选几个群，或在对话里对助手说“帮我盯着值班群，问报错的先查再回”。</p>
    <ListenNewDialog v-if="creating" :groups="groups" @close="creating = false" @created="created" />
  </div>
</template>

<style scoped>
.listen-card {
  min-width: 0;
}
.ctx-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.ctx-list li + li {
  border-top: 1px solid var(--line);
}
.ctx {
  display: grid;
  gap: 3px;
  padding: 10px 14px;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.ctx:hover {
  background: var(--hover);
}
.ctx:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.name {
  font-weight: 550;
  min-width: 0;
}
.ctx.paused .name {
  color: var(--ink-2);
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.facts {
  display: flex;
  flex-wrap: wrap;
}
.facts > span + span::before {
  content: "·";
  margin: 0 6px;
}
</style>
