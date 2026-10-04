<script setup lang="ts">
import { ref, watch } from "vue";
import { OmButton, OmDisclosure } from "@omem/ui";
import ContextPicker from "./ContextPicker.vue";
import { api } from "./api";
import type { ContextAssignment, MaterialContext } from "../../../packages/contracts/src/contexts";
const props = defineProps<{ sourceId: string }>();
const selected = ref<string[]>([]), loaded = ref(false), saving = ref(false), message = ref(""), error = ref("");
const assignment = ref<ContextAssignment | null>(null), candidates = ref<MaterialContext[]>([]);
const expanded = ref(false);
watch(() => props.sourceId, async id => {
  loaded.value = false; message.value = ""; error.value = ""; assignment.value = null; candidates.value = []; expanded.value = false;
  try {
    const result = await api<{ contextIds: string[]; assignment: ContextAssignment | null; candidates: MaterialContext[] }>(`/sources/${encodeURIComponent(id)}/contexts`);
    if (id !== props.sourceId) return;
    selected.value = result.contextIds; assignment.value = result.assignment; candidates.value = result.candidates; loaded.value = true;
    expanded.value = result.assignment?.status === "ambiguous";
  } catch (e) { if (id === props.sourceId) error.value = String(e); }
}, { immediate: true });
async function save() {
  saving.value = true; error.value = ""; message.value = "";
  const sourceId = props.sourceId;
  try {
    const result = await api<{ assignment: ContextAssignment; queued: boolean }>(`/sources/${encodeURIComponent(sourceId)}/contexts`, { contextIds: selected.value }, "PUT");
    if (sourceId !== props.sourceId) return;
    assignment.value = result.assignment; candidates.value = [];
    message.value = "归属已保存，跟踪这些项目或主题的文章会按更新设置重新整理。" + (result.queued ? "已排队重新整理项目记忆；后台处理启用后会继续。" : "");
  } catch (e) { if (sourceId === props.sourceId) error.value = String(e); }
  finally { saving.value = false; }
}
</script>
<template>
  <OmDisclosure v-model:open="expanded" class="source-contexts" :title="assignment?.status === 'ambiguous' ? '所属项目与主题 · 需要补充' : '所属项目与主题'">
    <p>归属适用于这份材料的所有版本。调整归属不会删除原文或历史引用。手动保存后以你的选择为准，包括不选项目。</p>
    <div v-if="assignment && assignment.status !== 'manual'" class="assignment-note">
      <strong>{{ assignment.status === 'automatic' ? 'AI 已整理归属，可在下方调整' : assignment.status === 'ambiguous' ? '暂时无法确定归属' : '未找到合适的已有项目或主题' }}</strong>
      <p>{{ assignment.reason }}</p>
      <p v-if="assignment.question">{{ assignment.question }}</p>
      <p v-if="candidates.length">可能属于：{{ candidates.map(c => `${c.name}${c.description ? `（${c.description}）` : ''}`).join('；') }}</p>
    </div>
    <ContextPicker v-if="loaded" v-model="selected" :disabled="saving" />
    <p v-else-if="!error" role="status">正在读取材料归属…</p>
    <OmButton v-if="loaded" type="button" variant="secondary" :loading="saving" @click="save">保存归属</OmButton>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </OmDisclosure>
</template>
<style scoped>
.source-contexts { margin: 16px 0; }
.source-contexts p { font-size: 14px; color: var(--om-secondary); }
.source-contexts button { margin-top: 16px; }
.source-contexts .error { color: var(--om-danger); }
.assignment-note { padding: 16px; margin: 16px 0; background: var(--om-soft); border-radius: 8px; }
.assignment-note p:last-child { margin-bottom: 0; }
</style>
