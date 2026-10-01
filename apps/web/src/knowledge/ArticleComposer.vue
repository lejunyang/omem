<script setup lang="ts">
import { computed, ref } from "vue";
import { OmButton } from "@omem/ui";
import { knowledgeApi } from "./api";
export type MaterialOption = { key: string; title: string; path: string | null; revisionId: string };
const props = defineProps<{ prefix: string; materials: MaterialOption[]; topicPath: string[]; running: boolean }>();
const emit = defineEmits<{ submitted: [] }>();
const title = ref(""), goal = ref(""), reader = ref("希望了解这个主题的人"), filter = ref(""), selected = ref<string[]>([]), error = ref(""), sending = ref(false);
const candidates = computed(() => props.materials.filter(m => m.title.toLowerCase().includes(filter.value.toLowerCase())));
async function submit() {
  sending.value = true; error.value = "";
  try {
    await knowledgeApi(props.prefix, "/pages", { method: "POST", body: JSON.stringify({ revisionIds: selected.value,
      brief: { key: "article:" + crypto.randomUUID(), title: title.value.trim(), order: 0, kind: "explanation", reader: reader.value.trim(), goal: goal.value.trim(), scenario: goal.value.trim(), questions: [goal.value.trim()], entryPaths: [], ...(props.topicPath.length ? { topicPath: props.topicPath } : {}) } }) });
    emit("submitted");
  } catch (e) { error.value = String(e); } finally { sending.value = false; }
}
</script>
<template>
  <details class="article-composer">
    <summary>从材料整理文章</summary>
    <form @submit.prevent="submit">
      <p class="muted">选择相关材料，写明你希望弄懂的问题。AI 会调查、撰写并复核；分类根据内容生成{{ topicPath.length ? '，文章放入“' + topicPath.join(' / ') + '”' : '' }}。</p>
      <label>文章主题<input v-model="title" required maxlength="240" placeholder="例如：听不懂英语连读时如何练习" /></label>
      <label>想弄懂什么<textarea v-model="goal" required maxlength="1600" rows="3" placeholder="希望文章解释的问题，以及你准备怎样使用它" /></label>
      <label>写给谁看<input v-model="reader" required maxlength="240" /></label>
      <fieldset><legend>原始材料 · 已选 {{ selected.length }}</legend>
        <input v-model="filter" aria-label="筛选整理材料" placeholder="按材料名称查找" />
        <div class="material-options"><label v-for="m in candidates" :key="m.revisionId"><input v-model="selected" type="checkbox" :value="m.revisionId" />{{ m.title }}</label><p v-if="!candidates.length">没有匹配的材料</p></div>
      </fieldset>
      <p v-if="error" role="alert">{{ error }}</p>
      <OmButton type="submit" :disabled="running || sending || !selected.length" :loading="sending">开始整理</OmButton>
    </form>
  </details>
</template>
<style scoped>
.article-composer{margin:24px 0;padding:16px 20px;border:1px solid var(--om-line);border-radius:8px;}summary{min-height:44px;cursor:pointer;padding:8px 0;font-weight:600;}form{display:grid;gap:20px;padding:12px 0;}form>label{display:grid;gap:8px;}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;font:inherit;min-height:44px;padding:10px;border:1px solid var(--om-line);border-radius:6px;background:var(--om-panel);}fieldset{min-width:0;border:1px solid var(--om-line);padding:16px;}legend{padding:0 8px;}.material-options{max-height:240px;overflow:auto;margin-top:12px;}.material-options label{display:flex;align-items:start;gap:10px;min-height:44px;padding:10px 0;overflow-wrap:anywhere;}.material-options input{flex:0 0 auto;margin-top:5px;}.muted{color:var(--om-muted);margin:0;}[role=alert]{color:var(--om-danger);}
</style>
