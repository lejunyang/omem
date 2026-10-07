<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  modelValue?: unknown;
  value?: unknown;
  disabled?: boolean;
  invalid?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  change: [event: Event];
}>();
const selection = computed({
  get: () => (props.modelValue === undefined ? props.value : props.modelValue),
  set: (value) => emit("update:modelValue", value),
});
</script>

<template>
  <select
    v-model="selection"
    class="om-select"
    :disabled="disabled"
    :aria-invalid="invalid || undefined"
    @change="emit('change', $event)"
  >
    <slot />
  </select>
</template>

<style scoped>
.om-select {
  width: 100%;
}
</style>
