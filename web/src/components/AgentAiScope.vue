<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { aiOld, aiPolicy, aiText, effectiveGroups, loadAiOld, loadAiPolicy, parseAi, refText, scopeReason, selectorText, type ScopeRule } from "../lib/ai-policy";
import type { Probe } from "../lib/probes";
import AiDefaults, { type PluginBackend, type UnavailableBackend } from "./AiDefaults.vue";
import AiDenyPicker from "./AiDenyPicker.vue";
import AiUseList from "./AiUseList.vue";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * “能用的 AI” of an Agent profile (frontmatter `class`, `ai: { use, deny, strict }`, and the old
 * `agent` / `model` / `effort` as the AI it starts with): which category its runs count as, what they
 * may use in order, what never, and whether to stay within that. A profile that only names one AI has
 * no range of its own and follows its category's rule. What the category's rule (or the global one)
 * leaves out of what the profile names is said beside it: those runs skip it.
 */
type Backend = { id: string; name: string; installed: boolean; transport?: string; model?: string; effort?: string; probe?: Probe | null; pluginBackend?: PluginBackend };
export type SpecAi = { class?: string; ai?: { use?: string[]; deny?: string[]; strict?: boolean }; agent?: string; model?: string; effort?: string };
const props = defineProps<{ value: SpecAi; backends: Backend[]; unavailableBackends?: UnavailableBackend[]; defaultBackend: string }>();
const emit = defineEmits<{ change: [patch: Partial<SpecAi>] }>();
// Until the groups are saved once, the built-in ones stand for the old tiers.
onMounted(() => {
  void loadAiPolicy();
  void loadAiOld();
});

const view = computed(() => aiPolicy.data);
const policyBackends = computed(() => view.value?.backends ?? []);
const groups = computed(() => effectiveGroups(view.value?.groups, aiOld.data?.tiers, aiOld.data?.candidates));
const classId = computed(() => props.value.class || "agents");
const classOptions = computed(() => Object.entries(view.value?.classes ?? {}).map(([id, c]) => ({ value: id, label: id === "agents" ? `${c.name}（默认）` : c.name, hint: c.description })));
const className = computed(() => view.value?.classes[classId.value]?.name ?? "调查与交办");
const rule = computed(() => view.value?.policy.classes[classId.value]);
const use = computed(() => props.value.ai?.use ?? []);
const deny = computed(() => props.value.ai?.deny ?? []);
const strict = computed(() => !!props.value.ai?.strict);
function setAi(patch: { use?: string[]; deny?: string[]; strict?: boolean }) {
  const next = { use: use.value, deny: deny.value, strict: strict.value, ...patch };
  if (!next.use.length) next.strict = false;
  emit("change", { ai: { ...(next.use.length ? { use: next.use } : {}), ...(next.deny.length ? { deny: next.deny } : {}), ...(next.strict ? { strict: true } : {}) } });
}
/** What the category allows when the profile sets no range of its own. */
const categoryLine = computed(() => {
  const r = rule.value;
  const scope = r?.use.length ? r.use.map((x) => refText(x, groups.value, policyBackends.value)).join(" → ") : "全部 AI";
  const out = [...(view.value?.policy.deny ?? []), ...(r?.deny ?? [])].map((s) => selectorText(s, policyBackends.value));
  return `${className.value}：${scope}${out.length ? `，不用 ${out.join("、")}` : ""}`;
});
const outside = (own: boolean): ScopeRule => ({
  name: own ? "这个档案" : className.value,
  use: own ? use.value : use.value.length ? [] : rule.value?.use ?? [],
  deny: [
    ...(view.value?.policy.deny ?? []).map((selector) => ({ selector, rule: "所有类别都" })),
    ...(rule.value?.deny ?? []).map((selector) => ({ selector, rule: className.value })),
    ...(own ? deny.value.map((selector) => ({ selector, rule: "这个档案" })) : []),
  ],
});
/** The AI it starts with, against everything that applies to its runs. */
const startConflict = computed(() => {
  const profile = props.value.agent || props.defaultBackend;
  if (!profile || !view.value) return "";
  const pick = { profile, ...(props.value.model ? { model: props.value.model } : {}), ...(props.value.effort ? { effort: props.value.effort } : {}) };
  const why = scopeReason(pick, { ...outside(true), use: use.value.length ? use.value : rule.value?.use ?? [], name: use.value.length ? "这个档案" : className.value }, groups.value, policyBackends.value, props.backends);
  return why ? `先用的 ${aiText(pick, policyBackends.value)}：${why}，运行时会跳过它，换用范围里的。` : "";
});
/** A single AI the profile lists that the category or the global rule leaves out. */
const marks = computed(() => Object.fromEntries(use.value.filter((r) => r.startsWith("ai:")).flatMap((r) => {
  const why = view.value && scopeReason(parseAi(r.slice(3)), { ...outside(false), use: [] }, groups.value, policyBackends.value, props.backends);
  return why ? [[r, `${why}，这一项不会用到`]] : [];
})));
const denying = ref(false);
const legacyOnly = computed(() => !use.value.length && !!(props.value.agent || props.value.model || props.value.effort));
</script>

