<script setup lang="ts">
import HelpText from "./HelpText.vue";
import { ref, watch } from "vue";

/**
 * How much runs at once overall: omem's own slots (background tasks, conversations), the default limit
 * of each model, and the default quota thresholds. Each backend's own limits and its account's quota
 * are in its block (AiBackend.vue).
 */
type Value = { concurrency: number; interactiveConcurrency: number; perModel: number; quotaAvoidAbove: number; quotaPerDayBelow: number };
const props = defineProps<{ value: Value }>();
const emit = defineEmits<{ save: [value: Value] }>();
const draft = ref<Value>({ concurrency: 2, interactiveConcurrency: 4, perModel: 3, quotaAvoidAbove: 90, quotaPerDayBelow: 0 });
// The parent passes a fresh object on every render: reset the draft only when the saved values change.
watch(() => JSON.stringify(props.value), (v) => { draft.value = JSON.parse(v); }, { immediate: true });
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
function save() {
  const d = draft.value;
  emit("save", {
    concurrency: clamp(d.concurrency, 1, 32),
    interactiveConcurrency: clamp(d.interactiveConcurrency, 1, 16),
    perModel: clamp(d.perModel, 1, 32),
    quotaAvoidAbove: clamp(d.quotaAvoidAbove, 50, 100),
    quotaPerDayBelow: Math.max(0, Math.min(100, Number(d.quotaPerDayBelow) || 0)),
  });
}
</script>

<template>
  <div class="card pad stack">
    <div class="section-title">并行</div>
    <HelpText>后台任务（整理、Wiki、评审、存量整理的每一批）和对话各有总数；每个模型另有上限，满了的任务换到这个角色配置过的其他模型和兜底，都满了就排队。对话不排队，但算在模型的占用里。各后端自己的上限在上面各后端的“用量”里。</HelpText>
    <div class="grid">
      <label class="field"><span>后台任务同时最多（1–32）</span><input v-model.number="draft.concurrency" class="input" type="number" inputmode="numeric" min="1" max="32" /></label>
      <label class="field"><span>对话同时最多（1–16）</span><input v-model.number="draft.interactiveConcurrency" class="input" type="number" inputmode="numeric" min="1" max="16" /></label>
      <label class="field"><span>每个模型默认最多（1–32）</span><input v-model.number="draft.perModel" class="input" type="number" inputmode="numeric" min="1" max="32" /></label>
    </div>
    <div class="section-title">额度快用完时（默认）</div>
    <HelpText>按读到的 Codex、Claude Code 套餐额度，满足任一条件的账号排到最后：后台任务先用别的后端，助手交办时也会看到“避开”。你自己的对话和点名用它的任务不受影响。单个账号可以在它的“用量”里另设。</HelpText>
    <div class="grid">
      <label class="field"><span>任一窗口用到（%）以上（100 = 不看）</span><input v-model.number="draft.quotaAvoidAbove" class="input" type="number" inputmode="numeric" min="50" max="100" /></label>
      <label class="field"><span>周额度每天剩不到（%/天，0 = 不看）</span><input v-model.number="draft.quotaPerDayBelow" class="input" type="number" inputmode="decimal" min="0" max="100" step="0.5" /></label>
    </div>
    <div class="row wrap"><span class="spacer" /><button class="btn primary sm" @click="save">保存</button></div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}
</style>
