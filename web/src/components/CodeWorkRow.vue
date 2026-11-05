<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { branchText, progressText, type CodeWork } from "../lib/works";
import { relTime, state } from "../store";

/** One delegation or branch review in a list (the run page's “编码”, a requirement's coding). */
const props = defineProps<{ work: CodeWork; active?: boolean }>();
defineEmits<{ pick: [] }>();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const branch = computed(() => branchText(props.work, spaceName));
const about = computed(() => [props.work.item?.title, props.work.reqs.length ? `需求：${props.work.reqs.map((r) => r.title).join("、")}` : ""].filter(Boolean).join(" · "));
</script>

<template>
  <button type="button" class="cw-row" :class="{ on: active, ended: work.stage.group === 'ended' }" :title="work.title" @click="$emit('pick')">
    <span class="top"><strong>{{ work.title }}</strong><span class="badge" :class="work.stage.cls">{{ work.stage.text }}</span></span>
    <span class="meta">{{ progressText(work) }} · {{ relTime(work.updatedAt) }}</span>
    <span v-if="branch" class="meta"><Icon name="branch" :size="12" />{{ branch }}</span>
    <span v-if="about" class="meta"><Icon name="target" :size="12" />{{ about }}</span>
  </button>
</template>

<style scoped>
.cw-row { display: grid; gap: 2px; width: 100%; min-width: 0; text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 8px; cursor: pointer; color: var(--ink); font: inherit; }
.cw-row:hover { background: var(--hover); }
.cw-row.on { background: var(--accent-soft); }
.cw-row.ended { opacity: 0.72; }
.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.top strong { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top .badge { flex: none; }
.meta { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.meta :deep(svg) { flex: none; }
</style>
