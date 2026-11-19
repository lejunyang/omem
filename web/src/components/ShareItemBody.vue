<script setup lang="ts">
import { codeLines, safe, textLines, type ShareItem } from "../lib/share";

/** The body of one copied item in a read-only share: code or text lines with the cited ones marked, or rendered Markdown. */
defineProps<{ item: Exclude<ShareItem, { kind: "review" }> }>();
</script>

<template>
  <template v-if="item.kind === 'source'">
    <div v-if="!item.lines.length" class="muted small">这个原件没有可分享的文字。</div>
    <div v-else-if="item.format === 'markdown'" class="prose" v-html="safe(item.lines.join('\n'))" />
    <div v-else class="lines" :class="item.format" role="table">
      <div v-for="l in item.format === 'code' ? codeLines(item) : textLines(item)" :key="l.n" class="line" :class="{ hit: l.hit }" role="row">
        <span class="ln" role="cell">{{ l.n }}</span><code role="cell" v-html="l.html" />
      </div>
    </div>
    <p v-if="item.lines.length && item.start + item.lines.length - 1 < item.total" class="muted small">
      {{ item.from ? `只分享了第 ${item.start}–${item.start + item.lines.length - 1} 行（共 ${item.total} 行）。` : `只分享了前 ${item.lines.length} 行（共 ${item.total} 行）。` }}
    </p>
  </template>
  <div v-else-if="item.kind === 'page'" class="prose" v-html="safe(item.markdown)" />
  <div v-else class="prose" v-html="safe(item.text)" />
</template>

<style scoped>
.lines {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 8px 0;
  overflow-x: auto;
}
.line {
  display: flex;
  min-width: max-content;
}
.lines.text .line {
  min-width: 0;
}
.line.hit {
  background: var(--mark);
}
.ln {
  flex: none;
  width: 3.5em;
  padding-right: 10px;
  text-align: right;
  color: var(--muted);
  user-select: none;
}
.line code {
  white-space: pre;
  padding-right: 12px;
  background: none;
  font: inherit;
}
.lines.text .line code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}
p {
  margin: 0;
}
</style>
