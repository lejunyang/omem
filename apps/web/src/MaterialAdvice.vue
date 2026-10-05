<script setup lang="ts">
import { ref, watch } from "vue";
import { OmBadge } from "@omem/ui";
import { api } from "./api";
const props = defineProps<{ revisionId: string }>();
const labels: Record<string, string> = { schedule: "日常跟进", learning: "学习与复习", code: "代码与系统", business: "业务与项目" };
const suggestions = ref<string[]>([]), loading = ref(false);
let generation = 0;
watch(() => props.revisionId, async revisionId => {
  const current = ++generation; suggestions.value = []; loading.value = true;
  try {
    const reply = await api<{ result: { answers: Record<string, { choice: string; probabilities: Record<string, number> }> } | null }>("/decisions/intake", { revisionId });
    if (current === generation && reply.result) suggestions.value = Object.entries(reply.result.answers).filter(([,a]) => a.choice === "yes" && (a.probabilities.yes ?? 0) >= .7).map(([key]) => labels[key] ?? key);
  } catch { /* Advisory classification never obstructs the saved original. */ }
  finally { if (current === generation) loading.value = false; }
}, { immediate: true });
</script>
<template><div v-if="loading || suggestions.length" class="material-advice" role="status"><span v-if="loading">正在识别材料用途…</span><template v-else><span>可用于</span><OmBadge v-for="label in suggestions" :key="label">{{ label }}</OmBadge><small>用途建议，可同时属于多类。</small></template></div></template>
<style scoped>.material-advice{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0;color:var(--om-secondary);font-size:14px}small{width:100%}</style>
