<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get } from "../api";
import AiDefaults from "./AiDefaults.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";
import type { FixDraft } from "../lib/quotes";

/**
 * The review the next round (and the rounds after it) gets, chosen with the fix: a tier — lighter
 * than before is fine (“这轮从简”) — whether to split the requirement again, whether each round's
 * checks take another model, and the functional reviewer's AI. One line saying what is set; the
 * choices open on demand. Left alone, the rounds keep what they had. Same as telling the assistant.
 */
const props = defineProps<{ draft: FixDraft }>();
type Tier = { id: string; name: string; checks: string[] };
type Backend = { id: string; name?: string; installed: boolean; transport: string; model?: string; effort?: string };

const open = ref(false);
const tiers = ref<Tier[]>([]);
const backends = ref<Backend[]>([]);
// Loaded the first time the choices open: most fixes keep the review as it was.
watch(open, async (o) => {
  if (!o || tiers.value.length) return;
  try {
    const [r, s] = await Promise.all([get<{ tiers: Tier[] }>("/api/review-settings"), get<{ agents: Backend[] }>("/api/settings")]);
    tiers.value = r.tiers;
    backends.value = s.agents;
  } catch {
    /* the fix still starts with the rounds' own review */
  }
});
const ROTATE = [{ value: "" as const, label: "按档位设置" }, { value: "on" as const, label: "每轮换模型" }, { value: "off" as const, label: "不换模型" }];
const tierOptions = computed(() => [{ value: "", label: "沿用之前的" }, ...tiers.value.map((t) => ({ value: t.id, label: `「${t.name}」档`, hint: `${t.checks.length} 项评审` }))]);
const summary = computed(() => {
  const d = props.draft;
  const parts = [
    d.tier ? `「${tiers.value.find((t) => t.id === d.tier)?.name ?? d.tier}」档` : "",
    d.split ? "" : "不拆需求",
    d.rotate === "on" ? "每轮换模型" : d.rotate === "off" ? "不换模型" : "",
    d.ai.agent ? `功能评审用 ${[d.ai.agent, d.ai.model].filter(Boolean).join(" · ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("，") : "沿用之前的";
});
</script>

<template>
  <div class="next-review small">
    <button class="lnk" :aria-expanded="open" @click="open = !open">之后的评审：{{ summary }} {{ open ? "▴" : "▾" }}</button>
    <div v-if="open" class="choices">
      <span class="muted">档位</span>
      <UiSelect v-model="draft.tier" :options="tierOptions" size="sm" width="170px" aria-label="之后各轮的评审档位" />
      <span class="muted">换模型</span>
      <div class="row wrap">
        <UiSelect :model-value="draft.rotate ?? ''" :options="ROTATE" size="sm" width="150px" aria-label="之后各轮评审换不换模型" @update:model-value="(v) => (draft.rotate = v)" />
        <UiCheckbox v-model="draft.split" size="sm">拆需求</UiCheckbox>
      </div>
      <span class="muted">功能评审 AI</span>
      <AiDefaults :model-value="draft.ai" :backends="backends.map((b) => ({ ...b, name: b.name || b.id }))" default-backend="" @update:model-value="(v) => (draft.ai = v)" />
    </div>
  </div>
</template>

<style scoped>
.next-review { display: grid; gap: 8px; min-width: 0; }
.next-review > .lnk { justify-self: start; text-align: left; }
.choices { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; align-items: center; padding: 10px 12px; border-radius: 8px; background: var(--sunken); }
.choices .row { gap: 12px; }
@media (max-width: 560px) {
  .choices { grid-template-columns: minmax(0, 1fr); }
}
</style>
