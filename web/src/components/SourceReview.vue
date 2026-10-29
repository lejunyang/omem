<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post } from "../api";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import VirtualList from "./VirtualList.vue";

/**
 * Agents' judgements waiting for the owner (sources/attention.ts `reviewQueue`): notes that change
 * ranking (outdated, wrong, not to search) and folder levels, largest impact first — how often a note
 * shaped search results, how many sources a folder holds. Confirm makes a note weigh in full (wrong and
 * not-to-search passages then leave search); reject removes its effect and the agent cannot add it again.
 * Notes whose passage is gone after a re-read are listed too.
 */
type Note = { id: number; sourceId: string; title: string; lineStart: number | null; lineEnd: number | null; kind: string; note: string; ref: string | null; quote: string | null; by: string; status: string; staleAt: string | null; hits: number };
type LevelItem = { key: string; title: string; path: string; level: string; reason: string; sources: number; at: string };
type Item = { type: "note"; note: Note } | { type: "level"; level: LevelItem };

const props = defineProps<{ space: string }>();
const emit = defineEmits<{ count: [n: number]; changed: [] }>();
const data = ref<{ notes: Note[]; levels: LevelItem[] } | null>(null);
const busy = ref(new Set<string>());

async function load() {
  try {
    data.value = await get(`/api/sources/review?space=${encodeURIComponent(props.space)}`);
    emit("count", data.value!.notes.length + data.value!.levels.length);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
watch(() => props.space, load, { immediate: true });
defineExpose({ load });

const items = computed<Item[]>(() => [...(data.value?.levels ?? []).map((l) => ({ type: "level" as const, level: l })), ...(data.value?.notes ?? []).map((n) => ({ type: "note" as const, note: n }))]);
const keyOf = (i: Item) => (i.type === "note" ? `n${i.note.id}` : `l${i.level.key}`);
const NOTE_LABEL: Record<string, string> = { outdated: "已过时", wrong: "有误", key: "关键", note: "备注", exclude: "不检索" };
const LEVEL_LABEL: Record<string, string> = { focus: "重点关注", normal: "一般", reference: "仅检索", ignore: "忽略" };
const lines = (n: Note) => (n.lineStart === null ? "整份" : n.lineEnd && n.lineEnd !== n.lineStart ? `L${n.lineStart}–${n.lineEnd}` : `L${n.lineStart}`);
const linkOf = (n: Note) => ({ path: `/sources/${n.sourceId}`, query: n.lineStart ? { from: String(n.lineStart), to: String(n.lineEnd ?? n.lineStart) } : {} });

async function decide(i: Item, decision: "confirm" | "reject") {
  const k = keyOf(i);
  busy.value = new Set(busy.value).add(k);
  try {
    if (i.type === "note") await post(`/api/source-notes/${i.note.id}/review`, { decision });
    else await post("/api/sources/node-level/review", { space: props.space, node: i.level.key, decision });
    await load();
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    const b = new Set(busy.value);
    b.delete(k);
    busy.value = b;
  }
}
</script>

<template>
  <Skeleton v-if="!data" :rows="6" />
  <div v-else-if="!items.length" class="empty small"><p>没有待复核的判断。Agent 新写的有误、过时、不检索标注和目录定级会列在这里。</p></div>
  <VirtualList v-else :items="items" :item-key="keyOf" :estimate="96">
    <template #default="{ item: i }">
      <div class="rv">
        <template v-if="i.type === 'level'">
          <div class="head"><span class="badge accent">目录定级</span><span class="lv">{{ LEVEL_LABEL[i.level.level] }}</span><span class="muted small">{{ i.level.sources }} 份</span></div>
          <div class="ttl ellipsis" :title="i.level.path">{{ i.level.path }}</div>
          <div v-if="i.level.reason" class="muted small why">{{ i.level.reason }}</div>
        </template>
        <template v-else>
          <div class="head">
            <span class="badge" :class="{ danger: i.note.kind === 'wrong' || i.note.kind === 'exclude', warn: i.note.kind === 'outdated' }">{{ NOTE_LABEL[i.note.kind] ?? i.note.kind }}</span>
            <span v-if="i.note.staleAt" class="badge warn" title="文档重新读取后找不到被标的那段">原文已改动</span>
            <span class="muted small">{{ i.note.hits ? `命中 ${i.note.hits} 次` : "还没命中过" }}</span>
          </div>
          <router-link :to="linkOf(i.note)" class="ttl ellipsis" :title="i.note.title">{{ i.note.title }} · {{ lines(i.note) }}</router-link>
          <div v-if="i.note.quote" class="quote small">“{{ i.note.quote }}”</div>
          <div class="small why">{{ i.note.note }}<span v-if="i.note.ref" class="muted"> · 以 {{ i.note.ref }} 为准</span></div>
        </template>
        <div class="row gap acts">
          <button class="btn sm" type="button" :disabled="busy.has(keyOf(i))" @click="decide(i, 'confirm')">确认</button>
          <button class="btn ghost sm" type="button" :disabled="busy.has(keyOf(i))" @click="decide(i, 'reject')">否定</button>
        </div>
      </div>
    </template>
  </VirtualList>
</template>

<style scoped>
.rv {
  display: grid;
  gap: 4px;
  padding: 8px 8px 10px;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lv {
  font-size: 12px;
  color: var(--ink);
}
.ttl {
  font-size: 13px;
  color: var(--ink);
  min-width: 0;
}
.quote {
  color: var(--ink-2);
  border-left: 2px solid var(--line-strong);
  padding-left: 6px;
  overflow-wrap: anywhere;
}
.why {
  overflow-wrap: anywhere;
}
.gap {
  gap: 6px;
}
.acts {
  margin-top: 2px;
}
</style>
