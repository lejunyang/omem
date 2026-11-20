<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";

/**
 * A panel from the right edge for one thing opened from a list (a question waiting for an answer, a
 * number's records): the list stays where it was. Esc closes it unless something above it (the citation
 * drawer) took the key first; focus returns to what opened it.
 */
const props = withDefaults(defineProps<{ label: string; tag?: string; tone?: "warn" | "accent" | ""; width?: number }>(), { tone: "", width: 520 });
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const opener = document.activeElement as HTMLElement | null;

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    emit("close");
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void nextTick(() => panel.value?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  opener?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="scrim" @click="emit('close')" />
    <aside ref="panel" class="side-sheet" role="dialog" :aria-label="props.label" tabindex="-1" :style="{ '--sheet-width': `${props.width}px` }">
      <header>
        <span v-if="props.tag" class="tag" :class="props.tone">{{ props.tag }}</span>
        <slot name="head" />
        <span class="grow" />
        <slot name="tools" />
        <button type="button" class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="16" /></button>
      </header>
      <div class="body"><slot /></div>
      <footer v-if="$slots.foot"><slot name="foot" /></footer>
    </aside>
  </Teleport>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; background: rgba(10, 12, 16, 0.18); z-index: 38; }
.side-sheet {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(var(--sheet-width, 520px), 100vw);
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  z-index: 39;
  display: flex;
  flex-direction: column;
  outline: none;
}
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 18px; border-bottom: 1px solid var(--line); min-height: 52px; min-width: 0; }
.grow { flex: 1; }
.tag { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px; background: var(--sunken); color: var(--ink-2); white-space: nowrap; }
.tag.warn { background: var(--warn-soft); color: var(--warn); }
.tag.accent { background: var(--accent-soft); color: var(--accent); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px; display: grid; gap: 14px; align-content: start; }
footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 18px; border-top: 1px solid var(--line); }
</style>
