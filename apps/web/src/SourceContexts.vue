<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { OmButton, OmDisclosure } from "@omem/ui";
import ContextPicker from "./ContextPicker.vue";
import { api } from "./api";
import type {
  ContextAssignment,
  MaterialContext,
} from "../../../packages/contracts/src/contexts";
const props = defineProps<{ sourceId: string }>();
const selected = ref<string[]>([]),
  loaded = ref(false),
  saving = ref(false),
  message = ref(""),
  error = ref("");
const assignment = ref<ContextAssignment | null>(null),
  candidates = ref<MaterialContext[]>([]);
const savedIds = ref<string[]>([]),
  contexts = ref<MaterialContext[]>([]);
const savedNames = computed(() =>
  savedIds.value
    .map((id) => contexts.value.find((context) => context.id === id)?.name)
    .filter((name): name is string => !!name),
);
const expanded = ref(false);
watch(
  () => props.sourceId,
  async (id) => {
    loaded.value = false;
    message.value = "";
    error.value = "";
    assignment.value = null;
    candidates.value = [];
    savedIds.value = [];
    contexts.value = [];
    expanded.value = false;
    try {
      const result = await api<{
        contextIds: string[];
        assignment: ContextAssignment | null;
        candidates: MaterialContext[];
      }>(`/sources/${encodeURIComponent(id)}/contexts`);
      if (id !== props.sourceId) return;
      selected.value = result.contextIds;
      savedIds.value = [...result.contextIds];
      assignment.value = result.assignment;
      candidates.value = result.candidates;
      loaded.value = true;
      expanded.value = result.assignment?.status === "ambiguous";
    } catch (e) {
      if (id === props.sourceId) error.value = String(e);
    }
  },
  { immediate: true },
);
async function save() {
  saving.value = true;
  error.value = "";
  message.value = "";
  const sourceId = props.sourceId;
  try {
    const result = await api<{
      assignment: ContextAssignment;
      queued: boolean;
    }>(
      `/sources/${encodeURIComponent(sourceId)}/contexts`,
      { contextIds: selected.value },
      "PUT",
    );
    if (sourceId !== props.sourceId) return;
    assignment.value = result.assignment;
    candidates.value = [];
    savedIds.value = [...selected.value];
    message.value =
      "归属已保存，跟踪这些项目或主题的文章会按更新设置重新整理。" +
      (result.queued ? "已排队重新整理项目记忆；后台处理启用后会继续。" : "");
  } catch (e) {
    if (sourceId === props.sourceId) error.value = String(e);
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <section class="source-contexts" aria-label="所属项目与主题">
    <div class="context-summary">
      <h3>所属项目与主题</h3>
      <p v-if="!loaded && !error" role="status">正在读取材料归属…</p>
      <template v-else-if="loaded">
        <p v-if="savedNames.length" class="saved-contexts">
          {{ savedNames.join("、") }}
        </p>
        <p v-else-if="savedIds.length">
          已归属 {{ savedIds.length }} 个项目或主题。
        </p>
        <p v-else>
          {{
            assignment?.status === "ambiguous"
              ? "归属需要补充，请在下方选择或说明。"
              : "尚未归入项目或主题。"
          }}
        </p>
        <span v-if="assignment?.status === 'manual'" class="muted"
          >按你的选择保存</span
        >
        <span v-else-if="assignment?.status === 'automatic'" class="muted"
          >AI 已整理归属，可按需要调整</span
        >
      </template>
    </div>
    <OmDisclosure v-if="loaded" v-model:open="expanded" title="调整材料归属">
      <div class="context-editor">
        <p>
          归属适用于这份材料的所有版本。调整归属不会删除原文或历史引用。手动保存后以你的选择为准，包括不选项目。
        </p>
        <div
          v-if="assignment && assignment.status !== 'manual'"
          class="assignment-note"
        >
          <strong>{{
            assignment.status === "automatic"
              ? "AI 已整理归属，可在下方调整"
              : assignment.status === "ambiguous"
                ? "暂时无法确定归属"
                : "未找到合适的已有项目或主题"
          }}</strong>
          <p>{{ assignment.reason }}</p>
          <p v-if="assignment.question">{{ assignment.question }}</p>
          <p v-if="candidates.length">
            可能属于：{{
              candidates
                .map(
                  (c) =>
                    `${c.name}${c.description ? `（${c.description}）` : ""}`,
                )
                .join("；")
            }}
          </p>
        </div>
        <ContextPicker
          v-model="selected"
          :disabled="saving"
          @loaded="contexts = $event"
        />
        <OmButton
          type="button"
          variant="secondary"
          :loading="saving"
          @click="save"
          >保存归属</OmButton
        >
      </div>
    </OmDisclosure>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.source-contexts {
  display: grid;
  gap: 12px;
  margin: 24px 0;
  padding-top: 24px;
  border-top: 1px solid var(--om-line);
}
.source-contexts h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.source-contexts p {
  margin: 0;
  font-size: 14px;
  color: var(--om-secondary);
}
.context-summary {
  display: grid;
  gap: 8px;
}
.context-summary .saved-contexts {
  color: var(--om-ink);
}
.context-summary > span {
  font-size: 13px;
}
.context-editor {
  display: grid;
  gap: 16px;
}
.context-editor > button {
  justify-self: start;
}
.source-contexts .error {
  color: var(--om-danger);
}
.assignment-note {
  display: grid;
  gap: 8px;
  padding: 16px;
  background: var(--om-soft);
  border-radius: 8px;
}
</style>
