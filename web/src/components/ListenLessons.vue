<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { onServerEvent, post } from "../api";
import type { ListenDetail } from "../lib/listen";
import { fmtTime, relTime, toast } from "../store";
import Icon from "./Icon.vue";
import ListenCases from "./ListenCases.vue";
import Markdown from "./Markdown.vue";

/**
 * A 关注's lessons and cases (GET /api/listen/:id): the lessons listen-coach wrote, a button to have
 * them filed again, then the cases they come from. On a 关注's page and on a 持续跟进 rule's 经验和案例
 * tab (the rules page). `changed`: a coaching run finished, the caller reloads.
 */
const props = defineProps<{ contextId: string; detail: Pick<ListenDetail, "playbook" | "cases" | "coaching"> }>();
const emit = defineEmits<{ changed: [] }>();
const coaching = ref(props.detail.coaching);
watch(() => props.detail.coaching, (v) => (coaching.value = v));
const busy = computed(() => !!coaching.value && ["queued", "running"].includes(coaching.value.status));
async function coach() {
  const id = props.contextId;
  try {
    const r = await post<{ runId?: string; queued?: boolean; message?: string }>(`/api/listen/${encodeURIComponent(id)}/coach`);
    if (r.runId && props.contextId === id) coaching.value = { id: r.runId, status: "queued" };
    toast(r.runId ? "开始重新整理经验，整理完这里会更新" : (r.message ?? "已经有一次整理在排队"), r.runId ? "ok" : "info");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const off = onServerEvent((e) => {
  if (e.type !== "run" || !coaching.value || coaching.value.id !== e.runId) return;
  coaching.value = { id: e.runId, status: e.status };
  if (e.status === "done" || e.status === "failed" || e.status === "cancelled") emit("changed");
});
onBeforeUnmount(off);
</script>

<template>
  <section class="chapter">
    <h2>经验<span v-if="detail.playbook.updatedAt" class="when muted small" :title="fmtTime(detail.playbook.updatedAt)">{{ relTime(detail.playbook.updatedAt) }}整理</span></h2>
    <div class="row wrap small lessons-bar">
      <router-link v-if="detail.playbook.sourceId" :to="`/sources/${detail.playbook.sourceId}`">打开经验文件</router-link>
      <span v-else class="muted">还没有经验文件</span>
      <span class="spacer" />
      <span v-if="busy" class="badge accent">{{ coaching?.status === "running" ? "正在整理" : "排队整理" }}</span>
      <router-link v-if="coaching && busy" :to="`/runs/${coaching.id}`" class="muted">看运行</router-link>
      <button type="button" class="btn sm" :disabled="busy" @click="coach"><Icon name="refresh" :size="14" />重新整理</button>
    </div>
    <Markdown v-if="detail.playbook.text" :source="detail.playbook.text" class="prose lessons" />
    <p v-else class="muted">还没有经验。案例攒到一些后它会按场景整理一次；也可以现在点“重新整理”。</p>
  </section>
  <section class="chapter">
    <h2>案例</h2>
    <p class="muted small lead">每一次：谁在哪问了什么、助手做了什么、你自己回了什么。你的纠正进下一次整理经验。</p>
    <ListenCases :cases="detail.cases" />
  </section>
</template>

<style scoped>
.chapter {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.chapter h2 {
  font-family: var(--serif);
  font-size: 19px;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.when {
  font-family: var(--sans);
  font-weight: normal;
}
.chapter > p {
  margin: 0;
}
.lessons-bar {
  gap: 8px;
}
.prose {
  line-height: 1.75;
  overflow-wrap: anywhere;
  max-width: 760px;
}
/* The lessons' own headings (one per scene) sit under the chapter's, a step smaller. */
.lessons :deep(h1),
.lessons :deep(h2) {
  font-size: 16px;
  margin-top: 14px;
}
.lessons :deep(h3) {
  font-size: 14.5px;
}
</style>
