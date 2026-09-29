<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { OmButton, OmBadge } from "@omem/ui";
import { knowledgeApi } from "./api";
const props = defineProps<{ prefix: string; documentKey?: string }>();
type Question = { id: string; question: string; why: string; nextStep: string; blocking: boolean; state: string; documentKey: string };
const questions = ref<Question[]>([]), active = ref(""), answer = ref(""), message = ref("");
const visible = computed(() => questions.value.filter(q => (!props.documentKey || q.documentKey === props.documentKey) && q.state !== "superseded"));
async function load() { questions.value = await knowledgeApi<Question[]>(props.prefix, "/questions"); }
onMounted(() => void load().catch(e => message.value = String(e)));
async function save(q: Question) {
  try { await knowledgeApi(props.prefix, `/questions/${q.id}/answer`, { method: "POST", body: JSON.stringify({ answer: answer.value }) }); message.value = "回答已作为原始材料保存，相关知识等待重新核对。"; active.value = ""; answer.value = ""; await load(); }
  catch (e) { message.value = String(e); }
}
async function task(q: Question) { try { await knowledgeApi(props.prefix, `/questions/${q.id}/task`, { method: "POST" }); message.value = "已加入待办。"; await load(); } catch(e) { message.value = String(e); } }
</script>
<template>
  <details v-if="visible.length" class="knowledge-questions">
    <summary>待核对与后续调查 · {{ visible.filter(q => q.state === 'open').length }}</summary>
    <p class="muted">材料中还不能确定的事项保留在这里。你可以补充背景，或将下一步调查加入待办。</p>
    <div v-for="q in visible" :key="q.id" class="question">
      <OmBadge>{{ q.state === 'answered' ? '已补充背景' : q.state === 'task' ? '已加入待办' : q.blocking ? '需要判断' : '后续调查' }}</OmBadge>
      <h4>{{ q.question }}</h4><p>{{ q.why }}</p><p class="muted">下一步：{{ q.nextStep }}</p>
      <div v-if="q.state === 'open'" class="actions"><OmButton variant="secondary" @click="active = q.id">补充背景</OmButton><OmButton variant="ghost" @click="task(q)">加入待办</OmButton></div>
      <form v-if="active === q.id" @submit.prevent="save(q)"><label :for="'answer-' + q.id">你的补充</label><textarea :id="'answer-' + q.id" v-model="answer" rows="3" required /><OmButton variant="primary" type="submit">保存为材料</OmButton></form>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
  </details>
</template>
<style scoped>
.knowledge-questions {border-top:1px solid var(--om-line);padding:20px 0;margin-top:24px;}summary {cursor:pointer;min-height:44px;font-weight:600;}.question {padding:20px 0;border-top:1px solid var(--om-line);}.question h4{margin:12px 0;font-size:16px;}.question p{line-height:1.8}.actions{display:flex;flex-wrap:wrap;gap:8px;}label,textarea{display:block;width:100%;margin:12px 0;}textarea{border:1px solid var(--om-line);padding:12px;background:var(--om-panel);color:var(--om-ink);}
</style>
