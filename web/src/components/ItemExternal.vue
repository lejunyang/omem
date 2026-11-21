<script setup lang="ts">
import { ref, watch } from "vue";
import { post } from "../api";
import { relTime } from "../store";
import { keyLabel, type ItemExternal } from "../lib/item-sync";

/**
 * The platform entry an item was brought in from (an issue, a requirement on a tracker; src/items/providers.ts):
 * what it is called there, its state there and when it was last read. A status changed here that has
 * not reached the platform yet is answered in place: send it, or keep the change on this side only.
 */
const props = withDefaults(defineProps<{ itemId: string; external: ItemExternal; editable?: boolean }>(), { editable: true });
const emit = defineEmits<{ changed: [] }>();
const busy = ref(false), failed = ref("");
watch(() => [props.itemId, props.external.write?.id], () => { failed.value = ""; });

async function decide(confirm: boolean) {
  const w = props.external.write;
  if (!w || busy.value) return;
  busy.value = true; failed.value = "";
  try { await post(`/api/items/${props.itemId}/writeback`, { writeId: w.id, confirm }); }
  catch (e) { failed.value = (e as Error).message; }
  finally { busy.value = false; emit("changed"); }
}
</script>

<template>
  <section class="item-external" aria-label="来自外部平台">
    <div class="section-title">来自{{ external.providerLabel ?? "外部平台" }}</div>
    <div class="ext-head">
      <a :href="external.url" target="_blank" rel="noopener noreferrer" class="ext-title"><span class="ext-key">{{ keyLabel(external.key) }}</span>{{ external.title }}</a>
      <span class="ext-status" title="它在那边的状态">{{ external.status }}</span>
    </div>
    <div class="ext-foot muted">
      <span v-if="external.assignee">{{ external.assignee }} · </span>
      <span>{{ relTime(external.syncedAt) }}{{ external.direction === "push" ? "写回过" : "读的" }}</span>
      <span v-if="!external.providerLabel"> · 读它的插件停用了，状态停在最后一次看到的样子</span>
    </div>
    <p v-if="external.error && !external.write" class="warn-text small" role="status">上次没同步成：{{ external.error }}</p>

    <div v-if="external.write" class="ext-write" role="group" aria-label="还没写回的状态">
      <template v-if="external.write.state === 'pending'">
        <span class="w-text">这边的状态改了。把那边也改成“{{ external.write.status }}”吗？</span>
        <span v-if="editable" class="w-acts"><button type="button" class="btn sm primary" :disabled="busy" @click="decide(true)">{{ busy ? "写回中…" : "写回" }}</button><button type="button" class="btn sm ghost" :disabled="busy" @click="decide(false)">只改这边</button></span>
      </template>
      <template v-else-if="external.write.state === 'ready'">
        <span class="w-text">下次同步时把那边改成“{{ external.write.status }}”。</span>
        <span v-if="editable" class="w-acts"><button type="button" class="btn sm ghost" :disabled="busy" @click="decide(false)">不写回了</button></span>
      </template>
      <template v-else-if="external.write.state === 'conflict'">
        <span class="w-text">那边在你改之后又变了，这次没有写回“{{ external.write.status }}”。还要写回的话，把这边的状态再改一次。</span>
        <span v-if="editable" class="w-acts"><button type="button" class="btn sm ghost" :disabled="busy" @click="decide(false)">知道了</button></span>
      </template>
      <template v-else>
        <span class="w-text">没能把那边改成“{{ external.write.status }}”：{{ external.write.error ?? "没有说明原因" }}</span>
        <span v-if="editable" class="w-acts"><button type="button" class="btn sm" :disabled="busy" @click="decide(true)">{{ busy ? "写回中…" : "再试一次" }}</button><button type="button" class="btn sm ghost" :disabled="busy" @click="decide(false)">只改这边</button></span>
      </template>
    </div>
    <p v-if="failed" class="error small" role="alert">{{ failed }}</p>
  </section>
</template>

<style scoped>
.item-external { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.item-external > p { margin: 0; }
.ext-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
.ext-title { flex: 1 1 12em; min-width: 0; }
.ext-key { margin-right: 6px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ext-status { flex: none; font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
.ext-foot { font-size: 12px; }
.ext-write { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 4px; padding: 8px 10px; border-radius: 8px; background: var(--warn-soft); }
.w-text { flex: 1 1 16em; min-width: 0; }
.w-acts { display: flex; gap: 6px; flex: none; }
.warn-text { color: var(--warn); }
.error { color: var(--danger); }
</style>
