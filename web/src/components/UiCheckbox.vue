<script setup lang="ts" generic="T">
import { computed } from "vue";
import Icon from "./Icon.vue";

/**
 * Checkbox without the native control. v-model is a boolean, or an array when `value` is
 * given (the box is checked when the array contains it). `switch` renders a toggle.
 */
const props = withDefaults(defineProps<{ modelValue: boolean | T[]; value?: T; disabled?: boolean; switch?: boolean; size?: "sm" | "md"; ariaLabel?: string }>(), { size: "md" });
const emit = defineEmits<{ "update:modelValue": [value: boolean | T[]]; change: [checked: boolean] }>();

const checked = computed(() => (Array.isArray(props.modelValue) ? props.modelValue.includes(props.value as T) : !!props.modelValue));
function toggle() {
  if (props.disabled) return;
  const next = !checked.value;
  if (Array.isArray(props.modelValue)) emit("update:modelValue", next ? [...props.modelValue, props.value as T] : props.modelValue.filter((v) => v !== props.value));
  else emit("update:modelValue", next);
  emit("change", next);
}
</script>

<template>
  <label class="ui-check" :class="[size, { disabled, on: checked }]" @click.prevent="toggle">
    <span
      class="box"
      :class="{ switch: props.switch }"
      :role="props.switch ? 'switch' : 'checkbox'"
      :aria-checked="checked"
      :aria-disabled="disabled || undefined"
      :aria-label="ariaLabel"
      tabindex="0"
      @keydown.space.prevent="toggle"
      @keydown.enter.prevent="toggle"
    >
      <template v-if="!props.switch"><Icon v-if="checked" name="check" :size="size === 'sm' ? 11 : 13" /></template>
      <span v-else class="knob" />
    </span>
    <span v-if="$slots.default" class="text"><slot /></span>
  </label>
</template>

<style scoped>
.ui-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  min-width: 0;
}
.ui-check.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.text {
  min-width: 0;
}
.box {
  flex: none;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  border: 1.5px solid var(--line-strong);
  background: var(--panel);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-ink);
  transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
}
.sm .box {
  width: 15px;
  height: 15px;
  border-radius: 4px;
}
.ui-check:hover .box {
  border-color: var(--muted);
}
.on .box {
  background: var(--accent);
  border-color: var(--accent);
}
.box:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
  border-color: var(--accent);
}
.box.switch {
  width: 32px;
  height: 18px;
  border-radius: 999px;
  justify-content: flex-start;
  padding: 0 2px;
  background: var(--line-strong);
  border-color: transparent;
}
.sm .box.switch {
  width: 28px;
  height: 16px;
}
.knob {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s;
}
.sm .knob {
  width: 12px;
  height: 12px;
}
.on .box.switch {
  background: var(--accent);
}
.on .knob {
  transform: translateX(14px);
}
.sm.on .knob {
  transform: translateX(12px);
}
</style>
