<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { post } from "../api";
import UiSelect from "./UiSelect.vue";

type Backend = { id: string; name: string; installed: boolean; transport?: string; model?: string; effort?: string };
type Choice = { agent?: string; model?: string; effort?: string };
type Probe = { models: string[]; efforts: string[]; effortsByModel?: Record<string, string[]>; error?: string };
const props = defineProps<{ modelValue: Choice; backends: Backend[]; defaultBackend: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: Choice]; change: [] }>();
const probes = ref<Record<string, Probe>>({});
const pending = ref(new Set<string>());
const backend = computed(() => props.backends.find((b) => b.id === (props.modelValue.agent || props.defaultBackend)));
const probe = computed(() => probes.value[backend.value?.id ?? ""]);
const loading = computed(() => pending.value.has(backend.value?.id ?? ""));
const backendOptions = computed(() => [{ value: "", label: `跟随默认${props.defaultBackend ? `（${props.defaultBackend}）` : ""}` }, ...[...props.backends].sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.transport === "acp") - Number(a.transport === "acp") || a.name.localeCompare(b.name)).map((b) => ({ value: b.id, label: b.name, hint: `${b.transport ?? ""}${b.installed ? " · 可用" : " · 未安装或未授权"}` }))]);
const model = computed(() => props.modelValue.model || backend.value?.model || "");
const efforts = computed(() => probe.value?.effortsByModel?.[model.value] ?? probe.value?.efforts ?? []);
const noEffort = computed(() => !!probe.value?.effortsByModel && Object.hasOwn(probe.value.effortsByModel, model.value) && efforts.value.length === 0);
function inherited(key: "model" | "effort") {
  if (key === "effort" && props.modelValue.model && props.modelValue.model !== backend.value?.model) return undefined;
  return backend.value?.[key];
}
function choices(key: "model" | "effort", offered: string[]) {
  const saved = props.modelValue[key];
  return [{ value: "", label: `跟随默认${inherited(key) ? `（${inherited(key)}）` : ""}` }, ...(saved && !offered.includes(saved) ? [{ value: saved, label: saved, hint: "当前保存值，检测未列出" }] : []), ...offered.map((v) => ({ value: v, label: v }))];
}
function update(key: keyof Choice, value: string) {
  const next = { ...props.modelValue, [key]: value };
  if (key === "agent") { next.model = ""; next.effort = ""; }
  if (key === "model") next.effort = "";
  emit('update:modelValue', next); emit('change');
}
async function detect(refresh = false) {
  const b = backend.value;
  if (!b || pending.value.has(b.id) || (!refresh && probes.value[b.id])) return;
  pending.value.add(b.id);
  try { probes.value[b.id] = await post<Probe>(`/api/agents/${encodeURIComponent(b.id)}/probe`, { refresh }); }
  catch (e) { probes.value[b.id] = { models: [], efforts: [], error: (e as Error).message }; }
  finally { pending.value.delete(b.id); }
}
watch(() => backend.value?.id, () => void detect(), { immediate: true });
</script>

<template>
  <div class="ai-defaults">
    <div class="fields">
      <div class="field"><span>后端</span><UiSelect :model-value="modelValue.agent ?? ''" :options="backendOptions" aria-label="后端" @change="(v) => update('agent', v)" /></div>
      <div class="field"><span>模型</span>
        <UiSelect v-if="loading || probe?.models.length" :model-value="modelValue.model ?? ''" :disabled="loading" :options="choices('model', probe?.models ?? [])" aria-label="模型" @change="(v) => update('model', v)" />
        <input v-else class="input mono" :value="modelValue.model" :placeholder="backend?.model || '未检测到可选项，可手填'" aria-label="模型" @input="update('model', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="field"><span>思考强度</span>
        <UiSelect v-if="loading || efforts.length || noEffort" :model-value="modelValue.effort ?? ''" :disabled="loading || noEffort" :options="noEffort ? [{ value: '', label: '该模型不支持' }] : choices('effort', efforts)" aria-label="思考强度" @change="(v) => update('effort', v)" />
        <input v-else class="input mono" :value="modelValue.effort" :placeholder="inherited('effort') || '未检测到可选项，可手填'" aria-label="思考强度" @input="update('effort', ($event.target as HTMLInputElement).value)" />
      </div>
    </div>
    <div class="row wrap small muted"><span>{{ loading ? '正在检测模型与思考强度…' : probe?.error || '留空就跟随默认。' }}</span><button type="button" class="btn ghost sm" :disabled="loading || !backend" @click="detect(true)">重新检测</button></div>
  </div>
</template>

<style scoped>
.ai-defaults { min-width: 0; }
.fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.field :deep(.ui-select), .field input { width: 100%; min-width: 0; }
@media (max-width: 760px) { .fields { grid-template-columns: 1fr; } }
</style>
