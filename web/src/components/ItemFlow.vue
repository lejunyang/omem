<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { del, get, onServerEvent, onServerResync, post } from "../api";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { actorWords, evidenceLink, nextWords, objectStatusWords, ownerTurn, stageActions, stageColour, stageLine, stageWords, type FlowAction, type FlowDefinition, type FlowFile, type FlowStage, type FlowView } from "../lib/flow";
import { refAction } from "../lib/refs";
import { fmtTime } from "../store";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import UiSelect from "./UiSelect.vue";

const props = withDefaults(defineProps<{ itemId: string; editable?: boolean }>(), { editable: true });
const data = ref<FlowView | null>(null), error = ref(""), loading = ref(true), busy = ref(false);
const selected = ref(""), historyCount = ref(10), picking = ref(false), definitions = ref<FlowDefinition[]>([]), choice = ref("");
const pickerLoading = ref(false);
let seq = 0, pickerSeq = 0, epoch = 0;
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 60000);
const current = computed(() => data.value?.stages.find((s) => ownerTurn(s) || s.state === "blocked") ?? data.value?.stages.find((s) => ["doing", "stale", "pending"].includes(s.state)) ?? data.value?.stages.at(-1));
const stage = computed(() => data.value?.stages.find((s) => s.id === selected.value) ?? current.value);
const waiting = computed(() => data.value?.flow?.endedAt ? [] : data.value?.stages.filter((s) => ownerTurn(s) || s.state === "blocked") ?? []);
const completed = computed(() => !!data.value?.flow?.endedAt && data.value.stages.every((s) => ["done", "skipped"].includes(s.state)));
async function load() {
  const request = ++seq, id = props.itemId;
  try { const result = await get<FlowView>(`/api/items/${id}/flow`); if (request === seq && id === props.itemId) { data.value = result; error.value = ""; } }
  catch (e) { if (request === seq) error.value = (e as Error).message; }
  finally { if (request === seq) loading.value = false; }
}
watch(() => props.itemId, () => { ++epoch; ++seq; ++pickerSeq; data.value = null; selected.value = ""; error.value = ""; busy.value = false; loading.value = true; picking.value = false; pickerLoading.value = false; definitions.value = []; historyCount.value = 10; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item" && e.id === props.itemId) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++epoch; ++seq; ++pickerSeq; off(); resync(); clearInterval(clock); });
async function mutate(id: string, path: string, payload?: unknown, remove = false) {
  if (id !== props.itemId || busy.value || !props.editable) return;
  const generation = epoch;
  busy.value = true; error.value = ""; ++seq;
  try { const result = remove ? await del<FlowView>(path) : await post<FlowView>(path, payload); if (generation === epoch) { ++seq; data.value = result; } }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
async function start(def: FlowDefinition) {
  const id = props.itemId, generation = epoch;
  if (!await confirmDialog(`开始「${def.name}」`, { message: def.stages.map((s) => `${s.name}：${(s.note || (s.by === "owner" ? "由你完成" : s.by === "wait" ? "等待进展" : "由助理跟进")).replace(/[。！？\s]+$/, "")}。`).join("\n"), okText: "开始" })) return;
  if (generation === epoch) await mutate(id, `/api/items/${id}/flow`, { flow: def.id });
}
async function pick() {
  picking.value = !picking.value;
  if (!picking.value) return;
  const request = ++pickerSeq;
  pickerLoading.value = true;
  try {
    const result = await get<{ flows: FlowFile[] }>("/api/flows");
    if (request === pickerSeq) { definitions.value = result.flows.flatMap((f) => f.definition ? [f.definition] : []); choice.value = definitions.value[0]?.id ?? ""; }
  } catch (e) { if (request === pickerSeq) error.value = (e as Error).message; }
  finally { if (request === pickerSeq) pickerLoading.value = false; }
}
async function act(s: FlowStage, a: FlowAction) {
  const id = props.itemId, generation = epoch;
  let note: string | undefined;
  if (a.reason) {
    const result = await promptDialog(a.label, { fields: [{ id: "note", label: "原因或完成说明", value: "", required: true, maxLength: 4000 }], okText: a.label });
    if (!result?.note.trim()) return;
    note = result.note.trim();
  }
  if (generation === epoch) await mutate(id, `/api/items/${id}/flow/stages/${s.id}/${a.action}`, { note });
}
async function stop() {
  const id = props.itemId, generation = epoch;
  if (await confirmDialog("停止流程", { message: "保留已有阶段与经过，撤回尚未回答的问题。事项仍由你决定是否关闭。", danger: true, okText: "停止" }) && generation === epoch) await mutate(id, `/api/items/${id}/flow`, undefined, true);
}
</script>

<template>
  <section class="item-flow" aria-label="事项流程" :aria-busy="busy">
    <Skeleton v-if="loading" variant="text" :rows="2" />
    <p v-if="error" class="error small" role="alert">{{ error }} <button class="btn ghost sm" :disabled="busy" @click="load">重试</button></p>
    <template v-if="data && !data.flow && editable">
      <div v-if="data.suits[0]" class="row wrap small muted">可以按流程推进：{{ data.suits[0].name }} <button class="btn ghost sm" :disabled="busy" @click="start(data.suits[0])">开始</button><button v-if="data.suits.length > 1" class="btn ghost sm" :aria-expanded="picking" @click="pick">其他流程…</button></div>
      <button v-if="!data.suits.length" class="btn ghost sm" :aria-expanded="picking" :disabled="busy" @click="pick">用流程推进…</button>
      <div v-if="picking" class="stack">
        <Skeleton v-if="pickerLoading" variant="text" :rows="2" />
        <template v-else><UiSelect v-model="choice" aria-label="选择流程" :options="definitions.map((d) => ({ value: d.id, label: d.name }))" /><button class="btn sm" :disabled="busy || !choice" @click="start(definitions.find((d) => d.id === choice)!)">开始</button><p v-if="!definitions.length" class="muted small">还没有可用的流程。<router-link to="/flows">编写流程</router-link></p></template>
      </div>
    </template>
    <template v-else-if="data?.flow">
      <div class="row wrap"><strong class="section-title">{{ data.flow.name }}</strong><span class="spacer" /><details v-if="editable && !data.flow.endedAt" class="flow-menu"><summary class="small">更多</summary><button class="btn ghost sm" :disabled="busy" @click="stop">停止流程</button></details></div>
      <div class="flow-strip" aria-label="阶段">
        <button v-for="s in data.stages" :key="s.id" class="segment" :class="[stageColour(s), { selected: stage?.id === s.id }]" :aria-pressed="stage?.id === s.id" @click="selected = s.id"><span>{{ s.name }}</span><small>{{ stageLine(s, now) || '　' }}</small></button>
      </div>
      <p v-if="data.flow.endedAt" class="muted small">{{ completed ? '流程走完了' : '流程已停止' }}</p>
      <div v-for="s in waiting" :key="s.id" class="action-card card pad stack">
        <strong>{{ s.name }}</strong><p>{{ nextWords(s) }}</p>
        <div v-if="editable" class="row wrap"><button v-for="(a, i) in stageActions(s)" :key="a.label" class="btn sm" :class="i === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="act(s, a)">{{ a.label }}</button></div>
      </div>
      <div v-if="stage" class="stage-detail stack small">
        <strong>{{ stage.name }} <span class="muted">· {{ stageWords[stage.state] }}</span></strong>
        <Markdown v-if="stage.instruction" :source="stage.instruction" />
        <div class="muted">承担：<a v-if="stage.carrier.link" :href="stage.carrier.link">{{ stage.carrier.label }}</a><span v-else>{{ stage.carrier.label }}</span></div>
        <a v-if="stage.object" :href="stage.object.link" class="object-row">{{ stage.object.title }} <span class="badge" :title="stage.object.status">{{ objectStatusWords(stage.object.status) }}</span></a>
        <div v-if="stage.evidence.length" class="row wrap evidence"><span class="muted">依据</span><template v-for="(r, i) in stage.evidence" :key="r"><a v-if="refAction(r)" href="#" :title="r" @click.prevent="refAction(r)!()">原件 {{ i + 1 }}</a><a v-else :href="evidenceLink(r)!" :title="r">{{ r.startsWith('design:') ? '方案' : '运行' }} {{ i + 1 }}</a></template></div>
        <Markdown v-if="stage.note" :source="stage.note" />
        <button v-if="editable && ['done', 'skipped', 'stale'].includes(stage.state)" class="btn ghost sm reopen" :disabled="busy" @click="act(stage, { action: 'reopen', label: '重开这一段', reason: true })">重开这一段</button>
      </div>
      <details v-if="data.log.length" class="history"><summary class="small">经过</summary><ol><li v-for="l in data.log.slice(0, historyCount)" :key="l.id"><span class="small muted">{{ fmtTime(l.at) }} · {{ actorWords(l.actor) }}</span><div>{{ data.stages.find((s) => s.id === l.stageId)?.name ?? l.stageId }} · {{ l.fromState ? stageWords[l.fromState] + ' → ' : '' }}{{ stageWords[l.toState] }}</div><Markdown v-if="l.note" :source="l.note" class="small" /></li></ol><button v-if="historyCount < data.log.length" class="btn ghost sm" @click="historyCount += 10">再看十条</button></details>
    </template>
  </section>
</template>

<style scoped>
.item-flow { display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.flow-strip { display: flex; flex-wrap: wrap; gap: 4px; }
.segment { flex: 1 1 72px; min-width: 0; padding: 6px; border: 1px solid var(--line); border-top: 3px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--panel); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.segment small { display: block; color: var(--muted); font-size: 11px; }
.segment.ok { border-top-color: var(--ok); }.segment.accent { border-top-color: var(--accent); }.segment.warn { border-top-color: var(--warn); }
.segment.selected { background: var(--hover); }
.action-card { border-left: 3px solid var(--warn); }
.stage-detail { border-left: 2px solid var(--line); padding-left: 12px; gap: 6px; }
.stage-detail :deep(p), .history :deep(p) { margin: 0; }
.object-row, .evidence { display: flex; flex-wrap: wrap; gap: 6px; }
.reopen { justify-self: start; }
.error { color: var(--danger); margin: 0; }
.history ol { padding-left: 18px; display: grid; gap: 12px; }
summary { cursor: pointer; color: var(--muted); }
.flow-menu { text-align: right; }
</style>
