<script setup lang="ts">
import { computed, ref } from "vue";
import UiSelect from "./UiSelect.vue";

/**
 * A list of names shown as chips, each removable, with a "＋" select that adds one from the
 * options not chosen yet. Clicking a chip emits `open` (e.g. go to the skill's page).
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[];
    options: { value: string; label?: string; hint?: string }[];
    addLabel?: string;
    disabled?: boolean;
    /** Names that no longer exist: shown struck through, still removable. */
    missing?: string[];
    /** Chips are buttons that emit `open`. */
    openable?: boolean;
  }>(),
  { addLabel: "＋ 添加", missing: () => [] },
);
const emit = defineEmits<{ "update:modelValue": [value: string[]]; open: [name: string] }>();

const pick = ref<string | null>(null);
const addable = computed(() => props.options.filter((o) => !props.modelValue.includes(o.value)).map((o) => ({ value: o.value as string | null, label: o.label ?? o.value, hint: o.hint })));
const hintOf = (name: string) => props.options.find((o) => o.value === name)?.hint ?? "";
function add(v: string | null) {
  pick.value = null;
  if (v && !props.modelValue.includes(v)) emit("update:modelValue", [...props.modelValue, v]);
}
function remove(name: string) {
  emit("update:modelValue", props.modelValue.filter((x) => x !== name));
}
</script>

<template>
  <div class="chip-picker">
    <span v-for="name in modelValue" :key="name" class="chip" :class="{ missing: missing.includes(name) }" :title="missing.includes(name) ? '已不存在' : hintOf(name)">
      <button v-if="openable" type="button" class="chip-name" @click="emit('open', name)">{{ name }}</button>
      <span v-else class="chip-name">{{ name }}</span>
      <button v-if="!disabled" type="button" class="chip-x" :aria-label="`移除 ${name}`" @click="remove(name)">×</button>
    </span>
    <UiSelect v-if="!disabled && addable.length" v-model="pick" size="sm" width="132px" :placeholder="addLabel" :options="addable" :search-at="8" :aria-label="addLabel" @change="add" />
    <span v-if="!modelValue.length && (disabled || !addable.length)" class="muted small">无</span>
  </div>
</template>

<style scoped>
.chip-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  background: var(--hover);
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.6;
}
.chip-name {
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  padding: 1px 4px 1px 10px;
  cursor: default;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button.chip-name {
  cursor: pointer;
}
button.chip-name:hover {
  color: var(--accent);
}
.chip-x {
  border: 0;
  background: none;
  color: var(--ink-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 8px 2px 2px;
}
.chip-x:hover {
  color: var(--danger);
}
.chip.missing .chip-name {
  color: var(--danger);
  text-decoration: line-through;
}
</style>
