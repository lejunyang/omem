<script setup lang="ts">
import { computed, watch } from "vue";
import { detectProbe, probes, seedProbe, type Probe } from "../lib/probes";
import UiSelect from "./UiSelect.vue";
import { relTime } from "../store";

/** `pluginBackend`: a backend a plugin declares (docs/v2/plugins.md 声明式 ACP 后端), with whether it can run now. */
export type PluginBackend = { plugin: string; name: string; available: boolean; reason?: string };
type Backend = { id: string; name: string; installed: boolean; transport?: string; model?: string; effort?: string; probe?: Probe | null; networkReason?: string | null; pluginBackend?: PluginBackend };
export type UnavailableBackend = { id: string; name?: string; pluginBackend: { plugin?: string; name: string; reason?: string } };
type Choice = { agent?: string; model?: string; effort?: string };
const props = defineProps<{ modelValue: Choice; backends: Backend[]; unavailableBackends?: UnavailableBackend[]; defaultBackend: string; cachedOnly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Choice]; change: [] }>();
const backend = computed(() => props.backends.find((b) => b.id === (props.modelValue.agent || props.defaultBackend)));
/**
 * The chosen backend the lists do not offer now: one the server names (`unavailableBackends`), or — where
 * the page has no such list — a saved plugin backend (`<插件>:<id>`) nobody lists any more.
 */
const unavailable = computed<UnavailableBackend | undefined>(() => {
  const id = props.modelValue.agent || props.defaultBackend;
  const named = props.unavailableBackends?.find(b => b.id === id);
  if (named || !props.modelValue.agent || props.backends.some((b) => b.id === id)) return named;
  const plugin = /^([a-z][a-z0-9]*):[a-z][a-z0-9-]*$/.exec(id)?.[1];
  return plugin ? { id, pluginBackend: { plugin, name: plugin, reason: "它的插件停用了、没信任或已经卸载" } } : undefined;
});
const probe = computed(() => props.cachedOnly ? backend.value?.probe : probes.data[backend.value?.id ?? ""]);
const loading = computed(() => !props.cachedOnly && !!probes.pending[backend.value?.id ?? ""]);
const backendOptions = computed(() => [
  { value: "", label: `跟随默认${props.defaultBackend ? `（${props.defaultBackend}）` : ""}` },
  ...[...props.backends].sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.transport === "acp") - Number(a.transport === "acp") || a.name.localeCompare(b.name)).map((b) => ({ value: b.id, label: b.name, hint: [b.pluginBackend ? `来自插件 ${b.pluginBackend.name}` : b.transport ?? "", b.pluginBackend?.available === false ? "不可用" : b.installed ? b.networkReason || "可用" : "未安装或未授权"].filter(Boolean).join(" · ") })),
  // Chosen but gone (its plugin was turned off or is no longer trusted): still the choice, said as such, never swapped silently.
  ...(unavailable.value && unavailable.value.id === props.modelValue.agent && !props.backends.some((b) => b.id === unavailable.value!.id) ? [{ value: unavailable.value.id, label: `${unavailable.value.name || unavailable.value.id}（不可用）`, hint: unavailable.value.pluginBackend.name ? `来自插件 ${unavailable.value.pluginBackend.name}` : undefined }] : []),
]);
/** The chosen backend comes from a plugin that cannot run it now: where to turn it back on. */
const gone = computed(() => unavailable.value ?? (backend.value?.pluginBackend?.available === false ? { id: backend.value.id, name: backend.value.name, pluginBackend: backend.value.pluginBackend } : null));
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
// Cached results come with the backend list; only a backend never detected is asked on its own.
function detect(refresh = false) {
  const b = backend.value;
  if (!b || props.cachedOnly) return;
  seedProbe(b.id, b.probe);
  void detectProbe(b.id, refresh);
}
watch(() => backend.value?.id, () => detect(), { immediate: true });
</script>

<template>
  <div class="ai-defaults">
    <div class="fields">
      <div class="field"><span>后端</span><UiSelect :model-value="modelValue.agent ?? ''" :options="backendOptions" :placeholder="unavailable?.name || unavailable?.id" aria-label="后端" @change="(v) => update('agent', v)" /></div>
      <div class="field"><span>模型</span>
        <UiSelect v-if="loading || probe?.models.length" :model-value="modelValue.model ?? ''" :disabled="loading" :options="choices('model', probe?.models ?? [])" aria-label="模型" @change="(v) => update('model', v)" />
        <input v-else class="input mono" :value="modelValue.model" :placeholder="backend?.model || '未检测到可选项，可手填'" aria-label="模型" @input="update('model', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="field"><span>思考强度</span>
        <UiSelect v-if="loading || efforts.length || noEffort" :model-value="modelValue.effort ?? ''" :disabled="loading || noEffort" :options="noEffort ? [{ value: '', label: '该模型不支持' }] : choices('effort', efforts)" aria-label="思考强度" @change="(v) => update('effort', v)" />
        <input v-else class="input mono" :value="modelValue.effort" :placeholder="inherited('effort') || '未检测到可选项，可手填'" aria-label="思考强度" @input="update('effort', ($event.target as HTMLInputElement).value)" />
      </div>
    </div>
    <p v-if="gone" class="small gone">{{ gone.name || gone.id }} 现在用不了：{{ gone.pluginBackend.reason || "它的插件停用了" }}<template v-if="gone.pluginBackend.name">（来自插件 {{ gone.pluginBackend.name }}）</template>。这里仍然保存着它，没有换成别的。<RouterLink v-if="gone.pluginBackend.name" :to="{ path: '/settings', query: { tab: 'plugins', ...(gone.pluginBackend.plugin ? { plugin: gone.pluginBackend.plugin } : {}) } }">去插件页</RouterLink></p>
    <div class="row wrap small muted"><span>{{ loading ? '正在检测模型与思考强度…' : probe?.error || `留空就跟随默认。${probe?.at ? `可选项检测于${relTime(probe.at)}。` : ''}` }}</span><button v-if="!cachedOnly" type="button" class="btn ghost sm" :disabled="loading || !backend" @click="detect(true)">重新检测</button></div>
  </div>
</template>

<style scoped>
.ai-defaults { min-width: 0; }
.fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.field :deep(.ui-select), .field input { width: 100%; min-width: 0; }
.gone { margin: 0 0 8px; color: var(--warn); }
@media (max-width: 760px) { .fields { grid-template-columns: 1fr; } }
</style>
