<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { get, onServerEvent, type Ask, type UiViewItem } from "../api";
import AskCard from "../components/AskCard.vue";
import Markdown from "../components/Markdown.vue";
import Skeleton from "../components/Skeleton.vue";
import UiView from "../components/UiView.vue";

/**
 * One question or view on its own page (`#/ui/<id>`, docs/v2/interactive-ui.md): where a Feishu
 * card or a text chat sends the person to fill in a form or see a table drawn.
 */
type Item = { type: "ask"; ask: Ask } | { type: "view"; view: UiViewItem };
const route = useRoute();
const item = ref<Item | null>(null);
const error = ref("");
const loading = ref(true);

async function load() {
  const id = String(route.params.id ?? "");
  error.value = "";
  try {
    item.value = await get<Item>(`/api/ui/${encodeURIComponent(id)}`);
  } catch (e) {
    item.value = null;
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
void load();
watch(() => route.params.id, () => ((loading.value = true), void load()));
const off = onServerEvent((e) => {
  if (e.type === "ask" && item.value?.type === "ask" && e.id === item.value.ask.id) void load();
});
onBeforeUnmount(off);
</script>

<template>
  <main class="ui-item">
    <Skeleton v-if="loading" :rows="4" />
    <p v-else-if="error" class="muted">{{ error }}</p>
    <template v-else-if="item?.type === 'view'">
      <UiView :components="item.view.components" :title="item.view.title || '展示'" />
      <p class="muted small">{{ new Date(item.view.createdAt).toLocaleString("zh-CN", { hour12: false }) }}</p>
    </template>
    <template v-else-if="item?.type === 'ask'">
      <AskCard v-if="item.ask.status === 'pending'" :ask="item.ask" @answered="load" />
      <section v-else class="done card pad">
        <Markdown :source="item.ask.question" />
        <p class="muted small">{{ item.ask.status === "cancelled" ? "这个提问已经失效了" : "已回答" }}</p>
        <p v-if="item.ask.answer" class="answer">{{ item.ask.answer }}</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.ui-item {
  max-width: 820px;
  margin: 0 auto;
  padding: 24px 16px 48px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.done {
  display: grid;
  gap: 8px;
}
.answer {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
