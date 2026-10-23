<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { del, get, post, put, type Run } from "../api";
import RuleConditions, { type Condition } from "../components/RuleConditions.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { state, toast } from "../store";

type Rule = { id?: string; name: string; description: string; target: string; enabled: boolean; conditions: Condition | null };
type Preview = { id: string; title: string; hash: string; from: string; target: string; ruleId?: string; ruleVersion?: string; reason: string; conflict: boolean };
const rules = ref<Rule[]>([]);
const form = ref<Rule | null>(null);
const loading = ref(true);
const busy = ref(false);
const drafting = ref(false);
const dirty = ref(false);
const organizing = ref(false);
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
  organizing.value = false;
  form.value = rule ? JSON.parse(JSON.stringify(rule)) : { name: "", description: "", target: state.space, enabled: false, conditions: null };
  dirty.value = false;
}
async function organize() {
  if (!(await leave())) return;
  form.value = null; dirty.value = false; organizing.value = true;
  if (!preview.value) await previewBatch(0);
}
async function toggle(r: Rule) {
  try {
    await put(`/api/archive-rules/${r.id}`, { ...r, enabled: !r.enabled });
    await load(); preview.value = null;
    if (form.value?.id === r.id && !dirty.value) form.value = { ...r, enabled: !r.enabled };
  } catch (e) { toast((e as Error).message, "error"); }
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
  <div class="rules">
    <aside class="list-col">
      <div class="head row">
        <strong>归档规则</strong><span class="muted small">{{ rules.length || '' }}</span><span class="spacer" />
        <button class="btn ghost sm icon" title="整理已有材料" aria-label="整理已有材料" :class="{ active: organizing }" :disabled="drafting" @click="organize"><Icon name="folder" :size="15" /></button>
        <button class="btn ghost sm icon" title="新建归档规则" aria-label="新建归档规则" :disabled="drafting" @click="edit()"><Icon name="plus" :size="15" /></button>
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="5" />
        <div v-for="r in rules" v-else :key="r.id" class="li" :class="{ on: form?.id === r.id }">
          <button class="grow pick" :disabled="drafting" @click="edit(r)">
            <strong class="ellipsis">{{ r.name }}</strong><div class="muted small clamp">{{ r.description }}</div><div class="muted small">归到 {{ name(r.target) }}</div>
          </button>
          <UiCheckbox :model-value="r.enabled" switch size="sm" :aria-label="`启用 ${r.name}`" @change="toggle(r)" />
        </div>
        <p v-if="!loading && !rules.length" class="muted small hint">还没有归档规则。点 ＋ 新建，按标题、正文或来源信息指定材料归属。</p>
      </div>
    </aside>
    <main class="detail">
    <section v-if="organizing" class="page history">
      <div class="row wrap"><h2>整理已有材料</h2><span class="spacer" /><button class="btn" :disabled="busy" @click="previewBatch(0)">预览当前空间</button></div>
      <p class="muted small">查看「{{ name(state.space) }}」中已有材料的归档依据。每批最多 100 份；同地址冲突会跳过。</p>
      <Skeleton v-if="busy && !preview" :rows="6" />
      <template v-else-if="preview">
        <p v-if="!preview.length" class="muted">这一批没有可归档材料。</p>
        <div v-for="p in preview" :key="p.id" class="preview-row">
          <UiCheckbox v-model="selected" :value="p.id" :disabled="!p.ruleId || p.conflict || p.from === p.target" :aria-label="`选择${p.title}`" />
          <div><router-link :to="`/sources/${p.id}`">{{ p.title }}</router-link><p class="small muted">{{ p.reason }}<span v-if="p.conflict" class="err"> · 目标空间已有同地址原件</span></p></div>
          <span class="small">{{ name(p.from) }} → {{ name(p.target) }}</span>
        </div>
        <div class="row wrap actions"><button class="btn primary" :disabled="busy || !selected.length" @click="apply">应用选中项（{{ selected.length }}）</button><button class="btn" :disabled="busy" @click="classify">未命中的让 AI 判断</button><span class="spacer" /><button class="btn" :disabled="busy || offset === 0" @click="previewBatch(Math.max(0, offset - batchSize))">上一批</button><button class="btn" :disabled="busy || preview.length < batchSize" @click="previewBatch(offset + batchSize)">下一批</button></div>
      </template>
    </section>
      <div v-else-if="!form" class="empty">
        <Icon name="folder" :size="34" /><h3>归档规则</h3>
        <p>让同类材料进入同一个空间。先看手动指定和来源绑定，再按列表顺序匹配启用的规则；未命中的交给 AI 判断，不确定的留在个人空间。</p>
        <button class="btn" @click="edit()"><Icon name="plus" :size="14" />新建归档规则</button>
      </div>
      <form v-else class="page" @submit.prevent="save">
        <header class="dh row">
          <input v-model="form.name" class="input title" placeholder="规则名" aria-label="规则名称" maxlength="60" @input="touch" />
          <UiCheckbox v-model="form.enabled" switch aria-label="启用规则" @change="touch">启用</UiCheckbox>
          <button class="btn sm primary" :disabled="busy || drafting || !form.conditions || (!!form.id && !dirty)">保存</button>
          <button v-if="form.id" type="button" class="btn ghost sm icon danger" title="删除" aria-label="删除规则" :disabled="busy || drafting" @click="remove"><Icon name="trash" :size="14" /></button>
        </header>
        <section class="block">
          <div class="block-head"><h3>归档规则原话</h3><span class="muted small">说清楚什么材料归到哪个空间</span></div>
          <textarea v-model="form.description" class="input" aria-label="归属要求" rows="3" placeholder="例如：标题包含项目 A 的文档归到项目 A 空间" @input="touch" />
          <div class="row"><button class="btn sm" type="button" :disabled="drafting" @click="draft"><Icon name="sparkles" :size="13" />{{ drafting ? '正在编写草稿…' : '让 AI 编写条件' }}</button></div>
        </section>
        <section class="block">
          <div class="block-head"><h3>满足什么条件</h3></div>
          <RuleConditions v-model="form.conditions" :fields="options.fields" :ops="options.ops" @update:model-value="touch" />
        </section>
        <section class="block">
          <div class="block-head"><h3>归到哪个空间</h3></div>
          <UiSelect v-model="form.target" :options="spaceOptions" aria-label="目标空间" @change="touch" />
          <small class="muted">启用后对新采集的材料生效。历史材料从左侧顶部的“整理已有材料”进入，预览后应用。</small>
        </section>
      </form>
    </main>
  </div>
</template>

<style scoped>
.rules {
  display: flex;
  height: 100%;
}
.list-col {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  gap: 8px;
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
}
.hint {
  padding: 6px 10px;
}
.li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
}
.li:hover {
  background: var(--hover);
}
.li.on {
  background: var(--accent-soft);
}
.pick {
  border: 0;
  background: none;
  text-align: left;
  color: var(--ink);
  cursor: pointer;
  padding: 0;
  min-width: 0;
  font: inherit;
}
.grow {
  flex: 1;
  min-width: 0;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.page {
  max-width: 880px;
  padding: 16px 24px 40px;
  display: grid;
  gap: 14px;
}
.dh {
  gap: 10px;
  flex-wrap: wrap;
}
.title {
  flex: 1;
  min-width: 160px;
  font-size: 16px;
  font-weight: 600;
}
.block {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.block-head h3 {
  margin: 0;
  font-size: 14px;
}
.wrap {
  flex-wrap: wrap;
  gap: 8px;
}
.err {
  color: var(--danger);
}
.empty {
  max-width: 620px;
  margin: 50px auto;
  text-align: center;
  color: var(--ink-2);
  padding: 0 16px;
  display: grid;
  gap: 10px;
  justify-items: center;
}
@media (max-width: 760px) {
  .rules {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 36vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .page {
    padding: 12px 16px 32px;
  }
}

.history h2 { margin: 0; }
.active { color: var(--accent); background: var(--accent-soft); }
.preview-row { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(100px, 180px); gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.preview-row > * { min-width: 0; }
.preview-row p { margin: 5px 0 0; }
.actions { margin-top: 12px; }
@media (max-width: 760px) { .preview-row { grid-template-columns: auto minmax(0, 1fr); } .preview-row > span { grid-column: 2; } }
</style>
