<script setup lang="ts">
import { ref, watch } from "vue";
import AiDefaults from "./AiDefaults.vue";
import UiCheckbox from "./UiCheckbox.vue";
import { toast } from "../store";

type Candidate = { profile: string; model?: string; effort?: string; when: string };
type Routing = { automatic: boolean; guidance: string; candidates: Candidate[] };
const props = defineProps<{ value: Routing; backends: { id: string; name?: string; installed: boolean; transport: string; model?: string; effort?: string }[] }>();
const emit = defineEmits<{ save: [value: Routing] }>();
const draft = ref<Routing>({ automatic: true, guidance: "", candidates: [] });
watch(() => props.value, (v) => { draft.value = JSON.parse(JSON.stringify(v ?? { automatic: true, guidance: "", candidates: [] })); }, { immediate: true });
function save() {
  if (draft.value.candidates.some((c) => !c.profile || !c.when.trim())) return toast("每个候选都需要后端和适用说明", "error");
  emit('save', JSON.parse(JSON.stringify(draft.value)));
}
</script>
<template>
  <div class="card pad stack">
    <div class="section-title">任务选型</div>
    <p class="muted small">档案里的 AI 是默认值。你在任务中指定后端、模型或强度时，助手可临时使用；复杂任务也可以让助手根据下面的偏好选择。每次选择及理由会记入运行。</p>
    <UiCheckbox v-model="draft.automatic" switch>允许助手按任务自主选择 AI</UiCheckbox>
    <label class="field"><span>总体偏好</span><textarea v-model="draft.guidance" class="input" rows="4" maxlength="8000" placeholder="例如：简单整理优先快模型；涉及多个模块的改动用较强的推理模型；评审尽量用不同于编码的模型。" /></label>
    <p class="muted small">候选用明确的后端和模型配上适用说明，避免只写模型简称产生歧义。这是选型参考，助手仍会核对可用性；关闭自主选择后，只有你明确指定时才临时更换。</p>
    <div v-for="(c, i) in draft.candidates" :key="i" class="candidate stack">
      <div class="row"><strong class="small">候选 {{ i + 1 }}</strong><span class="spacer" /><button class="btn ghost sm danger" @click="draft.candidates.splice(i, 1)">移除</button></div>
      <AiDefaults :model-value="{ agent: c.profile, model: c.model, effort: c.effort }" :backends="backends.map((b) => ({ ...b, name: b.name || b.id }))" default-backend="" @update:model-value="(v) => Object.assign(c, { profile: v.agent ?? '', model: v.model, effort: v.effort })" />
      <label class="field"><span>适合哪些任务</span><textarea v-model="c.when" class="input" rows="2" maxlength="2000" placeholder="说明适用场景，也可以写成本、速度或避免使用的情况" /></label>
    </div>
    <div class="row wrap"><button class="btn sm" :disabled="draft.candidates.length >= 50" @click="draft.candidates.push({ profile: '', when: '' })">＋ 添加候选</button><span class="spacer" /><button class="btn primary sm" @click="save">保存任务选型</button></div>
  </div>
</template>
<style scoped>
.candidate { padding: 14px 0; border-top: 1px solid var(--line); min-width: 0; }
</style>
