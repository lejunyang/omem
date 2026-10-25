<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { get } from "../api";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";
import { toast } from "../store";

/**
 * How much runs at once: omem's own slots (background tasks, conversations) and each model's limit.
 * A provider's quota is per account and model, so a full model makes a run move to another model the
 * role is configured for, or wait; a limit of 0 keeps a model out of every automatic choice.
 */
type Limit = { profile: string; model?: string; max: number };
type Value = { concurrency: number; interactiveConcurrency: number; perModel: number; limits: Limit[] };
type Load = { now: { source: string; model: string; used: number; waiting: number }[]; recent: { profile: string; model: string; done: number; failed: number; medianMinutes: number | null }[] };
const props = defineProps<{ value: Value; backends: { id: string; name?: string }[]; models: Record<string, string[]> }>();
const emit = defineEmits<{ save: [value: Value] }>();
const draft = ref<Value>({ concurrency: 2, interactiveConcurrency: 4, perModel: 3, limits: [] });
// The parent passes a fresh object on every render: reset the draft only when the saved values change.
watch(() => JSON.stringify(props.value), (v) => { draft.value = JSON.parse(v); }, { immediate: true });

const load = ref<Load | null>(null);
async function refresh() {
  try {
    load.value = await get<Load>("/api/agents/load");
  } catch {
    load.value = null;
  }
}
onMounted(refresh);

const backendOptions = () => props.backends.map((b) => ({ value: b.id, label: b.name ?? b.id, hint: b.id }));
const modelOptions = (l: Limit) => {
  const list = props.models[l.profile] ?? [];
  return [{ value: "", label: "整个后端合计" }, ...[...new Set([...(l.model ? [l.model] : []), ...list])].map((m) => ({ value: m, label: m }))];
};
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
function add() {
  draft.value.limits.push({ profile: props.backends[0]?.id ?? "", max: 2 });
}
function save() {
  const d = draft.value;
  if (d.limits.some((l) => !l.profile)) return toast("每条上限都要选后端", "error");
  emit("save", {
    concurrency: clamp(d.concurrency, 1, 32),
    interactiveConcurrency: clamp(d.interactiveConcurrency, 1, 16),
    perModel: clamp(d.perModel, 1, 32),
    limits: d.limits.map((l) => ({ profile: l.profile, ...(l.model ? { model: l.model } : {}), max: clamp(l.max, 0, 32) })),
  });
}
const rec = (source: string, model: string) => load.value?.recent.find((r) => r.profile === source && r.model === model);
</script>

<template>
  <div class="card pad stack">
    <div class="section-title">并行</div>
    <p class="muted small">后台任务（整理、Wiki、评审、存量整理的每一批）和对话各有总数；每个模型另有上限，满了的任务会换到这个角色配置过的其他模型（Agent 档案里按后端设的模型）和兜底，都满了就排队。同一账号的 ACP 和命令行后端算一个。对话回复不排队，但算在模型的占用里。</p>
    <div class="grid">
      <label class="field"><span>后台任务同时最多（1–32）</span><input v-model.number="draft.concurrency" class="input" type="number" inputmode="numeric" min="1" max="32" /></label>
      <label class="field"><span>对话同时最多（1–16）</span><input v-model.number="draft.interactiveConcurrency" class="input" type="number" inputmode="numeric" min="1" max="16" /></label>
      <label class="field"><span>每个模型默认最多（1–32）</span><input v-model.number="draft.perModel" class="input" type="number" inputmode="numeric" min="1" max="32" /></label>
    </div>
    <p class="muted small">单独的上限：选具体模型是这个模型的上限，选“整个后端合计”是这个后端所有模型加起来的上限（可以不设，只靠模型上限）。设成 0 的不会被自动换用或被助手选中，只有你点名时才用。</p>
    <div v-for="(l, i) in draft.limits" :key="i" class="row wrap lim">
      <UiSelect v-model="l.profile" size="sm" width="200px" aria-label="后端" :options="backendOptions()" @change="l.model = undefined" />
      <UiSelect :model-value="l.model ?? ''" size="sm" width="220px" aria-label="模型" :options="modelOptions(l)" @change="(v) => (l.model = v || undefined)" />
      <label class="row small">最多<input v-model.number="l.max" class="input sm num" type="number" inputmode="numeric" min="0" max="32" aria-label="上限" />个</label>
      <span class="spacer" />
      <button class="btn ghost sm icon" aria-label="移除" @click="draft.limits.splice(i, 1)"><Icon name="x" :size="14" /></button>
    </div>
    <div class="row wrap"><button class="btn sm" :disabled="draft.limits.length >= 100" @click="add"><Icon name="plus" :size="13" />添加上限</button><span class="spacer" /><button class="btn primary sm" @click="save">保存并行设置</button></div>
    <div class="row"><span class="section-title">现在</span><span class="spacer" /><button class="btn ghost sm" @click="refresh">刷新</button></div>
    <ul v-if="load?.now.length" class="now small">
      <li v-for="n in load.now" :key="n.source + n.model">
        <span class="mono">{{ n.source }}{{ n.model ? ` · ${n.model}` : "" }}</span>：正在用 {{ n.used }}<template v-if="n.waiting">，等 {{ n.waiting }}</template>
        <span v-if="rec(n.source, n.model)" class="muted">（近 7 天完成 {{ rec(n.source, n.model)!.done }}、失败 {{ rec(n.source, n.model)!.failed }}）</span>
      </li>
    </ul>
    <p v-else class="muted small">现在没有在用的模型。</p>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}
.lim {
  gap: 8px;
}
.num {
  width: 64px;
  margin: 0 4px;
}
.now {
  margin: 0;
  padding-left: 18px;
}
</style>
