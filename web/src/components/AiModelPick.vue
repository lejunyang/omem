<script setup lang="ts">
import { computed, ref } from "vue";
import UiSelect from "./UiSelect.vue";

/**
 * A model field: the models the provider lists (detected by the server), "默认" = empty, or typed by
 * hand when the one wanted is not listed (or the provider has no list).
 */
const props = defineProps<{ modelValue: string; choice?: { default: string; models: string[] }; label: string }>();
const emit = defineEmits<{ change: [value: string] }>();

const CUSTOM = "\u0000custom";
const listed = computed(() => props.choice?.models ?? []);
const typing = ref(false);
const byHand = computed(() => typing.value || !listed.value.length);
const def = computed(() => props.choice?.default || "");
const options = computed(() => [
  { value: "", label: def.value ? `默认（${def.value}）` : "默认" },
  ...listed.value.map((m) => ({ value: m, label: m })),
  ...(props.modelValue && !listed.value.includes(props.modelValue) ? [{ value: props.modelValue, label: props.modelValue, hint: "手填，列表里没有" }] : []),
  { value: CUSTOM, label: "手填其他…" },
]);
function pick(v: string) {
  if (v === CUSTOM) typing.value = true;
  else emit("change", v);
}
function typed(e: Event) {
  emit("change", (e.target as HTMLInputElement).value.trim());
}
</script>

<template>
  <div class="pick">
    <UiSelect v-if="!byHand" :model-value="modelValue" :options="options" :aria-label="label" @change="(v) => pick(v as string)" />
    <template v-else>
      <input :value="modelValue" class="input mono" :aria-label="label" :placeholder="def ? `留空用 ${def}` : '模型名'" @change="typed" />
      <button v-if="listed.length" type="button" class="btn ghost sm" @click="typing = false">从列表选</button>
    </template>
  </div>
</template>

<style scoped>
.pick {
  display: flex;
  gap: 6px;
  align-items: center;
}
.pick > :first-child {
  flex: 1;
  min-width: 0;
}
</style>
