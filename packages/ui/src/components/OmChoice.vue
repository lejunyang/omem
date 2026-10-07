<script setup lang="ts">
import { computed, useAttrs, useId } from "vue";
import type { StyleValue } from "vue";
import type { OmChoiceProps } from "../forms";

defineOptions({ inheritAttrs: false });
const props = defineProps<OmChoiceProps & { type: "checkbox" | "radio" }>();
const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  change: [event: Event];
}>();
const attrs = useAttrs();
function inputAttrs() {
  const { class: _class, style: _style, ...input } = attrs;
  return input;
}
const descriptionId = useId();
const choiceValue = computed(() =>
  props.value === undefined ? "on" : props.value,
);
const selection = computed({
  get: () =>
    props.modelValue === undefined
      ? props.type === "radio"
        ? props.checked
          ? choiceValue.value
          : undefined
        : (props.checked ?? false)
      : props.modelValue,
  set: (value) => emit("update:modelValue", value),
});
function describedBy() {
  return (
    [
      attrs["aria-describedby"],
      props.hint && `${descriptionId}-hint`,
      props.error && `${descriptionId}-error`,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
function labelledBy() {
  if (attrs["aria-labelledby"] !== undefined)
    return attrs["aria-labelledby"] as string;
  if (attrs["aria-label"] !== undefined) return undefined;
  return `${descriptionId}-label`;
}
</script>

<template>
  <label
    class="om-choice"
    :class="[attrs.class, { disabled, invalid: invalid || error }]"
    :style="attrs.style as StyleValue"
  >
    <input
      v-bind="inputAttrs()"
      v-model="selection"
      class="om-choice-control"
      :type="type"
      :value="choiceValue"
      :disabled="disabled"
      :indeterminate="type === 'checkbox' && indeterminate"
      :aria-labelledby="labelledBy()"
      :aria-invalid="
        invalid || error
          ? true
          : (attrs['aria-invalid'] as 'true' | 'false' | undefined)
      "
      :aria-describedby="describedBy()"
      @change="emit('change', $event)"
    />
    <span class="om-choice-copy">
      <span :id="`${descriptionId}-label`" class="om-choice-label"
        ><slot>{{ label }}</slot></span
      >
      <span v-if="hint" :id="`${descriptionId}-hint`" class="om-choice-hint">{{
        hint
      }}</span>
      <span
        v-if="error"
        :id="`${descriptionId}-error`"
        class="om-choice-error"
        >{{ error }}</span
      >
    </span>
  </label>
</template>

<style scoped>
.om-choice {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
  min-height: var(--om-control-height);
  padding: 10px 0;
  cursor: pointer;
  font-size: 14px;
  line-height: 1.6;
}
.om-choice-control {
  margin-top: 2px;
}
.om-choice-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.om-choice-hint,
.om-choice-error {
  font-size: 13px;
  line-height: 1.7;
}
.om-choice-hint {
  color: var(--om-secondary);
}
.om-choice-error {
  color: var(--om-danger);
}
.disabled {
  cursor: not-allowed;
  color: var(--om-muted);
}
</style>
