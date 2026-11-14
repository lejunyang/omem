<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";

/**
 * An explanation that takes one line: its beginning says what the setting is, the rest waits behind
 * an (i) — shown while the pointer is on it or it has focus, pinned by a click (touch). A text that
 * fits on the line has no (i). `lead`: a page's opening paragraph, two lines.
 */
defineProps<{ lead?: boolean }>();
const brief = ref<HTMLElement>();
const clipped = ref(false);
const hover = ref(false);
const pinned = ref(false);
let observer: ResizeObserver | null = null;
const measure = () => {
  const el = brief.value;
  if (el) clipped.value = el.scrollHeight > el.clientHeight + 1;
};
function away(e: Event) {
  if (pinned.value && !(e.target as HTMLElement).closest(".help-text")?.contains(brief.value ?? null)) pinned.value = false;
}
onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (brief.value) observer.observe(brief.value);
  document.addEventListener("click", away);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  document.removeEventListener("click", away);
});
</script>

<template>
  <div class="help-text" :class="{ lead, open: hover || pinned }" @keydown.esc="pinned = false">
    <p ref="brief" class="brief" :class="lead ? 'muted' : 'muted small'"><slot /></p>
    <button v-if="clipped" type="button" class="more" :aria-expanded="hover || pinned" aria-label="完整说明" title="" @mouseenter="hover = true" @mouseleave="hover = false" @focus="hover = true" @blur="hover = false" @click.stop="pinned = !pinned">
      <Icon name="info" :size="14" />
    </button>
    <div v-if="clipped && (hover || pinned)" class="pop small" role="tooltip" @mouseenter="hover = true" @mouseleave="hover = false"><slot /></div>
  </div>
</template>

<style scoped>
.help-text {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.brief {
  flex: 1;
  min-width: 0;
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  overflow: hidden;
}
.lead .brief {
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.more {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: -1px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  cursor: help;
}
.more:hover,
.open .more {
  color: var(--accent);
  background: var(--accent-soft);
}
.pop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  right: 0;
  width: min(560px, 100%);
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink-2);
  box-shadow: var(--shadow-lg);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
</style>
