<script lang="ts">
/** What `GET /api/slots` lists: one block to draw, and the item, stage and object it is for. */
export type SlotEntry = { key: string; plugin: string; pluginName: string; block: string; label: string; at: string; item: string | null; stage: string | null; object: { id: string; title: string } | null };
</script>

<script setup lang="ts">
import { onErrorCaptured, ref, watch } from "vue";
import type { ViewComponent } from "@omem-ai/plugin-sdk/blocks";
import { get } from "../api";
import Skeleton from "./Skeleton.vue";
import UiView from "./UiView.vue";

/**
 * One plugin block in a slot (docs/v2/flows.md §8, “界面插槽”): its content is read on its own, so a
 * plugin that fails, is slow or draws something odd shows its error here and nowhere else.
 */
const props = defineProps<{ entry: SlotEntry; space?: string; version?: number }>();
const view = ref<{ title: string | null; components: ViewComponent[] } | null>(null), error = ref(""), loading = ref(true);
let seq = 0;
async function load() {
  const request = ++seq, e = props.entry;
  const q = new URLSearchParams({ at: e.at });
  if (e.item) q.set("item", e.item);
  if (e.stage) q.set("stage", e.stage);
  if (e.object) q.set("object", e.object.id);
  try {
    const r = await get<{ title: string | null; components: ViewComponent[] }>(`/api/slots/${encodeURIComponent(e.plugin)}/${encodeURIComponent(e.block)}?${q}`);
    if (request === seq) { view.value = r; error.value = ""; }
  } catch (err) {
    if (request === seq) { view.value = null; error.value = (err as Error).message; }
  } finally {
    if (request === seq) loading.value = false;
  }
}
watch(() => [props.entry.key, props.version], () => { loading.value = !view.value; void load(); }, { immediate: true });
// Drawing it went wrong (a component the renderer could not take): this block only.
onErrorCaptured((err) => {
  view.value = null;
  error.value = `画不出来：${(err as Error).message}`;
  return false;
});
</script>

<template>
  <article class="plugin-slot" :aria-label="`${entry.pluginName}：${entry.label}`">
    <div class="slot-head">
      <span class="slot-plugin">{{ entry.pluginName }}</span>
      <span v-if="entry.object" class="slot-object" :title="entry.object.title">{{ entry.object.title }}</span>
    </div>
    <Skeleton v-if="loading" variant="text" :rows="2" />
    <p v-else-if="error" class="slot-error small" role="alert">没显示出来：{{ error }} <button type="button" class="link" @click="load">重试</button></p>
    <UiView v-else-if="view" :components="view.components" :title="view.title ?? undefined" :space="space" class="slot-view" />
  </article>
</template>

<style scoped>
.plugin-slot { display: grid; gap: 6px; min-width: 0; }
.slot-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: 12px; color: var(--muted); }
.slot-plugin { flex: none; letter-spacing: 0.04em; }
.slot-object { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot-error { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.slot-view { max-width: none; }
.link { padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; }
.link:hover { text-decoration: underline; }
</style>
