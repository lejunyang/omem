<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import { fmtTime, state } from "../store";

type N = { id: string; at: string; title: string; body: string; link: string | null; readAt: string | null };
const list = ref<N[]>([]);
const loading = ref(true);
async function load() {
  try {
    list.value = (await get<{ notifications: N[] }>("/api/notifications")).notifications;
  } finally {
    loading.value = false;
  }
}
async function readAll() {
  await post("/api/notifications/read", {});
  state.unread = 0;
  void load();
}
onMounted(async () => {
  await load();
});
</script>

<template>
  <div class="page" style="max-width: 760px">
    <div class="page-head">
      <div>
        <h1>通知</h1>
        <p>提醒、需要你决定的变化和后台任务结果。没有重要变化时，助理保持安静。</p>
      </div>
      <span class="spacer" />
      <button class="btn sm" @click="readAll">全部标为已读</button>
    </div>
    <Skeleton v-if="loading" variant="cards" :rows="4" />
    <div v-else-if="!list.length" class="empty"><Icon name="bell" :size="32" /><h3>没有通知</h3></div>
    <div v-for="n in list" :key="n.id" class="n" :class="{ unread: !n.readAt }">
      <div class="row">
        <strong>{{ n.title }}</strong>
        <span class="spacer" />
        <span class="muted small">{{ fmtTime(n.at) }}</span>
      </div>
      <Markdown v-if="n.body" :source="n.body" class="body" />
      <a v-if="n.link" :href="n.link" class="small">查看详情 →</a>
    </div>
  </div>
</template>

<style scoped>
.n {
  border-top: 1px solid var(--line);
  padding: 14px 0;
  display: grid;
  gap: 6px;
}
.n.unread strong::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  margin-right: 8px;
  vertical-align: middle;
}
.body {
  font-size: 14px;
}
</style>
