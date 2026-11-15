<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { del, get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import type { FlowFile } from "../lib/flow";
import RuleTabs from "../components/RuleTabs.vue";
import HelpText from "../components/HelpText.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";

type Reading = { ok: boolean; id?: string; problem?: string; stages?: { id: string; name: string; carrier: string; gate: string; done: string; when: string; needs: string[] }[] };
const template = `# id 用小写字母、数字和连字符；保存后保持不变。
id: my-flow
name: 我的流程
description: 整理材料后由我确认。
stages:
  - id: collect
    name: 整理
    note: 核对事项材料，整理结论并附依据。
    by: { run: {} }
  - id: check
    name: 确认
    # 不填 needs 时，等待上一段完成。
    by: owner
    gate: confirm
`;
const files = ref<FlowFile[]>([]), loading = ref(true), error = ref(""), busy = ref(false);
const editing = ref(false), selected = ref<string | null>(null), raw = ref(""), original = ref(""), reading = ref<Reading | null>(null), validating = ref(false);
let validationSeq = 0, listSeq = 0, timer: ReturnType<typeof setTimeout> | undefined;
const changed = computed(() => raw.value !== original.value);
const valid = computed(() => !validating.value && reading.value?.ok && (!selected.value || reading.value.id === selected.value));
async function load() {
  const request = ++listSeq;
  loading.value = true;
  try { const result = await get<{ flows: FlowFile[] }>("/api/flows"); if (request === listSeq) { files.value = result.flows; error.value = ""; } }
  catch (e) { if (request === listSeq) error.value = (e as Error).message; }
  finally { if (request === listSeq) loading.value = false; }
}
watch(raw, () => {
  clearTimeout(timer);
  const request = ++validationSeq, yaml = raw.value;
  reading.value = null; validating.value = true;
  timer = setTimeout(async () => {
    try { const result = await post<Reading>("/api/flows/validate", { yaml }); if (request === validationSeq) reading.value = result; }
    catch (e) { if (request === validationSeq) reading.value = { ok: false, problem: (e as Error).message }; }
    finally { if (request === validationSeq) validating.value = false; }
  }, 350);
});
const canLeave = () => !changed.value || confirmDialog("放弃未保存的修改", { message: "切换后，这次修改不会保存。", okText: "放弃修改", danger: true });
async function open(file?: FlowFile) {
  if (busy.value || !await canLeave()) return;
  selected.value = file?.id ?? null;
  original.value = file?.raw ?? "";
  raw.value = file?.raw ?? template;
  editing.value = true; error.value = "";
}
async function save() {
  if (!valid.value || !changed.value || busy.value) return;
  const id = reading.value!.id!, yaml = raw.value;
  if (!selected.value && files.value.some((f) => f.id === id)) { error.value = "这个 id 已存在，请换一个 id，或打开原流程修改。"; return; }
  busy.value = true;
  try { await put(`/api/flows/${encodeURIComponent(id)}`, { yaml }); selected.value = id; original.value = yaml; await load(); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function remove() {
  const id = selected.value;
  if (!id || busy.value || !await confirmDialog("删除流程定义", { message: "正在进行的事项保留各自的流程副本。删除后不能再用这份定义开始新流程。", danger: true, okText: "删除" })) return;
  busy.value = true;
  try { await del(`/api/flows/${encodeURIComponent(id)}`); editing.value = false; original.value = raw.value = ""; selected.value = null; await load(); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
onBeforeRouteLeave(() => busy.value ? false : canLeave());
function beforeUnload(e: BeforeUnloadEvent) { if (changed.value) e.preventDefault(); }
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => { ++validationSeq; ++listSeq; clearTimeout(timer); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <div class="page flows">
    <div class="page-head"><h1>流程</h1><span class="spacer" /><button class="btn primary sm" :disabled="busy" @click="open()"><Icon name="plus" :size="15" />新建流程</button></div>
    <RuleTabs />
    <HelpText lead>流程让一件事项按前提逐段推进，遇到需要你拍板的地方停下来。阶段是一张带前提的清单，不用画图；每段可以交给一次运行、编码交办或方案，也可以由你完成，或只等待进展。你可以先向助手描述做法，让它起草。</HelpText>
    <p v-if="error" class="error" role="alert">{{ error }} <button v-if="!editing" class="btn ghost sm" @click="load">重试</button></p>
    <Skeleton v-if="loading" variant="cards" :rows="3" />
    <div v-else class="definition-list">
      <button v-for="f in files" :key="f.id" class="definition card pad stack" :class="{ on: selected === f.id }" :disabled="busy" @click="open(f)">
        <strong>{{ f.definition?.name ?? f.id }}</strong><span v-if="f.definition?.description" class="muted small">{{ f.definition.description }}</span>
        <span class="row wrap"><span v-for="s in f.definition?.stages" :key="s.id" class="badge"><Icon v-if="s.gate === 'confirm'" name="lock" :size="12" aria-label="开始前确认" /><Icon v-if="s.by === 'owner'" name="user" :size="12" aria-label="本人承担" />{{ s.name }}</span></span>
        <span v-if="f.problem" class="error small">{{ f.problem }}</span>
      </button>
      <p v-if="!files.length" class="muted">还没有流程。新建一份，或让助手按你的做法起草。</p>
    </div>
    <section v-if="editing" class="card pad stack editor">
      <div class="row wrap"><h2>{{ selected ? '编辑流程' : '新流程' }}</h2><span class="spacer" /><span class="muted small" role="status">{{ changed ? '有未保存的修改' : '已保存' }}</span><button class="btn primary sm" :disabled="!valid || !changed || busy" @click="save">保存</button><button v-if="selected" class="btn danger sm" :disabled="busy" @click="remove">删除</button></div>
      <div class="panes">
        <label class="field"><span>YAML 原文</span><textarea v-model="raw" class="textarea mono" spellcheck="false" rows="22" :disabled="busy" maxlength="60000" /></label>
        <div class="stack reading" aria-live="polite"><strong>这份流程会怎样推进</strong><Skeleton v-if="validating" variant="text" :rows="4" /><p v-else-if="reading?.problem" class="error">{{ reading.problem }}</p><template v-else-if="reading?.ok"><p v-if="selected && reading.id !== selected" class="error">修改已有流程时，id 要保持为 {{ selected }}。</p><div v-for="s in reading.stages" :key="s.id" class="stage-reading"><p>{{ s.name }}：{{ s.carrier }}；{{ s.gate }}；{{ s.done }}；{{ s.when }}。</p><span class="muted small">{{ s.needs.length ? `等待：${s.needs.map((id) => reading?.stages?.find((n) => n.id === id)?.name ?? id).join('、')}` : '不需要等待其他阶段' }}</span></div></template></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.flows { display: grid; gap: 16px; }.flows > *, .panes > * { min-width: 0; }
.definition-list { display: grid; gap: 8px; }.definition { text-align: left; cursor: pointer; width: 100%; color: var(--ink); font: inherit; }.definition.on { border-color: var(--accent); }
.panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }.panes textarea { width: 100%; font-family: var(--mono); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.reading { align-content: start; }.stage-reading { padding-bottom: 12px; border-bottom: 1px solid var(--line); }.stage-reading p { margin: 0; }
.flows { overflow-wrap: anywhere; }.error { color: var(--danger); }.editor h2 { margin: 0; }
@media (max-width: 760px) { .panes { grid-template-columns: minmax(0, 1fr); } }
</style>
