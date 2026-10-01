<script setup lang="ts">
import { ref, computed } from "vue";
import { OmPanel, OmButton, OmEmpty } from "@omem/ui";
import type { Change } from "./api";
import ChangeComparison from "./ChangeComparison.vue";
const props = defineProps<{ changes: Change[] }>();
const emit = defineEmits<{ open: [id: string]; restore: [change: Change] }>();
const filter = ref("all");
const expanded = ref(new Set<string>());
const labels: Record<string, string> = { capture: "材料", knowledge: "知识", restore: "恢复", task: "事项", decision: "判断", answer: "问答", reference: "引用" };
const visible = computed(() => props.changes.filter(c => filter.value === "all" || c.kind === filter.value));
function summary(c: Change) {
  if (c.kind === "capture") return c.beforeId ? "原始材料已更新。展开查看具体增删。" : "首次保存原始材料。";
  if (c.kind === "knowledge" && !c.afterId) return "旧版知识整理记录：当时未保存正文版本关联。";
  return c.details;
}
</script>
<template>
  <section class="page">
    <h1>变更历史</h1>
    <p class="muted">查看材料和知识具体改了什么，以及事项状态如何变化。这里保留最近 200 条记录；恢复材料会创建新版本。</p>
    <label>查看范围<select v-model="filter"><option value="all">全部变化</option><option v-for="kind in [...new Set(changes.map(c => c.kind))]" :key="kind" :value="kind">{{ labels[kind] || '其他变化' }}</option></select></label>
    <OmPanel v-for="c in visible" :key="c.id" :title="c.title" class="stack">
      <small>{{ labels[c.kind] || '变化' }} · {{ new Date(c.createdAt).toLocaleString('zh-CN') }}</small>
      <p>{{ summary(c) }}</p>
      <details v-if="c.afterId && ['capture','restore','knowledge'].includes(c.kind)" @toggle="($event.currentTarget as HTMLDetailsElement).open && expanded.add(c.id)">
        <summary>查看内容差异</summary><ChangeComparison v-if="expanded.has(c.id)" :change-id="c.id" />
      </details>
      <template #actions><template v-if="['capture','restore'].includes(c.kind)">
        <OmButton v-if="c.afterId" @click="emit('open', c.afterId)">阅读此版本</OmButton>
        <OmButton v-if="c.beforeId && c.afterId" @click="emit('restore', c)">恢复为新版本</OmButton>
      </template></template>
    </OmPanel>
    <OmEmpty v-if="!visible.length" title="此范围暂无变化" />
  </section>
</template>
