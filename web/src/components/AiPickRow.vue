<script setup lang="ts">
import { computed, watch } from "vue";
import { detectProbe, modelName, probes, seedProbe, type Probe } from "../lib/probes";
import type { AiPick, PolicyBackend } from "../lib/ai-policy";
import UiSelect from "./UiSelect.vue";

/**
 * One AI as three small dropdowns, backend · model · effort, in a row (an AI group's entry, a rule's
 * single AI). The models are what the backend reported last and what the server knows without asking
 * it (a key's models, `policy`); a backend not detected yet is asked once, as the other pickers do.
 * `empty` names what an empty model or effort means here (the backend's own, or every one).
 */
type Backend = { id: string; name?: string; installed: boolean; transport?: string; model?: string; effort?: string; canProbe?: boolean; probe?: Probe | null; networkReason?: string | null };
const props = defineProps<{ modelValue: AiPick; backends: Backend[]; policy?: PolicyBackend[]; empty?: { model: string; effort: string }; label?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: AiPick] }>();
const plain = (name: string) => name.replace(/\s*[(（](ACP|CLI|命令行)[)）]\s*$/i, "");
const backend = computed(() => props.backends.find((b) => b.id === props.modelValue.profile));
const probe = computed(() => probes.data[props.modelValue.profile] ?? backend.value?.probe ?? undefined);
const known = computed(() => props.policy?.find((b) => b.id === props.modelValue.profile));
const backendOptions = computed(() => [
  ...[...props.backends].sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.transport === "acp") - Number(a.transport === "acp")).map((b) => ({ value: b.id, label: plain(b.name ?? b.id), hint: b.installed ? b.networkReason ?? undefined : "未安装" })),
  ...(props.modelValue.profile && !props.backends.some((b) => b.id === props.modelValue.profile) ? [{ value: props.modelValue.profile, label: `${props.modelValue.profile}（不在了）` }] : []),
]);
const emptyLabel = computed(() => props.empty ?? { model: "后端默认", effort: "默认强度" });
const modelOptions = computed(() => {
  const listed = [...new Set([...(probe.value?.models ?? []), ...(known.value?.models ?? [])])];
  const cur = props.modelValue.model;
  const all = cur && !listed.includes(cur) ? [cur, ...listed] : listed;
  const name = (m: string) => modelName(probe.value, m) === m ? known.value?.modelNames?.[m] ?? m : modelName(probe.value, m);
  return [{ value: "", label: emptyLabel.value.model }, ...all.map((m) => ({ value: m, label: name(m), hint: m === backend.value?.model ? "后端默认" : undefined }))];
});
const effortOptions = computed(() => {
  const model = props.modelValue.model || backend.value?.model || "";
  const p = probe.value;
  const listed = (p?.effortsByModel && model in p.effortsByModel ? p.effortsByModel[model] : p?.efforts) ?? [];
  const cur = props.modelValue.effort;
  return [{ value: "", label: emptyLabel.value.effort }, ...(cur && !listed.includes(cur) ? [cur] : []).map((v) => ({ value: v, label: v })), ...listed.map((v) => ({ value: v, label: v }))];
});
function set(key: keyof AiPick, v: string) {
  const next: AiPick = { ...props.modelValue, [key]: v || undefined };
  if (key === "profile") { delete next.model; delete next.effort; }
  if (key === "model") delete next.effort;
  emit("update:modelValue", Object.fromEntries(Object.entries(next).filter(([, x]) => x)) as AiPick);
}
const probeable = (b: Backend) => b.transport === "acp" || b.transport === "doubao-cli";
watch(() => backend.value?.id, () => {
  const b = backend.value;
  if (!b) return;
  seedProbe(b.id, b.probe);
  if (b.installed && probeable(b) && b.canProbe !== false) void detectProbe(b.id);
}, { immediate: true });
</script>

<template>
  <div class="ai-pick" role="group" :aria-label="label ?? 'AI'">
    <UiSelect :model-value="modelValue.profile" size="sm" :options="backendOptions" placeholder="选后端" aria-label="后端" @change="(v) => set('profile', v)" />
    <UiSelect :model-value="modelValue.model ?? ''" size="sm" :disabled="!modelValue.profile" :options="modelOptions" aria-label="模型" @change="(v) => set('model', v)" />
    <UiSelect :model-value="modelValue.effort ?? ''" size="sm" :disabled="!modelValue.profile" :options="effortOptions" aria-label="思考强度" @change="(v) => set('effort', v)" />
  </div>
</template>

<style scoped>
.ai-pick {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.3fr) minmax(0, 0.8fr);
  gap: 8px;
  min-width: 0;
}
.ai-pick :deep(.ui-select) {
  width: 100%;
  min-width: 0;
}
@media (max-width: 640px) {
  .ai-pick {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .ai-pick > :first-child {
    grid-column: 1 / -1;
  }
}
</style>
