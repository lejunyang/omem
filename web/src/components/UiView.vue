<script setup lang="ts">
import { renderView, type ViewComponent } from "@omem-ai/plugin-sdk/blocks";
import Markdown from "./Markdown.vue";
import UiPage from "./UiPage.vue";

/**
 * Display components an agent handed in (docs/v2/interactive-ui.md): drawn by the same renderer as
 * plugin pages (packages/plugin-sdk/blocks.ts); Markdown goes through omem's own component so
 * citations open in the drawer.
 */
/** `askId` / `canSubmit`: the view belongs to an open question, so an interactive page in it may answer. */
defineProps<{ components: ViewComponent[]; title?: string; space?: string; askId?: string; canSubmit?: boolean; draft?: unknown }>();
defineEmits<{ answered: [] }>();
const drawn = new WeakMap<Element, ViewComponent>();
const draw = (el: unknown, c: ViewComponent) => {
  if (!(el instanceof HTMLElement) || drawn.get(el) === c) return;
  drawn.set(el, c);
  renderView(el, [c]);
};
</script>

<template>
  <section class="ui-view" :aria-label="title || '展示'">
    <h3 v-if="title" class="ui-title">{{ title }}</h3>
    <template v-for="(c, i) in components" :key="i">
      <Markdown v-if="c.type === 'markdown'" :source="c.text" :space="space" />
      <UiPage v-else-if="c.type === 'page'" :page-id="c.id" :version="c.version" :height="c.height" :ask-id="askId" :can-submit="canSubmit" :draft="draft" @answered="$emit('answered')" />
      <div v-else :ref="(el) => draw(el, c)" />
    </template>
  </section>
</template>

<style scoped>
.ui-view {
  display: grid;
  gap: 12px;
  min-width: 0;
  max-width: 760px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--panel);
}
.ui-title {
  margin: 0;
  font: 600 16px/1.35 var(--serif);
}
.ui-view :deep(.prose p:first-child) {
  margin-top: 0;
}
</style>
