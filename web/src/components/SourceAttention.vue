<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { del, post, put, type Source } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { fmtTime, toast } from "../store";

/**
 * How much a source matters, and notes on its parts (outdated / wrong / key). The level decides
 * search rank and whether the source is digested; notes travel with search hits and readings.
 */
export type SourceNote = { id: number; sourceId: string; lineStart: number | null; lineEnd: number | null; kind: "outdated" | "wrong" | "key" | "note"; note: string; ref: string | null; by: string; createdAt: string };

const props = defineProps<{ source: Source; notes: SourceNote[] }>();
const emit = defineEmits<{ changed: []; goLine: [from: number, to: number] }>();

type Level = "focus" | "normal" | "reference" | "ignore";
const levelOptions: { value: Level; label: string; title: string }[] = [
  { value: "focus", label: "重点关注", title: "工作依据：检索排在前面，整理时先读" },
  { value: "normal", label: "一般", title: "默认" },
  { value: "reference", label: "仅检索", title: "历史资料、背景：能检索到，排序靠后，不整理" },
  { value: "ignore", label: "忽略", title: "没有信息量：不进检索，不整理" },
];
const BY: Record<string, string> = { owner: "你定的", agent: "Agent 定的", rule: "规则定的" };
const level = ref<Level>("normal");
watch(() => props.source, (s) => (level.value = (s.attention as Level | null | undefined) ?? "normal"), { immediate: true });
async function setLevel(v: Level) {
  try {
    await put(`/api/sources/${props.source.id}/attention`, { level: v === "normal" ? null : v });
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const NOTE_LABEL: Record<SourceNote["kind"], string> = { outdated: "已过时", wrong: "有误", key: "关键", note: "备注" };
const noteKinds = (Object.keys(NOTE_LABEL) as SourceNote["kind"][]).map((k) => ({ value: k, label: NOTE_LABEL[k] }));
const adding = ref(false);
const draft = ref({ kind: "outdated" as SourceNote["kind"], from: "", to: "", note: "", ref: "" });
const sorted = computed(() => [...props.notes].sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0)));
async function addNote() {
  const d = draft.value;
  const from = d.from ? Number(d.from) : null;
  try {
    await post(`/api/sources/${props.source.id}/notes`, { kind: d.kind, lineStart: from, lineEnd: d.to ? Number(d.to) : from, note: d.note.trim(), ref: d.ref.trim() || null });
    draft.value = { kind: "outdated", from: "", to: "", note: "", ref: "" };
    adding.value = false;
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function removeNote(n: SourceNote) {
  if (!(await confirmDialog("删除这条标注？", { okText: "删除", danger: true }))) return;
  try {
    await del(`/api/source-notes/${n.id}`);
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const lines = (n: SourceNote) => (n.lineStart === null ? "整份" : n.lineEnd && n.lineEnd !== n.lineStart ? `L${n.lineStart}–${n.lineEnd}` : `L${n.lineStart}`);
const refMarkdown = (r: string) => (/^(src|mem):|^\[\[/.test(r) ? (r.startsWith("[[") ? r : `[${r}](${r})`) : r);
</script>

<template>
  <div class="attention small">
    <div class="row wrap gap">
      <span class="muted">关注程度</span>
      <UiSegmented v-model="level" size="sm" aria-label="关注程度" :options="levelOptions" @change="setLevel" />
      <span v-if="source.attention && source.attentionBy && source.attentionBy !== 'owner'" class="muted">{{ BY[source.attentionBy] }}</span>
      <span class="spacer" />
      <button class="btn ghost sm" type="button" :aria-expanded="adding" @click="adding = !adding"><Icon name="plus" :size="13" />标注</button>
    </div>
    <div v-if="adding" class="add stack">
      <div class="row wrap gap">
        <UiSelect v-model="draft.kind" size="sm" width="96px" :options="noteKinds" aria-label="标注类型" />
        <input v-model="draft.from" class="input sm lines" inputmode="numeric" placeholder="起始行" aria-label="起始行" />
        <input v-model="draft.to" class="input sm lines" inputmode="numeric" placeholder="结束行" aria-label="结束行" />
        <span class="muted">不填行号表示整份</span>
      </div>
      <input v-model="draft.note" class="input sm" placeholder="哪里过时、现在是什么，或为什么关键" aria-label="标注内容" />
      <div class="row wrap gap">
        <input v-model="draft.ref" class="input sm grow" placeholder="以哪份为准（可选：src:…、mem:… 或 [[页面]]）" aria-label="以哪份为准" />
        <button class="btn sm primary" :disabled="!draft.note.trim()" @click="addNote">加上</button>
      </div>
    </div>
    <ul v-if="sorted.length" class="notes">
      <li v-for="n in sorted" :key="n.id" :class="n.kind">
        <span class="badge" :class="{ danger: n.kind === 'wrong', warn: n.kind === 'outdated', accent: n.kind === 'key' }">{{ NOTE_LABEL[n.kind] }}</span>
        <a v-if="n.lineStart !== null" href="#" class="mono" @click.prevent="emit('goLine', n.lineStart!, n.lineEnd ?? n.lineStart!)">{{ lines(n) }}</a>
        <span v-else class="muted">整份</span>
        <span class="text">{{ n.note }}<template v-if="n.ref"> · 以 <Markdown class="inline" :source="refMarkdown(n.ref)" :space="source.spaceId" /> 为准</template></span>
        <span class="muted by" :title="fmtTime(n.createdAt)">{{ n.by === "owner" ? "你" : "Agent" }}</span>
        <button class="btn ghost sm icon" title="删除标注" @click="removeNote(n)"><Icon name="x" :size="12" /></button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.attention {
  margin-top: 10px;
  display: grid;
  gap: 8px;
}
.gap {
  gap: 8px;
}
.add {
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.lines {
  width: 72px;
}
.grow {
  flex: 1;
  min-width: 160px;
}
.notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.notes li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.notes .text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.notes .by {
  flex: none;
}
.inline,
.inline :deep(p) {
  display: inline;
  margin: 0;
}
</style>
