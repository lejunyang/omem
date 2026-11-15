<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, onServerResync } from "../api";
import PluginSlot, { type SlotEntry } from "./PluginSlot.vue";

/**
 * Plugin blocks placed on this page (docs/v2/flows.md §8, “界面插槽”): the item panel, under the selected
 * flow stage, or the today page. Nothing shows when no plugin puts anything here; a plugin turned off or
 * no longer trusted drops out on the next load.
 */
const props = defineProps<{ at: "item.panel" | "flow.stage" | "today"; itemId?: string; stage?: string; space?: string }>();
const entries = ref<SlotEntry[]>([]), version = ref(0);
let seq = 0;
async function load() {
  const request = ++seq;
  const q = new URLSearchParams({ at: props.at });
  if (props.itemId) q.set("item", props.itemId);
  if (props.stage) q.set("stage", props.stage);
  // The slots are an extra: when they cannot be listed the page goes on without them.
  const list = await get<SlotEntry[]>(`/api/slots?${q}`).catch(() => [] as SlotEntry[]);
  if (request === seq) entries.value = list;
}
watch(() => [props.at, props.itemId, props.stage], () => { entries.value = []; void load(); }, { immediate: true });
const off = onServerEvent((e) => {
  // The item changed (an object linked, its state read again) or a plugin was loaded again: list and contents anew.
  if ((e.type === "changed" && e.entity === "item" && e.id === props.itemId) || (e.type === "plugin" && !e.conversationId)) {
    version.value++;
    void load();
  }
});
const resync = onServerResync(() => { version.value++; void load(); });
onBeforeUnmount(() => { ++seq; off(); resync(); });
</script>

<template>
  <div v-if="entries.length" class="plugin-slots">
    <PluginSlot v-for="e in entries" :key="e.key" :entry="e" :space="space" :version="version" />
  </div>
</template>

<style scoped>
.plugin-slots { display: grid; gap: 14px; min-width: 0; }
</style>
