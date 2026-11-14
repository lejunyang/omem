<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import HelpText from "./HelpText.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import VirtualList from "./VirtualList.vue";
const props = defineProps<{ config: any; save: (patch: Record<string, unknown>) => Promise<void> }>();
type Tool = { name: string; description: string; always: boolean };
const tools = ref<Tool[]>([]);
const ladder = ref<{ tool: string; rung: string; streak: number }[]>([]);
const loaded = ref(false);
const error = ref("");
const filter = ref("");
const options = [{ value: "ask", label: "每次问我" }, { value: "report", label: "做完告诉我" }, { value: "free", label: "不用问" }];
const rung = (t: Tool) => t.always || props.config.approvals.tools.includes(t.name) ? "ask" : (props.config.approvals.report ?? []).includes(t.name) ? "report" : "free";
// Every tool is a long page: without a search only the ones that ask or report are listed.
const shown = computed(() => {
  const q = filter.value.trim();
  return q ? tools.value.filter((t) => `${t.name} ${t.description}`.includes(q)) : tools.value.filter((t) => rung(t) !== "free");
});
const free = computed(() => tools.value.filter((t) => rung(t) === "free").length);
async function load() {
  error.value = "";
  try {
    const [s, l] = await Promise.all([get<{ approvalTools: Tool[] }>("/api/settings"), get<typeof ladder.value>("/api/approvals/ladder")]);
    const known = s.approvalTools;
    for (const t of l) if (!known.some((k) => k.name === t.tool)) known.push({ name: t.tool, description: "当前未加载的工具", always: false });
    tools.value = known; ladder.value = l; loaded.value = true;
  } catch (e) { error.value = (e as Error).message; }
}
onMounted(load);
async function set(t: Tool, value: string) {
  const a = props.config.approvals;
  await props.save({ approvals: { ...a, tools: [...a.tools.filter((n: string) => n !== t.name), ...(value === "ask" ? [t.name] : [])], report: [...(a.report ?? []).filter((n: string) => n !== t.name), ...(value === "report" ? [t.name] : [])] } });
}
</script>
<template>
  <div class="card pad stack">
    <strong>工具审批</strong>
    <HelpText>要你批准的工具每次调用都等你点头。同一个工具你连续批准到设定的次数后，会问你一次要不要改成“直接做，做完告诉你”；改了以后每次调用完会在不急的通知里告诉你做了什么，随时可以在这里改回。在机器上点击、输入这类插件工具始终要批准。</HelpText>
    <label class="field">连续批准多少次后提议<input class="input count" type="number" min="0" max="100" :value="config.approvals.promoteAfter ?? 10" @change="save({ approvals: { ...config.approvals, promoteAfter: Number(($event.target as HTMLInputElement).value) } })" /><span class="hint">0 = 不提议</span></label>
    <p v-if="error" role="alert">{{ error }} <button class="btn sm" @click="load">重试</button></p>
    <Skeleton v-else-if="!loaded" :rows="3" />
    <template v-else>
      <input v-model="filter" class="input" aria-label="筛选工具" placeholder="输入工具名或用途，找到别的工具来改" />
      <p class="hint">{{ filter.trim() ? `匹配 ${shown.length} 个工具` : shown.length ? `下面是要你批准或做完告诉你的 ${shown.length} 个工具；其余 ${free} 个不用问，在上面输入工具名或用途可以找到并修改。` : `现在没有要你批准的工具（${free} 个都不用问）。在上面输入工具名或用途，可以把某个工具改成每次问你。` }}</p>
      <VirtualList :items="shown" :item-key="(t) => t.name" :estimate="100"><template #default="{ item: t }">
        <div class="tool stack">
          <span class="mono" :title="t.description">{{ t.name }}</span>
          <span class="muted small">已连续批准 {{ ladder.find((l) => l.tool === t.name)?.streak ?? 0 }} 次</span>
          <span v-if="t.always" class="hint">每次问我（插件要求批准）</span>
          <UiSegmented v-else :model-value="rung(t)" :options="options" size="sm" :aria-label="`${t.name} 的审批方式`" @change="(v) => set(t, v)" />
        </div>
      </template></VirtualList>
    </template>
  </div>
</template>
<style scoped>
.count { width: 100px; } .tool { padding: 12px 0; border-bottom: 1px solid var(--line); gap: 6px; min-width: 0; overflow-wrap: anywhere; align-items: start; }
.tool :deep(.ui-seg) { max-width: 100%; flex-wrap: wrap; }
</style>
