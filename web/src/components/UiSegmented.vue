<script setup lang="ts" generic="V extends string | number">
/** A small set of mutually exclusive choices shown side by side (instead of radios or a short select). */
defineProps<{ modelValue: V; options: { value: V; label: string; title?: string }[]; size?: "sm" | "md"; ariaLabel?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: V]; change: [value: V] }>();
function pick(v: V) {
  emit("update:modelValue", v);
  emit("change", v);
}
function onKey(e: KeyboardEvent, options: { value: V }[], current: V) {
  const i = options.findIndex((o) => o.value === current);
  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const next = options[(i + d + options.length) % options.length];
  pick(next.value);
  ((e.currentTarget as HTMLElement).querySelectorAll("button")[options.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
}
</script>

<template>
  <div class="ui-seg" :class="size ?? 'md'" role="radiogroup" :aria-label="ariaLabel" @keydown="onKey($event, options, modelValue)">
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      :aria-checked="o.value === modelValue"
      :tabindex="o.value === modelValue ? 0 : -1"
      :title="o.title"
      :class="{ on: o.value === modelValue }"
      @click="pick(o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-seg {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border-radius: 9px;
  background: var(--sunken);
  border: 1px solid var(--line);
  max-width: 100%;
  overflow-x: auto;
}
.ui-seg button {
  border: 0;
  background: none;
  color: var(--ink-2);
  height: 30px;
  padding: 0 12px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}
.ui-seg.sm button {
  height: 24px;
  padding: 0 9px;
  font-size: 12.5px;
}
.ui-seg button:hover {
  color: var(--ink);
}
.ui-seg button.on {
  background: var(--panel);
  color: var(--ink);
  font-weight: 550;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.ui-seg button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}
</style>