<template>
  <div class="spec-ai">
    <div class="field">
      <span>类别</span>
      <UiSelect :model-value="classId" :options="classOptions.length ? classOptions : [{ value: 'agents', label: '调查与交办（默认）' }]" aria-label="类别" @change="(v) => emit('change', { class: v })" />
      <span class="hint">按这一类的规则限定能用的 AI：{{ categoryLine }}。<RouterLink :to="{ path: '/settings', query: { tab: 'agents', section: 'rules', card: 'ai-rules' } }">改类别规则</RouterLink></span>
    </div>
    <div class="field">
      <span>先用</span>
      <AiDefaults :model-value="value" :backends="backends" :unavailable-backends="unavailableBackends" :default-backend="defaultBackend" @update:model-value="(v) => emit('change', { agent: v.agent, model: v.model, effort: v.effort })" />
      <span v-if="legacyOnly" class="hint">只写了这一个，没有限定范围：用不了时按“{{ className }}”的规则换。</span>
      <p v-if="startConflict" class="small warn-text">{{ startConflict }}</p>
    </div>
    <div class="field">
      <span>能用的（按先后）</span>
      <AiUseList :model-value="use" :groups="groups" :policy="policyBackends" :backends="backends" :marks="marks" :empty-text="`没有限定：按“${className}”的规则`" @update:model-value="(v) => setAi({ use: v })" />
    </div>
    <div class="field">
      <span>不用的</span>
      <div class="deny-list">
        <span v-for="s in deny" :key="s" class="deny-chip" :title="`不用 ${selectorText(s, policyBackends)}`">{{ selectorText(s, policyBackends) }}<button type="button" class="deny-x" :aria-label="`不再排除 ${selectorText(s, policyBackends)}`" @click="setAi({ deny: deny.filter((x) => x !== s) })">×</button></span>
        <span v-if="!deny.length && !denying" class="small muted">没有</span>
        <button v-if="!denying" type="button" class="btn ghost sm" :disabled="!view" @click="denying = true"><Icon name="plus" :size="13" />排除</button>
      </div>
      <AiDenyPicker v-if="denying" :policy="policyBackends" :backends="backends" :taken="deny" @add="(s) => setAi({ deny: [...deny, s] })" @close="denying = false" />
    </div>
    <div class="field">
      <UiCheckbox :model-value="strict" switch :disabled="!use.length" @update:model-value="(v) => setAi({ strict: v === true })">只用这些</UiCheckbox>
      <span class="hint">{{ use.length ? "用不了时只在上面这些里换，都不行就排队等" : "先选能用的组或 AI" }}</span>
    </div>
  </div>
</template>

<style scoped>
.spec-ai {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.spec-ai .field > span:first-child {
  font-size: 13px;
  color: var(--ink-2);
}
.spec-ai > .field {
  min-width: 0;
}
.deny-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}
.deny-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  height: 24px;
  padding: 0 2px 0 9px;
  border-radius: 999px;
  background: var(--sunken);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deny-x {
  flex: none;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}
.deny-x:hover {
  color: var(--ink);
}
</style>
