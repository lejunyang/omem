<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { del, get, post, put, type Run } from "../api";
import RuleConditions, { type Condition } from "../components/RuleConditions.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { state, toast } from "../store";

type Rule = { id?: string; name: string; description: string; target: string; priority: number; enabled: boolean; conditions: Condition | null };
type Preview = { id: string; title: string; hash: string; from: string; target: string; ruleId?: string; ruleVersion?: string; reason: string; conflict: boolean };
const rules = ref<Rule[]>([]);
const form = ref<Rule | null>(null);
const loading = ref(true);
const busy = ref(false);
const drafting = ref(false);
const dirty = ref(false);
const options = ref<{ fields: Record<string, string>; ops: string[] }>({ fields: {}, ops: [] });
const preview = ref<Preview[] | null>(null);
const selected = ref<string[]>([]);
const offset = ref(0);
const batchSize = 100;
const spaceOptions = computed(() => state.spaces.map(s => ({ value: s.id, label: s.name })));
const name = (id: string) => state.spaces.find(s => s.id === id)?.name ?? id;
const touch = () => { dirty.value = true; };
async function load() { rules.value = await get<Rule[]>("/api/archive-rules"); }
onMounted(async () => {
  try { await Promise.all([load(), get<typeof options.value>("/api/archive-options").then(v => { options.value = v; })]); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { loading.value = false; }
});
const leave = async () => !dirty.value || await confirmDialog("放弃未保存的归档规则？", { okText: "放弃修改", danger: true });
onBeforeRouteLeave(leave);
async function edit(rule?: Rule) {
  if (!(await leave())) return;
  form.value = rule ? JSON.parse(JSON.stringify(rule)) : { name: "", description: "", target: state.space, priority: 100, enabled: false, conditions: null };
  dirty.value = false;
}
async function save() {
  if (!form.value) return;
  busy.value = true;
  try {
    const f = form.value;
    if (!f.name.trim()) f.name = f.description.slice(0, 12);
    form.value = f.id ? await put<Rule>(`/api/archive-rules/${f.id}`, f) : await post<Rule>("/api/archive-rules", f);
    dirty.value = false;
    preview.value = null;
    await load();
    toast("归档规则已保存", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
async function remove() {
  if (!form.value?.id || !(await confirmDialog("删除这条归档规则？", { okText: "删除", danger: true }))) return;
  try { await del(`/api/archive-rules/${form.value.id}`); form.value = null; dirty.value = false; preview.value = null; await load(); }
  catch (e) { toast((e as Error).message, "error"); }
}
async function draft() {
  if (!form.value?.description.trim()) return toast("先写材料的归属要求", "error");
  drafting.value = true;
  try {
    const original = form.value;
    const run = await post<Run>("/api/archive-rules/draft", { space: state.space, description: original.description, current: original });
    for (let n = 0; n < 180; n++) {
      await new Promise(r => setTimeout(r, 1000));
      const { run: r } = await get<{ run: Run }>(`/api/runs/${run.id}`);
      if (r.status === "failed" || r.status === "cancelled") throw new Error(r.error ?? "生成未完成");
      if (r.status !== "done") continue;
      const rule = r.output.rule as Rule | undefined;
      if (!rule) throw new Error(String(r.output.summary ?? "未能生成可用规则，请补充具体条件"));
      if (form.value === original) {
        form.value = { ...original, ...rule, id: original.id, enabled: original.enabled };
        dirty.value = true;
      }
      return toast("草稿已生成，核对条件和目标空间后保存", "ok");
    }
    toast("仍在生成，可在运行页查看结果", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { drafting.value = false; }
}
async function previewBatch(next = 0) {
  busy.value = true;
  try {
    preview.value = await post<Preview[]>("/api/archive/preview", { space: state.space, offset: next, limit: batchSize });
    offset.value = next;
    selected.value = preview.value.filter(x => x.ruleId && x.target !== x.from && !x.conflict).map(x => x.id);
  } catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
async function apply() {
  const entries = (preview.value ?? []).filter(x => selected.value.includes(x.id) && x.ruleId && x.target !== x.from && !x.conflict);
  if (!entries.length || !(await confirmDialog(`归档选中的 ${entries.length} 份材料？`, { message: "保留原件 ID、正文和已有引用，并记录每次迁移依据。", okText: "应用归档" }))) return;
  busy.value = true;
  try {
    const results = await post<{ ok: boolean; error?: string }[]>("/api/archive/apply", { space: state.space, entries: entries.map(x => ({ id: x.id, hash: x.hash, ruleId: x.ruleId, ruleVersion: x.ruleVersion, target: x.target })) });
    const failures = results.filter(x => !x.ok);
    toast(`已归档 ${results.length - failures.length} 份${failures.length ? `；${failures.length} 份未迁移：${failures[0].error}` : ""}`, failures.length ? "error" : "ok");
    await previewBatch(0);
  } catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
async function classify() {
  const ids = (preview.value ?? []).filter(x => !x.ruleId && x.reason === "未命中规则，保留当前空间").map(x => x.id);
  if (!ids.length || !(await confirmDialog(`让 AI 判断这 ${ids.length} 份材料的归属？`, { message: "明确属于某个空间时自动迁移，不确定的留在个人空间；不会重新生成记忆或 Wiki。", okText: "判断归属" }))) return;
  busy.value = true;
  try { await post("/api/archive/classify", { space: state.space, ids }); toast("已安排归档，可在运行页查看依据", "ok"); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="page archive-page">
    <header class="row wrap"><h1>归档规则</h1><span class="spacer" /><button class="btn primary" :disabled="drafting" @click="edit()">新建归档规则</button></header>
    <p class="muted">先看手动指定和来源绑定，再按优先级匹配规则；数字越小越先匹配，首条命中即停止。没有命中的交给 AI 判断，不确定的仍放个人空间。</p>
    <div class="archive-grid">
      <aside class="card pad rule-list">
        <Skeleton v-if="loading" :rows="5" />
        <p v-else-if="!rules.length" class="muted">还没有归档规则。可用标题、路径、群或知识库信息指定归属。</p>
        <button v-for="r in rules" :key="r.id" class="rule-row" :class="{ active: form?.id === r.id }" :disabled="drafting" @click="edit(r)">
          <strong>{{ r.name }}</strong><span class="small muted">{{ r.enabled ? '已启用' : '未启用' }} · 优先级 {{ r.priority }} → {{ name(r.target) }}</span>
        </button>
      </aside>
      <section class="card pad">
        <p v-if="!form" class="muted">选择一条规则，或新建规则。</p>
        <form v-else class="editor" @submit.prevent="save">
          <label>规则名称<input v-model="form.name" class="input" maxlength="60" @input="touch" /></label>
          <label>归属要求<textarea v-model="form.description" class="input" rows="3" placeholder="例如：标题包含项目 A 的文档归到项目 A 空间" @input="touch" /></label>
          <div><button class="btn" type="button" :disabled="drafting" @click="draft">{{ drafting ? '正在编写草稿…' : '让 AI 编写条件' }}</button></div>
          <div class="row wrap">
            <label class="target">归到空间<UiSelect v-model="form.target" :options="spaceOptions" aria-label="目标空间" @change="touch" /></label>
            <label>优先级<input v-model.number="form.priority" class="input priority" type="number" min="0" max="10000" @input="touch" /></label>
            <UiCheckbox v-model="form.enabled" @change="touch">启用</UiCheckbox>
          </div>
          <h3>满足什么条件</h3>
          <RuleConditions v-model="form.conditions" :fields="options.fields" :ops="options.ops" @update:model-value="touch" />
          <div class="row wrap"><button class="btn primary" :disabled="busy || drafting || !form.conditions">保存规则</button><button v-if="form.id" type="button" class="btn danger" :disabled="busy || drafting" @click="remove">删除</button><span class="small muted">规则对所有自动采集材料生效；保存不会搬动历史原件。</span></div>
        </form>
      </section>
    </div>
    <section class="card pad history">
      <div class="row wrap"><h2>整理已有材料</h2><span class="spacer" /><button class="btn" :disabled="busy" @click="previewBatch(0)">预览当前空间</button></div>
      <p class="muted small">查看「{{ name(state.space) }}」中已有材料的归档依据。每批最多 100 份；同地址冲突会跳过。</p>
      <template v-if="preview">
        <p v-if="!preview.length" class="muted">这一批没有可归档材料。</p>
        <div v-for="p in preview" :key="p.id" class="preview-row">
          <UiCheckbox v-model="selected" :value="p.id" :disabled="!p.ruleId || p.conflict || p.from === p.target" :aria-label="`选择${p.title}`" />
          <div><router-link :to="`/sources/${p.id}`">{{ p.title }}</router-link><p class="small muted">{{ p.reason }}<span v-if="p.conflict" class="err"> · 目标空间已有同地址原件</span></p></div>
          <span class="small">{{ name(p.from) }} → {{ name(p.target) }}</span>
        </div>
        <div class="row wrap actions"><button class="btn primary" :disabled="busy || !selected.length" @click="apply">应用选中项（{{ selected.length }}）</button><button class="btn" :disabled="busy" @click="classify">未命中的让 AI 判断</button><span class="spacer" /><button class="btn" :disabled="busy || offset === 0" @click="previewBatch(Math.max(0, offset - batchSize))">上一批</button><button class="btn" :disabled="busy || preview.length < batchSize" @click="previewBatch(offset + batchSize)">下一批</button></div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.archive-page { max-width: 1280px; }
.archive-grid { display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 18px; margin: 20px 0; }
.archive-grid > *, .preview-row > * { min-width: 0; }
.rule-list { max-height: 600px; overflow-y: auto; }
.rule-row { display: flex; flex-direction: column; gap: 6px; text-align: left; width: 100%; padding: 12px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; overflow-wrap: anywhere; }
.rule-row.active { background: var(--sunken); }
.editor { display: grid; gap: 16px; }
.editor label:not(.ui-check) { display: grid; gap: 6px; }
.target { flex: 1; min-width: 180px; }
.priority { width: 100px; }
.preview-row { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(100px, 220px); gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.preview-row p { margin: 5px 0 0; }
.actions { margin-top: 16px; }
@media (max-width: 760px) { .archive-grid { grid-template-columns: 1fr; } .rule-list { max-height: 240px; } .preview-row { grid-template-columns: auto minmax(0, 1fr); } .preview-row > span { grid-column: 2; } }
</style>
