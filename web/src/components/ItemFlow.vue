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
      <div class="flow-head">
        <span class="flow-name">{{ data.flow.name }}</span>
        <span v-if="data.flow.endedAt" class="muted small">{{ completed ? "走完了" : "已停止" }}</span>
        <span class="spacer" />
        <button v-if="editable && !data.flow.endedAt" type="button" class="link small" :disabled="busy" @click="stop">停止流程</button>
      </div>
      <div class="flow-strip" aria-label="阶段">
        <button v-for="s in data.stages" :key="s.id" type="button" class="segment" :class="[stageColour(s), { selected: stage?.id === s.id, skipped: s.state === 'skipped' }]" :aria-pressed="stage?.id === s.id" @click="selected = s.id">
          <span class="segment-bar" />
          <span class="segment-name">{{ s.name }}</span>
          <span class="segment-line">{{ stageLine(s, now) || "　" }}</span>
        </button>
      </div>
      <div v-for="s in waiting" :key="s.id" class="turn">
        <p>{{ nextWords(s) }}</p>
        <div v-if="editable" class="row wrap"><button v-for="(a, i) in stageActions(s)" :key="a.label" type="button" class="btn sm" :class="i === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="act(s, a)">{{ a.label }}</button></div>
      </div>
      <div v-if="stage" class="stage-detail">
        <div class="stage-title"><strong>{{ stage.name }}</strong><span class="muted">{{ stageWords[stage.state] }}</span></div>
        <Markdown v-if="stage.instruction && !waiting.some((s) => s.id === stage!.id)" :source="stage.instruction" class="stage-text" />
        <dl class="stage-facts">
          <dt>谁来做</dt>
          <dd><a v-if="stage.carrier.link" :href="stage.carrier.link">{{ stage.carrier.label }}</a><span v-else>{{ stage.carrier.label }}</span></dd>
          <template v-if="stage.object">
            <dt>跟着</dt>
            <dd><a :href="stage.object.link">{{ stage.object.title }}</a> <span class="badge" :title="stage.object.status">{{ objectStatusWords(stage.object.status) }}</span></dd>
          </template>
          <template v-if="stage.evidence.length">
            <dt>依据</dt>
            <dd class="evidence"><template v-for="(r, i) in stage.evidence" :key="r"><a v-if="refAction(r)" href="#" :title="r" @click.prevent="refAction(r)!()">原件 {{ i + 1 }}</a><a v-else :href="evidenceLink(r)!" :title="r">{{ r.startsWith("design:") ? "方案" : "运行" }} {{ i + 1 }}</a></template></dd>
          </template>
          <template v-if="stage.note">
            <dt>最近</dt>
            <dd><Markdown :source="stage.note" class="stage-text" /></dd>
          </template>
        </dl>
        <button v-if="editable && ['done', 'skipped', 'stale'].includes(stage.state)" type="button" class="link small" :disabled="busy" @click="act(stage, { action: 'reopen', label: '重开这一段', reason: true })">重开这一段</button>
      </div>
      <details v-if="data.log.length" class="history">
        <summary>经过</summary>
        <ol>
          <li v-for="l in data.log.slice(0, historyCount)" :key="l.id">
            <span class="history-what">{{ data.stages.find((s) => s.id === l.stageId)?.name ?? l.stageId }}：{{ stageWords[l.toState] }}</span>
            <span class="muted">{{ fmtTime(l.at) }} · {{ actorWords(l.actor) }}</span>
            <Markdown v-if="l.note" :source="l.note" class="stage-text muted" />
          </li>
        </ol>
        <button v-if="historyCount < data.log.length" type="button" class="link small" @click="historyCount += 10">再看十条</button>
      </details>
    </template>
  </section>
</template>

<style scoped>
.item-flow { display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.flow-head { display: flex; align-items: baseline; gap: 8px; }
.flow-name { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
.link { padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 12.5px; }
.link:hover { color: var(--ink); text-decoration: underline; }
.link:disabled { cursor: default; opacity: 0.6; }

/* A row of thin bars, one per stage: no boxes. Four colours only; skipped and stale are said in words. */
.flow-strip { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.segment { flex: 1 1 56px; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 0 0 4px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--radius-sm); }
.segment-bar { display: block; height: 3px; border-radius: 2px; background: var(--line-strong); }
.segment.ok .segment-bar { background: var(--ok); }
.segment.accent .segment-bar { background: var(--accent); }
.segment.warn .segment-bar { background: var(--warn); }
.segment.skipped .segment-bar { background: var(--line); }
.segment-name { margin-top: 2px; font-size: 13px; line-height: 1.3; color: var(--muted); }
.segment.ok .segment-name, .segment.accent .segment-name { color: var(--ink); }
.segment.warn .segment-name { color: var(--warn); font-weight: 600; }
.segment.selected .segment-name { font-weight: 600; color: var(--ink); }
.segment.warn.selected .segment-name { color: var(--warn); }
.segment-line { font-size: 11.5px; line-height: 1.3; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The stage in hand gets the room its line needs. */
.segment.warn, .segment.accent { flex: 1.7 1 84px; }
.segment.warn .segment-line { color: var(--warn); }
.segment:hover .segment-name { text-decoration: underline; }

/* What waits for the owner: said once, with the buttons that state allows. */
.turn { display: grid; gap: 10px; padding: 12px 14px; border-radius: var(--radius); background: var(--warn-soft); }
.turn p { margin: 0; font-size: 13.5px; line-height: 1.6; }

.stage-detail { display: grid; gap: 6px; font-size: 13px; }
.stage-title { display: flex; align-items: baseline; gap: 8px; }
.stage-title .muted { font-size: 12.5px; }
.stage-text { font-size: 13px; }
.stage-text :deep(p) { margin: 0; }
.stage-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.stage-facts dt { color: var(--muted); }
.stage-facts dd { margin: 0; min-width: 0; }
.evidence { display: flex; flex-wrap: wrap; gap: 4px 10px; }

.history { font-size: 12.5px; }
.history summary { width: fit-content; cursor: pointer; color: var(--muted); }
.history ol { margin: 8px 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.history li { display: grid; gap: 1px; padding-left: 10px; border-left: 2px solid var(--line); }
.history-what { color: var(--ink-2); }
.error { color: var(--danger); margin: 0; }
</style>
