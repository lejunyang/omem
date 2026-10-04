<script setup lang="ts">
import { onMounted, ref } from "vue";
import { OmButton, OmDisclosure } from "@omem/ui";
import type { MaterialContext } from "../../../packages/contracts/src/contexts";
import { api } from "./api";
const props = withDefaults(defineProps<{ modelValue: string[]; label?: string; disabled?: boolean }>(), { label: "项目或主题（可选）", disabled: false });
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const contexts = ref<MaterialContext[]>([]), loading = ref(true), creating = ref(false), error = ref("");
const name = ref(""), description = ref(""), kind = ref<"project" | "topic">("project");
onMounted(async () => {
  try { contexts.value = await api<MaterialContext[]>("/contexts"); }
  catch (e) { error.value = String(e); }
  finally { loading.value = false; }
});
function select(id: string, checked: boolean) {
  emit("update:modelValue", checked ? [...new Set([...props.modelValue, id])] : props.modelValue.filter(value => value !== id));
}
async function create() {
  creating.value = true; error.value = "";
  try {
    const context = await api<MaterialContext>("/contexts", { name: name.value, description: description.value, kind: kind.value });
    contexts.value.push(context); select(context.id, true); name.value = ""; description.value = "";
  } catch (e) { error.value = String(e); }
  finally { creating.value = false; }
}
</script>
<template>
  <fieldset class="context-picker" :disabled="disabled">
    <legend>{{ label }}</legend>
    <p v-if="loading" role="status">正在读取项目与主题…</p>
    <div v-else class="context-options">
      <label v-for="context in contexts" :key="context.id" class="context-option">
        <input type="checkbox" :checked="modelValue.includes(context.id)" @change="select(context.id, ($event.target as HTMLInputElement).checked)" />
        <span><strong>{{ context.name }}</strong><small>{{ context.kind === 'project' ? '项目' : '主题' }} · {{ context.sourceCount }} 份材料<span v-if="context.description"> · {{ context.description }}</span></small></span>
      </label>
      <p v-if="!contexts.length">可以按长期项目或学习主题归集材料，也可以暂不选择。</p>
    </div>
    <OmDisclosure title="新建项目或主题">
      <div class="context-create">
        <label>名称<input v-model="name" maxlength="120" placeholder="例如：季度发布、英语学习" /></label>
        <label>类型<select v-model="kind"><option value="project">项目</option><option value="topic">主题</option></select></label>
        <label>范围说明<textarea v-model="description" rows="2" maxlength="1600" placeholder="哪些事情属于这里？" /></label>
        <OmButton type="button" variant="secondary" :disabled="!name.trim() || creating" :loading="creating" @click="create">创建并选中</OmButton>
      </div>
    </OmDisclosure>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </fieldset>
</template>
<style scoped>
.context-picker { margin: 0; padding: 16px; border: 1px solid var(--om-line); border-radius: 8px; min-width: 0; }
.context-picker legend { padding: 0 8px; font-weight: 600; font-size: 14px; }
.context-options { max-height: 240px; overflow: auto; margin-bottom: 12px; }
.context-option { display: flex; flex-direction: row; align-items: flex-start; gap: 12px; min-height: 44px; padding: 8px 0; cursor: pointer; }
.context-option input { width: 18px; height: 18px; flex: 0 0 18px; margin: 4px 0 0; padding: 0; accent-color: var(--om-ink); }
.context-option span { min-width: 0; overflow-wrap: anywhere; }
.context-option strong { display: block; font-size: 14px; }
.context-option small { display: block; color: var(--om-muted); line-height: 1.7; }
.context-option small span { display: inline; }
.context-create { display: grid; gap: 12px; padding: 12px 0; }
.context-create label { display: grid; gap: 6px; font-size: 14px; }
.context-create input, .context-create select, .context-create textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid var(--om-line); border-radius: 6px; background: var(--om-panel); color: var(--om-ink); }
.context-create button { justify-self: start; }
.context-picker p { color: var(--om-secondary); font-size: 14px; line-height: 1.8; margin: 8px 0; }
.context-picker .error { color: var(--om-danger); }
</style>
