<script setup lang="ts">
import { ref, watch } from "vue";
import AiDefaults from "./AiDefaults.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import { toast } from "../store";

type Candidate = { profile: string; model?: string; effort?: string; when: string };
type Choose = { conversation: "off" | "decision"; rules: "off" | "decision" | "always"; tasks: "off" | "decision" | "always" };
type Routing = { automatic: boolean; guidance: string; candidates: Candidate[]; choose: Choose; pinnedFallback: "unavailable" | "never" };
const CHOOSE: Choose = { conversation: "decision", rules: "decision", tasks: "off" };
const OFF = { value: "off", label: "不选" };
const DECISION = { value: "decision", label: "有决策模型时选" };
const ALWAYS = { value: "always", label: "总是选" };
const props = defineProps<{ value: Routing; backends: { id: string; name?: string; installed: boolean; transport: string; model?: string; effort?: string }[] }>();
const emit = defineEmits<{ save: [value: Routing] }>();
const draft = ref<Routing>({ automatic: true, guidance: "", candidates: [], choose: { ...CHOOSE }, pinnedFallback: "unavailable" });
watch(() => props.value, (v) => {
  const next = JSON.parse(JSON.stringify(v ?? { automatic: true, guidance: "", candidates: [] }));
  draft.value = { ...next, choose: { ...CHOOSE, ...(next.choose ?? {}) }, pinnedFallback: next.pinnedFallback ?? "unavailable" };
}, { immediate: true });
function save() {
  if (draft.value.candidates.some((c) => !c.profile || !c.when.trim())) return toast("每个候选都需要后端和适用说明", "error");
  emit('save', JSON.parse(JSON.stringify(draft.value)));
}
</script>
<template>
  <div class="card pad stack">
    <div class="section-title">任务选型</div>
    <p class="muted small">平时用档案里设的 AI。你在对话里点名要某个模型时，助手临时换用；打开下面的开关，助手交办时会按偏好自己挑，没指定 AI 的运行也可以在开始前自动选。每次换用和理由都记在运行里。</p>
    <UiCheckbox v-model="draft.automatic" switch>允许按任务自动选择 AI</UiCheckbox>
    <label class="field"><span>总体偏好</span><textarea v-model="draft.guidance" class="input" rows="4" maxlength="8000" placeholder="例如：简单整理优先快模型；涉及多个模块的改动用较强的推理模型；评审尽量用不同于编码的模型。" /></label>
    <div class="section-title">运行前自动选</div>
    <p class="muted small">没有指定 AI 的运行，开始前从下面的候选和它原来的 AI 里挑一个：按总体偏好、各候选的适用说明、现在的时间、占用和账号额度。决策模型（设置 → AI → 决策）一两秒就能选完；“总是选”在没有决策模型时让通用模型选（多等十几秒）。选中的先用，原来的 AI 和兜底排在后面，出错照样换。规则指定的 AI、助手交办时选的 AI、对话里 /model 选的不会被改。</p>
    <div class="choose">
      <span class="small">和助手的对话（新开 Agent 会话时选，会话延续期间不换）</span>
      <UiSegmented v-model="draft.choose.conversation" size="sm" aria-label="对话" :options="[OFF, DECISION]" />
      <span class="small">规则交给的 Agent</span>
      <UiSegmented v-model="draft.choose.rules" size="sm" aria-label="规则" :options="[OFF, DECISION, ALWAYS]" />
      <span class="small">交办和后台任务（编码、评审除外）</span>
      <UiSegmented v-model="draft.choose.tasks" size="sm" aria-label="交办和后台任务" :options="[OFF, DECISION, ALWAYS]" />
    </div>
    <div class="choose">
      <span class="small">点名的 AI（规则指定、交办时选的、本人指定的）排队、限流、额度用完或出故障时</span>
      <UiSegmented v-model="draft.pinnedFallback" size="sm" aria-label="点名的 AI 不可用时" :options="[{ value: 'unavailable', label: '换兜底和候选' }, { value: 'never', label: '不换，直接失败' }]" />
    </div>
    <p class="muted small">换了的运行里写明“原指定的 AI、为什么换、换成了谁”。每次运行开始前选了谁、为什么没有选（关着、没有候选、点名了 AI），也都记在运行详情里。</p>
    <p class="muted small">候选：列出可以换用的后端和模型，各写一句适合什么任务。后端出错、额度用完时，候选也排在兜底后面接手。</p>
    <div v-for="(c, i) in draft.candidates" :key="i" class="candidate stack">
      <div class="row"><strong class="small">候选 {{ i + 1 }}</strong><span class="spacer" /><button class="btn ghost sm danger" @click="draft.candidates.splice(i, 1)">移除</button></div>
      <AiDefaults :model-value="{ agent: c.profile, model: c.model, effort: c.effort }" :backends="backends.map((b) => ({ ...b, name: b.name || b.id }))" default-backend="" @update:model-value="(v) => Object.assign(c, { profile: v.agent ?? '', model: v.model, effort: v.effort })" />
      <label class="field"><span>适合哪些任务</span><textarea v-model="c.when" class="input" rows="2" maxlength="2000" placeholder="说明适用场景，也可以写成本、速度、时段（如“工作日白天排队，晚上和周末优先”）或避免使用的情况" /></label>
    </div>
    <div class="row wrap"><button class="btn sm" :disabled="draft.candidates.length >= 50" @click="draft.candidates.push({ profile: '', when: '' })">＋ 添加候选</button><span class="spacer" /><button class="btn primary sm" @click="save">保存任务选型</button></div>
  </div>
</template>
<style scoped>
.candidate { padding: 14px 0; border-top: 1px solid var(--line); min-width: 0; }
.choose { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; }
@media (max-width: 640px) { .choose { grid-template-columns: minmax(0, 1fr); } }
</style>
