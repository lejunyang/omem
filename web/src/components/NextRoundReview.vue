<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import AiDefaults from "./AiDefaults.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";
import type { FixDraft } from "../lib/quotes";

/**
 * The review the next round (and the rounds after it) gets, chosen with the fix: a tier — lighter
 * than before is fine (“这轮从简”) — whether to split the requirement again, and the functional
 * reviewer's AI, and whether each round's checks take another model (the rotation in the review
 * settings). Left alone, the rounds keep what they had. Same as telling the assistant.
 */
const props = defineProps<{ draft: FixDraft }>();
type Tier = { id: string; name: string; checks: string[] };
type Backend = { id: string; name?: string; installed: boolean; transport: string; model?: string; effort?: string };

// Loaded once per page: the tiers and the backends hardly change while one reads a review.
const tiers = ref<Tier[]>([]);
const backends = ref<Backend[]>([]);
const aiOpen = ref(!!props.draft.ai.agent);
onMounted(async () => {
  try {
    const [r, s] = await Promise.all([get<{ tiers: Tier[] }>("/api/review-settings"), get<{ agents: Backend[] }>("/api/settings")]);
    tiers.value = r.tiers;
    backends.value = s.agents;
  } catch {
    /* the fix still starts with the rounds' own review */
  }
});
const ROTATE = [{ value: "" as const, label: "模型按档位设置" }, { value: "on" as const, label: "每轮换模型" }, { value: "off" as const, label: "不换模型" }];
const tierOptions = computed(() => [{ value: "", label: "沿用之前的评审" }, ...tiers.value.map((t) => ({ value: t.id, label: `「${t.name}」档`, hint: `${t.checks.length} 项评审` }))]);
</script>

<template>
  <div class="next-review row wrap small">
    <span class="muted">之后的评审</span>
    <UiSelect v-model="draft.tier" :options="tierOptions" size="sm" width="170px" aria-label="之后各轮的评审档位" />
    <UiCheckbox v-model="draft.split" size="sm">拆需求</UiCheckbox>
    <UiSelect :model-value="draft.rotate ?? ''" :options="ROTATE" size="sm" width="150px" aria-label="之后各轮评审换不换模型" @update:model-value="(v) => (draft.rotate = v)" />
    <button v-if="!aiOpen" class="lnk" @click="aiOpen = true">换评审 AI</button>
  </div>
  <div v-if="aiOpen" class="ai">
    <span class="muted small">功能评审用的 AI（不选就按档案）</span>
    <AiDefaults :model-value="draft.ai" :backends="backends.map((b) => ({ ...b, name: b.name || b.id }))" default-backend="" @update:model-value="(v) => (draft.ai = v)" />
  </div>
</template>

<style scoped>
.next-review { gap: 8px; align-items: center; }
.ai { display: grid; gap: 6px; min-width: 0; }
</style>
