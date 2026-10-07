<script setup lang="ts">
import OmChoice from "./OmChoice.vue";
import type { OmChoiceProps } from "../forms";

const props = defineProps<OmChoiceProps>();
const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  change: [event: Event];
}>();
</script>

<template>
  <OmChoice
    v-bind="props"
    type="radio"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  >
    <template v-if="$slots.default" #default><slot /></template>
  </OmChoice>
</template>
