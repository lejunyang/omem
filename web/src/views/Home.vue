<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { get, onServerEvent, post, type Item, type Run } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import { currentSpace, fmtTime, itemKindLabel, relTime, runKindLabel, state, statusLabel } from "../store";

type HomeData = {
  decisions: Item[];
  dueSoon: Item[];
  waiting: Item[];
  runs: Run[];
  study: { total: number; due: number; reviewedToday: number };
  notifications: { id: string; at: string; title: string; body: string; link: string | null; readAt: string | null }[];
  recentSources: { id: string; spaceId: string; kind: string; uri: string; title: string; updatedAt: string }[];
};
const router = useRouter();
const data = ref<HomeData | null>(null);
const question = ref("");
const asking = ref(false);

async function load() {
  data.value = await get<HomeData>("/api/home");
}
onMounted(load);
const off = onServerEvent((e) => {
  if (e.type === "changed" || e.type === "run" || e.type === "notification") void load();
});
onBeforeUnmount(() => off());

async function ask() {
  if (!question.value.trim()) return;
  asking.value = true;
  try {
    const r = await post<{ conversationId: string }>("/api/ask", { text: question.value, space: state.space });
    router.push(`/ask/${r.conversationId}`);
  } finally {
    asking.value = false;
  }
}
const greeting = computed(() => {
  const h = new Date().getHours();
  return h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
});
const today = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
const empty = computed(() => data.value && !data.value.decisions.length && !data.value.dueSoon.length && !data.value.waiting.length);
const suggestions = ["我最近有哪些没完成的事？", "上周关于预算的约定是什么？", "这个仓库的整体架构是什么？"];
</script>

