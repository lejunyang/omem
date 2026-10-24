<script setup lang="ts">
import type { Memory } from "../api";
import Icon from "./Icon.vue";
import { fmtTime, memoryKindLabel, statusLabel } from "../store";

defineProps<{
  m: Memory;
  /** Hide space/model provenance lines (e.g. inside one agent's own list). */
  compact?: boolean;
  /** Show the “move to folder” action (the memory page). */
  movable?: boolean;
}>();
const emit = defineEmits<{
  (e: "retract", m: Memory): void;
  (e: "tag", tag: string): void;
  (e: "history", m: Memory): void;
  (e: "sources", m: Memory): void;
  (e: "tags", m: Memory): void;
  (e: "edit", m: Memory): void;
  (e: "move", m: Memory): void;
}>();

const reviewLabel: Record<string, string> = { keep: "复核保留", rewrite: "复核改写", retract: "复核撤回", unclear: "复核未定" };
function verdictClass(v?: string | null) {
  return v === "keep" ? "ok" : v === "retract" ? "danger" : "";
}
</script>

<template>
  <div class="mem" :class="m.status">
    <div class="row head small wrap">
      <span class="badge" :class="{ accent: m.kind === 'agreement' || m.kind === 'decision' }">{{ memoryKindLabel[m.kind] ?? m.kind }}</span>
      <span v-if="m.status !== 'active'" class="badge warn">{{ statusLabel[m.status] ?? m.status }}</span>
      <span v-if="m.createdBy === 'agent' && !m.reviewedAt && m.status === 'active'" class="badge">待复核</span>
      <span v-else-if="m.reviewVerdict && m.createdBy === 'agent'" class="badge" :class="verdictClass(m.reviewVerdict)" :title="m.reviewNote ?? ''">{{ reviewLabel[m.reviewVerdict] ?? m.reviewVerdict }}</span>
      <span v-if="m.agent" class="badge accent" title="只给这个 Agent 档案使用的做法或偏好">{{ m.agent }} 专用</span>
      <span v-if="m.supersedes" class="badge">有更早版本</span>
      <span v-for="t in m.tags ?? []" :key="t" class="tag" role="button" tabindex="0" @click="emit('tag', t)" @keydown.enter="emit('tag', t)">#{{ t }}</span>
      <span class="muted">{{ fmtTime(m.validFrom, false) }}{{ m.validTo ? ` → ${fmtTime(m.validTo, false)}` : " 起" }}</span>
      <span v-if="!compact && m.spaceId !== 'personal'" class="muted">· {{ m.spaceId }}</span>
      <span v-if="!compact && (m.model || m.agentProfile)" class="muted" title="写入这条记忆的后端与模型">· {{ [m.agentProfile, m.model].filter(Boolean).join(" · ") }}</span>
      <span class="spacer" />
      <div v-if="m.status === 'active'" class="actions row">
        <button v-if="m.supersedes || m.supersededBy" class="btn ghost sm" @click="emit('history', m)"><Icon name="history" :size="14" />演变</button>
        <button v-if="m.sourceRefs.length" class="btn ghost sm" @click="emit('sources', m)"><Icon name="quote" :size="14" />依据</button>
        <button v-if="movable" class="btn ghost sm" :title="m.folder ? `目录：${m.folder}` : '还没放进目录'" @click="emit('move', m)"><Icon name="folder" :size="14" />移动</button>
        <button class="btn ghost sm" @click="emit('tags', m)">标签</button>
        <button class="btn ghost sm" @click="emit('edit', m)"><Icon name="edit" :size="14" />更正</button>
        <button class="btn ghost sm icon" title="撤回" aria-label="撤回" @click="emit('retract', m)"><Icon name="trash" :size="14" /></button>
      </div>
    </div>
    <div v-if="$slots.editor" class="edit-slot"><slot name="editor" :m="m" /></div>
    <p v-else class="content">
      <strong v-if="m.subject" class="subject-line">{{ m.subject }}：</strong>{{ m.content }}
    </p>
    <p v-if="m.reviewNote && m.reviewVerdict && m.reviewVerdict !== 'keep'" class="note small muted">复核：{{ m.reviewNote }}</p>
  </div>
</template>

<style scoped>
.mem {
  border-top: 1px solid var(--line);
  padding: 10px 0;
}
.head {
  gap: 6px;
}
.tag {
  color: var(--accent);
  cursor: pointer;
}
.tag:hover {
  text-decoration: underline;
}
.actions {
  opacity: 0.6;
  gap: 0;
}
.mem:hover .actions,
.mem:focus-within .actions {
  opacity: 1;
}
.content {
  margin: 6px 0 0;
  font-size: 15px;
  line-height: 1.7;
}
.subject-line {
  font-weight: 600;
}
.note {
  margin: 4px 0 0;
}
.mem.superseded .content,
.mem.retracted .content {
  color: var(--muted);
  text-decoration: line-through;
}
</style>
