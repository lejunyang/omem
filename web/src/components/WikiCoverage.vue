<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { ApiError, get, post, onServerEvent } from "../api";
import { openCitation, toast } from "../store";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{ space: string }>();
type Doc = { sourceId: string; title: string; score: number; posts: number; people: number; cites: number; items: number; ownerSet: boolean; recent: boolean };
const data = ref<{ total: number; covered: number; uncovered: Doc[]; perSpace: number } | null>(null);
const loading = ref(true), running = ref(false), error = ref("");
let seq = 0;
let refresh: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const request = ++seq, space = props.space;
  loading.value = true;
  error.value = "";
  try {
    const result = await get<NonNullable<typeof data.value>>(`/api/wiki/${space}/coverage`);
    if (request === seq && space === props.space) data.value = result;
  } catch (e) {
    if (request === seq && space === props.space) {
      data.value = null;
      // Read-only members do not have access to the coverage list.
      if (!(e instanceof ApiError && e.status === 403)) error.value = "重点文档统计暂时取不到";
    }
  } finally { if (request === seq && space === props.space) loading.value = false; }
}
watch(() => props.space, () => { data.value = null; error.value = ""; running.value = false; void load(); }, { immediate: true });
async function write() {
  const space = props.space;
  running.value = true;
  try {
    const result = await post<{ sourceIds: string[] }[]>(`/api/wiki/${space}/coverage/run`, {});
    if (space !== props.space) return;
    toast(result.length ? `已安排 ${result.reduce((n, r) => n + r.sourceIds.length, 0)} 份重点文档的规划与写作` : "暂时没有可补写的文档");
    await load();
  } catch (e) { if (space === props.space) toast(String(e)); }
  finally { if (space === props.space) running.value = false; }
}
const off = onServerEvent((e) => {
  if (e.type === "changed" && ["page", "source"].includes(e.entity) && (!e.spaceId || e.spaceId === props.space)) {
    clearTimeout(refresh);
    refresh = setTimeout(() => void load(), 500);
  }
});
onBeforeUnmount(() => { seq++; clearTimeout(refresh); off(); });
</script>

<template>
  <div class="coverage">
    <Skeleton v-if="loading && !data" :rows="1" variant="lines" />
    <p v-else-if="error" class="small muted">{{ error }} <button class="btn sm ghost" @click="error = ''; load()">重试</button></p>
    <!-- A space with no document marked as important has nothing to say here. -->
    <details v-else-if="data && data.total > 0">
      <summary>重点文档 {{ data.covered }} / {{ data.total }} 份已写进页面</summary>
      <div class="stack body">
        <p class="small muted">按贴链接、引用和事项等信号排序；近 30 天试过的暂不再选。最多显示 20 份。</p>
        <button class="btn primary" :disabled="running || !data.uncovered.length || !data.perSpace" @click="write">{{ running ? "正在安排…" : "现在写这几份" }}<span v-if="data.perSpace">（最多 {{ data.perSpace }} 份）</span></button>
        <p v-if="!data.uncovered.length" class="small muted">暂时没有可补写的重点文档。</p>
        <ol v-else>
          <li v-for="doc in data.uncovered" :key="doc.sourceId">
            <button class="doc" @click="openCitation({ kind: 'source', id: doc.sourceId })">{{ doc.title }}</button>
            <p class="small muted">得分 {{ doc.score }} · 贴过 {{ doc.posts }} 次，共 {{ doc.people }} 人 · 被引用 {{ doc.cites }} 次 · {{ doc.items }} 个事项引用 · {{ doc.ownerSet ? "本人定级" : "非本人定级" }} · {{ doc.recent ? "近 90 天修改" : "90 天前修改" }}</p>
          </li>
        </ol>
      </div>
    </details>
  </div>
</template>

<style scoped>
.coverage { min-width: 0; max-width: 760px; margin: 0 auto 16px; overflow-wrap: anywhere; }
summary { cursor: pointer; font-size: 13px; color: var(--muted); }
.body { padding: 12px 0; }
.body > .btn { align-self: flex-start; justify-self: start; width: fit-content; max-width: 100%; flex-wrap: wrap; }
ol { margin: 0; padding-left: 24px; }
li { margin: 12px 0; }
.doc { border: 0; background: none; padding: 0; font: inherit; text-align: left; color: var(--accent); cursor: pointer; overflow-wrap: anywhere; }
.doc:hover { text-decoration: underline; }
li p { margin: 4px 0 0; }
</style>
