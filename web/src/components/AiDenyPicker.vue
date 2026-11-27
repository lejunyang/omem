<script setup lang="ts">
import { computed, ref } from "vue";
import { aiRef, FAMILY_LABEL, FAMILY_WORD, familyName, familyOf, programName, type AiPick, type PolicyBackend, type SelectorType } from "../lib/ai-policy";
import type { Probe } from "../lib/probes";
import AiPickRow from "./AiPickRow.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Adding one thing a rule leaves out: what kind (a backend with all its forms, a family of models, one
 * AI, everything an API key made), then which one, chosen from the backends and models there are.
 * Emits the selector the rule stores (`backend:claude`, `model:gemini`, …); nobody types it.
 */
type Backend = { id: string; name?: string; installed: boolean; transport?: string; model?: string; effort?: string; canProbe?: boolean; probe?: Probe | null };
const props = defineProps<{ policy: PolicyBackend[]; backends: Backend[]; taken?: string[] }>();
const emit = defineEmits<{ add: [selector: string]; close: [] }>();
const type = ref<SelectorType>("backend");
const value = ref("");
const ai = ref<AiPick>({ profile: "" });
const types = computed(() => [
  { value: "backend" as const, label: "后端" },
  { value: "model" as const, label: "模型族" },
  { value: "ai" as const, label: "具体 AI" },
  ...(props.policy.some((b) => b.key) ? [{ value: "key" as const, label: "API key" }] : []),
]);
const taken = (sel: string) => props.taken?.includes(sel);
const values = computed(() => {
  if (type.value === "backend") {
    const programs = [...new Set([...props.policy].sort((a, b) => Number(b.installed) - Number(a.installed)).map((b) => b.program))];
    return programs.map((p) => ({ value: `backend:${p}`, label: programName(p, props.policy), hint: taken(`backend:${p}`) ? "已排除" : props.policy.some((b) => b.program === p && b.installed) ? "全部模型和入口" : "未安装", disabled: taken(`backend:${p}`) }));
  }
  if (type.value === "model") {
    const seen = new Map<string, string[]>();
    for (const b of props.policy) for (const m of b.models) {
      const f = familyOf(m);
      if (FAMILY_LABEL[f]) seen.set(f, [...(seen.get(f) ?? []), b.modelNames?.[m] ?? m]);
    }
    const families = [...seen.keys(), ...Object.keys(FAMILY_LABEL).filter((f) => !seen.has(f))];
    return families.map((f) => {
      const sel = `model:${FAMILY_WORD[f]}`;
      const examples = [...new Set(seen.get(f) ?? [])].slice(0, 2).join("、");
      return { value: sel, label: familyName(f), hint: taken(sel) ? "已排除" : examples ? `如 ${examples}` : "现在没有这一家的模型", disabled: taken(sel) };
    });
  }
  if (type.value === "key") {
    const keys = new Map(props.policy.flatMap((b) => (b.key ? [[b.key.id, b.key.name] as const] : [])));
    return [...keys].map(([id, name]) => ({ value: `key:${id}`, label: name, hint: taken(`key:${id}`) ? "已排除" : "它生成的全部后端", disabled: taken(`key:${id}`) }));
  }
  return [];
});
const selector = computed(() => (type.value === "ai" ? (ai.value.profile ? aiRef(ai.value) : "") : value.value));
function add() {
  if (!selector.value || taken(selector.value)) return;
  emit("add", selector.value);
  value.value = "";
  ai.value = { profile: "" };
}
function setType(t: SelectorType) {
  type.value = t;
  value.value = "";
}
</script>

<template>
  <div class="deny-pick" role="group" aria-label="加一项不用的">
    <UiSelect :model-value="type" size="sm" width="104px" :options="types" aria-label="排除哪一类" @change="setType" />
    <AiPickRow v-if="type === 'ai'" v-model="ai" class="grow" :backends="backends" :policy="policy" :empty="{ model: '全部模型', effort: '全部强度' }" label="不用的 AI" />
    <div v-else class="grow"><UiSelect :model-value="value" size="sm" :options="values" placeholder="选一个" aria-label="排除哪一个" @change="(v) => (value = v)" /></div>
    <span class="deny-acts">
      <button class="btn sm" :disabled="!selector || taken(selector)" @click="add">加上</button>
      <button class="btn ghost sm" @click="emit('close')">取消</button>
    </span>
  </div>
</template>

<style scoped>
.deny-pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.grow {
  flex: 1 1 240px;
  min-width: 0;
}
.deny-acts {
  display: flex;
  gap: 8px;
}
</style>