<template>
  <div class="page home">
    <header class="hello">
      <div class="muted">{{ today }}</div>
      <h1>{{ greeting }}</h1>
    </header>

    <form class="askbox card" @submit.prevent="ask">
      <textarea v-model="question" rows="2" placeholder="问点什么，或交代一件事：“提醒我周五交报销单”“项目A预算改成120了”" @keydown.enter.exact.prevent="ask" />
      <div class="row">
        <span class="muted small">在「{{ currentSpace()?.name }}」中调查 · 回车发送</span>
        <span class="spacer" />
        <button class="btn primary sm" :disabled="asking || !question.trim()"><Icon name="send" :size="15" />发送</button>
      </div>
    </form>
    <div class="chips row wrap">
      <button v-for="s in suggestions" :key="s" class="chip" @click="(question = s), ask()">{{ s }}</button>
    </div>

    <div v-if="!data" class="grid"><Skeleton variant="cards" :rows="2" /><Skeleton variant="cards" :rows="2" /></div>
    <div v-else class="grid">
      <section class="col">
        <div v-if="data.decisions.length" class="block">
          <h2 class="section-title">需要你决定</h2>
          <div class="list">
            <router-link v-for="i in data.decisions" :key="i.id" :to="`/items/${i.id}`" class="li"><Icon name="alert" :size="16" class="warn" /><div><div>{{ i.title }}</div><div class="muted small">{{ i.detail.slice(0, 80) }}</div></div></router-link>
          </div>
        </div>
        <div v-if="data.dueSoon.length" class="block">
          <h2 class="section-title">近期到期与提醒</h2>
          <div class="list">
            <router-link v-for="i in data.dueSoon" :key="i.id" :to="`/items/${i.id}`" class="li">
              <Icon name="clock" :size="16" />
              <div class="grow"><div>{{ i.title }}</div><div class="muted small">{{ itemKindLabel[i.kind] }} · {{ fmtTime(i.dueAt ?? i.remindAt) }}（{{ relTime(i.dueAt ?? i.remindAt) }}）</div></div>
            </router-link>
          </div>
        </div>
        <div v-if="data.waiting.length" class="block">
          <h2 class="section-title">等待回复</h2>
          <div class="list">
            <router-link v-for="i in data.waiting" :key="i.id" :to="`/items/${i.id}`" class="li"><Icon name="user" :size="16" /><div><div>{{ i.title }}</div><div class="muted small">等待 {{ i.waitingOn || "对方" }} · {{ relTime(i.updatedAt) }}更新</div></div></router-link>
          </div>
        </div>
        <div v-if="empty" class="card pad calm">
          <Icon name="check" />
          <div><strong>没有需要你处理的事</strong><div class="muted small">提醒、等待回复和待决定的事项会出现在这里。</div></div>
        </div>
        <div v-if="data.notifications.length" class="block">
          <h2 class="section-title">最近通知</h2>
          <div class="list">
            <a v-for="n in data.notifications.slice(0, 5)" :key="n.id" :href="n.link ?? '#/notifications'" class="li" :class="{ unread: !n.readAt }"><Icon name="bell" :size="16" /><div class="grow"><div>{{ n.title }}</div><div v-if="n.body" class="muted small clamp">{{ n.body }}</div></div><span class="muted small">{{ relTime(n.at) }}</span></a>
          </div>
        </div>
      </section>

      <aside class="col side">
        <router-link v-if="data.study.due" to="/learn" class="card pad study">
          <Icon name="cap" />
          <div><strong>{{ data.study.due }} 张卡片待复习</strong><div class="muted small">今天已复习 {{ data.study.reviewedToday }} 张</div></div>
        </router-link>
        <div class="block">
          <h2 class="section-title">后台运行</h2>
          <div class="list">
            <router-link v-for="r in data.runs" :key="r.id" :to="`/runs/${r.id}`" class="li">
              <span class="status" :class="r.status" />
              <div class="grow"><div class="ellipsis">{{ r.title }}</div><div class="muted small">{{ runKindLabel[r.kind] ?? r.kind }} · {{ statusLabel[r.status] }} · {{ relTime(r.createdAt) }}</div></div>
            </router-link>
            <div v-if="!data.runs.length" class="muted small pad">还没有运行记录。</div>
          </div>
        </div>
        <div class="block">
          <h2 class="section-title">最近保存</h2>
          <div class="list">
            <router-link v-for="s in data.recentSources" :key="s.id" :to="`/sources/${s.id}`" class="li"><Icon :name="s.kind === 'chat' ? 'chat' : 'file'" :size="16" /><div class="grow ellipsis">{{ s.title }}</div><span class="muted small">{{ relTime(s.updatedAt) }}</span></router-link>
            <button v-if="!data.recentSources.length" class="btn sm" @click="state.capture = true"><Icon name="plus" :size="15" />保存第一份材料</button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 1040px;
}
.hello {
  margin: 12px 0 18px;
}
.hello h1 {
  font-family: var(--serif);
  font-size: 30px;
  font-weight: 650;
}
.askbox {
  padding: 12px 14px;
  display: grid;
  gap: 6px;
  box-shadow: var(--shadow);
}
.askbox textarea {
  border: 0;
  outline: 0;
  resize: none;
  background: none;
  font-size: 15.5px;
  line-height: 1.6;
}
.chips {
  margin: 10px 0 28px;
  gap: 6px;
}
.chip {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12.5px;
  color: var(--ink-2);
  cursor: pointer;
}
.chip:hover {
  border-color: var(--line-strong);
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 28px;
}
.col {
  display: grid;
  gap: 24px;
  align-content: start;
}
.block .list {
  margin: 0 -12px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.warn {
  color: var(--warn);
}
.calm {
  display: flex;
  gap: 12px;
  align-items: center;
  color: var(--ok);
}
.calm strong {
  color: var(--ink);
}
.study {
  display: flex;
  gap: 12px;
  align-items: center;
  color: inherit;
}
.study:hover {
  text-decoration: none;
  border-color: var(--line-strong);
}
.status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 7px;
  background: var(--line-strong);
  flex: none;
}
.status.running,
.status.queued {
  background: var(--accent);
}
.status.done {
  background: var(--ok);
}
.status.failed {
  background: var(--danger);
}
.unread {
  font-weight: 550;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pad {
  padding: 8px 12px;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
