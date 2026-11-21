<script setup lang="ts">
import { computed } from "vue";
import UiSelect from "./UiSelect.vue";
import { scopeChoices, type Scope, type SelectOption } from "../lib/operation-rules";

/**
 * Whom an operation rule (or a rule pack) applies to: members, roles or profiles, spaces, backends.
 * Nothing picked in a list means everyone there; the four together all have to hold.
 */
const props = defineProps<{ modelValue: Scope | undefined; backends: SelectOption<string>[]; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [Scope] }>();
const ROWS = [
  { key: "members", label: "成员", none: "所有成员" },
  { key: "roles", label: "角色或档案", none: "所有角色和档案" },
  { key: "spaces", label: "空间", none: "所有空间" },
  { key: "backends", label: "后端", none: "所有后端" },
] as const;
const options = computed(() => ({ members: scopeChoices.members, roles: scopeChoices.roles, spaces: scopeChoices.spaces, backends: props.backends }));
/** Values already in the rule that the lists no longer offer (a removed member) stay visible. */
function optionsFor(key: keyof Scope): SelectOption<string>[] {
  const list = options.value[key];
  const extra = (props.modelValue?.[key] ?? []).filter((v) => !list.some((o) => o.value === v)).map((v) => ({ value: v, label: v, hint: "已不在列表里" }));
  return [...list, ...extra];
}
function set(key: keyof Scope, v: string[]) {
  emit("update:modelValue", { ...(props.modelValue ?? {}), [key]: v });
}
</script>

<template>
  <div class="op-scope">
    <div v-for="r in ROWS" :key="r.key" class="field">
      <span>{{ r.label }}</span>
      <UiSelect :model-value="modelValue?.[r.key] ?? []" multiple size="sm" :disabled="disabled" :placeholder="r.none" :aria-label="`范围：${r.label}`" :options="optionsFor(r.key)" @change="(v) => set(r.key, v as string[])" />
    </div>
  </div>
</template>

<style scoped>
.op-scope {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  min-width: 0;
}
@media (max-width: 640px) {
  .op-scope {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
