<script setup lang="ts">
/** A small prefix tag that distinguishes the PROVENANCE LAYER of a block of
 * content (raw evidence vs derived explanation vs candidate guess vs stale vs
 * load error). This is intentionally NOT a relation-status badge: edge status
 * stays on OmBadge. See docs/implementation/code-wiki-ui-design.md §9. */
type Kind = "raw" | "derived" | "candidate" | "stale" | "error";
const props = defineProps<{ kind: Kind; sourceNote?: string }>();

const LABEL: Record<Kind, string> = {
  raw: "原始证据",
  derived: "派生说明",
  candidate: "候选 · 未登记",
  stale: "已过期",
  error: "加载失败",
};
</script>

<template>
  <div class="om-status-line" :class="kind" role="note">
    <span class="tag">{{ LABEL[kind] }}</span>
    <small v-if="sourceNote" class="note">{{ sourceNote }}</small>
  </div>
</template>

<style scoped>
.om-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
}
.tag {
  font-size: 11px;
  letter-spacing: 0.04em;
  border: 1px solid var(--om-line);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--om-secondary);
  background: var(--om-soft);
  white-space: nowrap;
}
.derived .tag {
  color: var(--om-ink);
  background: var(--om-panel);
  border-left: 3px solid var(--om-ink);
}
.candidate .tag {
  color: var(--om-warning);
  background: #f6f2e8;
  border-color: #e3d5b8;
}
.stale .tag {
  color: var(--om-muted);
  text-decoration: line-through;
}
.error .tag {
  color: var(--om-danger);
  background: #fff0f0;
  border-color: #eccaca;
}
.note {
  color: var(--om-muted);
}
</style>
