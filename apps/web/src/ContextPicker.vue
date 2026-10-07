<script setup lang="ts">
import { onMounted, ref } from "vue";
import { OmButton, OmCheckbox, OmDisclosure, OmSelect } from "@omem/ui";
import type { MaterialContext } from "../../../packages/contracts/src/contexts";
import { api } from "./api";
const props = withDefaults(
  defineProps<{ modelValue: string[]; label?: string; disabled?: boolean }>(),
  { label: "项目或主题（可选）", disabled: false },
);
const emit = defineEmits<{
  "update:modelValue": [value: string[]];
  loaded: [contexts: MaterialContext[]];
}>();
const contexts = ref<MaterialContext[]>([]),
  loading = ref(true),
  creating = ref(false),
  error = ref("");
const name = ref(""),
  description = ref(""),
  kind = ref<"project" | "topic">("project");
onMounted(async () => {
  try {
    contexts.value = await api<MaterialContext[]>("/contexts");
    emit("loaded", contexts.value);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
});
function select(id: string, checked: boolean) {
  emit(
    "update:modelValue",
    checked
      ? [...new Set([...props.modelValue, id])]
      : props.modelValue.filter((value) => value !== id),
  );
}
async function create() {
  creating.value = true;
  error.value = "";
  try {
    const context = await api<MaterialContext>("/contexts", {
      name: name.value,
      description: description.value,
      kind: kind.value,
    });
    contexts.value.push(context);
    emit("loaded", contexts.value);
    select(context.id, true);
    name.value = "";
    description.value = "";
  } catch (e) {
    error.value = String(e);
  } finally {
    creating.value = false;
  }
}
</script>
<template>
  <fieldset class="context-picker" :disabled="disabled">
    <legend>{{ label }}</legend>
    <p v-if="loading" role="status">正在读取项目与主题…</p>
    <div v-else class="context-options">
      <div
        v-for="context in contexts"
        :key="context.id"
        class="context-option"
        :class="{ selected: modelValue.includes(context.id) }"
      >
        <OmCheckbox
          :checked="modelValue.includes(context.id)"
          @change="
            select(context.id, ($event.target as HTMLInputElement).checked)
          "
        >
          <span class="context-description"
            ><strong>{{ context.name }}</strong
            ><small
              >{{ context.kind === "project" ? "项目" : "主题" }} ·
              {{ context.sourceCount }} 份材料<span v-if="context.description">
                · {{ context.description }}</span
              ></small
            ></span
          >
        </OmCheckbox>
      </div>
      <p v-if="!contexts.length">
        可以按长期项目或学习主题归集材料，也可以暂不选择。
      </p>
    </div>
    <OmDisclosure class="context-new" title="新建项目或主题">
      <div class="context-create">
        <label
          >名称<input
            v-model="name"
            maxlength="120"
            placeholder="例如：季度发布、英语学习"
        /></label>
        <label
          >类型<OmSelect v-model="kind"
            ><option value="project">项目</option>
            <option value="topic">主题</option></OmSelect
          ></label
        >
        <label class="context-scope"
          >范围说明<textarea
            v-model="description"
            rows="2"
            maxlength="1600"
            placeholder="哪些事情属于这里？"
          />
        </label>
        <OmButton
          type="button"
          variant="secondary"
          :disabled="!name.trim() || creating"
          :loading="creating"
          @click="create"
          >创建并选中</OmButton
        >
      </div>
    </OmDisclosure>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </fieldset>
</template>
<style scoped>
.context-picker {
  margin: 0;
  padding: 16px;
  border: 1px solid var(--om-line);
  border-radius: 8px;
  min-width: 0;
}
.context-picker legend {
  padding: 0 8px;
  font-weight: 600;
  font-size: 14px;
}
.context-options {
  display: grid;
  gap: 4px;
  max-height: 280px;
  overflow: auto;
  padding: 4px;
  margin: -4px -4px 12px;
}
.context-option {
  min-width: 0;
  border-radius: 6px;
}
.context-option :deep(.om-choice) {
  width: 100%;
  align-items: flex-start;
  gap: 12px;
  min-height: 56px;
  padding: 8px 12px;
}
.context-option:hover,
.context-option.selected {
  background: var(--om-soft);
}
.context-description {
  min-width: 0;
  overflow-wrap: anywhere;
}
.context-option strong {
  display: block;
  font-size: 14px;
}
.context-option small {
  display: block;
  color: var(--om-muted);
  line-height: 1.7;
}
.context-option small span {
  display: inline;
}
.context-new {
  padding-top: 8px;
  border-top: 1px solid var(--om-line);
}
.context-create {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 16px;
  padding: 8px 0;
}
.context-create label {
  display: grid;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
}
.context-create input,
.context-create textarea {
  width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  font: inherit;
  padding: 10px 12px;
  border: 1px solid var(--om-line);
  border-radius: 6px;
  background: var(--om-panel);
  color: var(--om-ink);
}
.context-scope {
  grid-column: 1 / -1;
}
.context-create button {
  grid-column: 1 / -1;
  justify-self: start;
}
.context-picker p {
  color: var(--om-secondary);
  font-size: 14px;
  line-height: 1.8;
  margin: 8px 0;
}
.context-picker .error {
  color: var(--om-danger);
}
@media (max-width: 700px) {
  .context-create {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
