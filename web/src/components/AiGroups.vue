<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { put } from "../api";
import { aiText, BUILTIN_GROUPS, type AiGroup, type GroupItem, type PolicyView } from "../lib/ai-policy";
import { promptDialog } from "../lib/dialog";
import type { Probe } from "../lib/probes";
import { toast } from "../store";
import AiPickRow from "./AiPickRow.vue";
import Icon from "./Icon.vue";
import SetCard from "./SetCard.vue";

/**
 * 设置 → 后端与模型 → 规则, the AI groups: named lists of AIs in order (强 / 标准 / 省 are built in and
 * stay), each entry a backend · model · effort, optionally only within some hours and with a sentence
 * on what it is for. Rules, flow stages, profiles and `/组名` name them. Saved as a whole (PUT
 * /api/ai/groups). The first save takes in the old tiers and routing candidates, which until then are
 * kept apart and shown here as what the groups stand for (`initial`).
 */
type Backend = { id: string; name?: string; installed: boolean; transport?: string; model?: string; effort?: string; canProbe?: boolean; probe?: Probe | null; networkReason?: string | null };
const props = defineProps<{ view: PolicyView; initial: AiGroup[]; oldSettings: boolean; backends: Backend[] }>();
const emit = defineEmits<{ saved: [] }>();

const clone = (g: AiGroup[]): AiGroup[] => JSON.parse(JSON.stringify(g));
const draft = ref<AiGroup[]>(clone(props.initial));
watch(() => JSON.stringify(props.initial), () => (draft.value = clone(props.initial)));
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.initial));
const open = ref<string | null>(null);
const toggle = (id: string) => (open.value = open.value === id ? null : id);

/** Which categories' rules name a group: a group in use is not deleted. */
const usedBy = (id: string) => Object.entries(props.view.policy.classes).filter(([, r]) => r?.use.includes(id)).map(([c]) => props.view.classes[c]?.name ?? c);
const summary = (g: AiGroup) => g.items.length ? `${aiText(g.items[0], props.view.backends)}${g.items.length > 1 ? ` 等 ${g.items.length} 个` : ""}` : "还是空的";
const HOURS = /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/;
const badHours = (i: GroupItem) => !!i.hours && !HOURS.test(i.hours);
const problem = computed(() => {
  for (const g of draft.value) {
    if (!g.name.trim()) return "每个组都要有名字";
    if (g.items.some((i) => !i.profile)) return `“${g.name}”里有一项没选后端`;
    if (g.items.some(badHours)) return `“${g.name}”里的时段要写成 20:00-09:00 这样`;
  }
  const names = draft.value.map((g) => g.name.trim().toLowerCase());
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  return twice ? `有两个组都叫“${twice}”` : "";
});

function setItem(g: AiGroup, i: number, patch: Partial<GroupItem>) {
  const next = { ...g.items[i], ...patch };
  for (const k of ["model", "effort", "hours", "note"] as const) if (!next[k]) delete next[k];
  g.items[i] = next;
}
function pickOf(i: GroupItem) {
  return { profile: i.profile, ...(i.model ? { model: i.model } : {}), ...(i.effort ? { effort: i.effort } : {}) };
}
function moveItem(g: AiGroup, i: number) {
  [g.items[i - 1], g.items[i]] = [g.items[i], g.items[i - 1]];
}
function addItem(g: AiGroup) {
  const used = new Set(g.items.map((i) => i.profile));
  const next = props.backends.find((b) => b.installed && !used.has(b.id)) ?? props.backends.find((b) => b.installed);
  g.items.push({ profile: next?.id ?? "" });
}
function moveGroup(i: number, by: -1 | 1) {
  const list = draft.value;
  [list[i], list[i + by]] = [list[i + by], list[i]];
  void nextTick(() => document.getElementById(`grp-${list[i + by].id}-${by < 0 ? "up" : "down"}`)?.focus());
}
/** A new group's id (what flows and rules store): its name when that is one, else group-N. */
function newId(name: string) {
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (/^[a-z0-9][a-z0-9_-]*$/.test(slug) && !draft.value.some((g) => g.id === slug)) return slug;
  for (let n = draft.value.length; ; n++) if (!draft.value.some((g) => g.id === `group-${n}`)) return `group-${n}`;
}
async function addGroup() {
  const name = (await promptDialog("新建 AI 组", { placeholder: "如 写作、跟进", message: "组名也是命令：在对话里发 /组名 就换到这一组。" }))?.trim();
  if (!name) return;
  const id = newId(name);
  draft.value.push({ id, name, items: [] });
  open.value = id;
  addItem(draft.value[draft.value.length - 1]);
}
function removeGroup(i: number) {
  const g = draft.value[i];
  draft.value.splice(i, 1);
  if (open.value === g.id) open.value = null;
}

const saving = ref(false);
const error = ref("");
async function save() {
  if (problem.value) return (error.value = problem.value);
  saving.value = true;
  error.value = "";
  try {
    await put("/api/ai/groups", draft.value.map((g) => ({ ...g, name: g.name.trim(), items: g.items.map((i) => ({ ...i, ...(i.note ? { note: i.note.trim() } : {}) })) })));
    toast(props.oldSettings ? "已保存 AI 组；原来的档位和候选已合并进来" : "已保存 AI 组", "ok");
    emit("saved");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
function discard() {
  draft.value = clone(props.initial);
  error.value = "";
}
</script>

<template>
  <SetCard id="set-ai-groups" title="AI 组" :keys="['agents']">
    <template #help>一组 AI 按先后排好，用的时候取第一个现在能用的（不在时段、满了、额度快用完的往后放）。规则、流程阶段、Agent 档案都能写组名，对话里发 /组名 就换到这一组。</template>
    <template #aside><button class="btn ghost sm" @click="addGroup"><Icon name="plus" :size="14" />组</button></template>

    <p v-if="oldSettings" class="grp-notice small">原来“通用”里的强 / 标准 / 省三档和任务选型的候选已经填进下面的组（候选在“候选”组，适用说明在每一项的说明里）。第一次保存后以这里为准，原来那两处不再单独保存。</p>

    <div v-for="(g, gi) in draft" :id="`grp-${g.id}`" :key="g.id" class="grp" :class="{ open: open === g.id }">
      <div class="grp-row">
        <button type="button" class="grp-main" :aria-expanded="open === g.id" @click="toggle(g.id)">
          <span class="grp-title">
            <span class="grp-name">{{ g.name || "（没有名字）" }}</span>
            <span v-if="BUILTIN_GROUPS[g.id]" class="badge">内置</span>
            <span v-if="g.id === 'candidates'" class="badge">自动选 AI 时的候选</span>
          </span>
          <span class="grp-meta" :title="g.items.map((i) => aiText(i, view.backends)).join('\n')">{{ summary(g) }}<template v-if="usedBy(g.id).length"> · 用在{{ usedBy(g.id).join("、") }}</template></span>
        </button>
        <span class="grp-tools">
          <button :id="`grp-${g.id}-up`" class="btn ghost sm icon move" :disabled="gi === 0" :aria-label="`上移 ${g.name}`" title="上移" @click="moveGroup(gi, -1)"><Icon name="down" :size="14" class="up" /></button>
          <button :id="`grp-${g.id}-down`" class="btn ghost sm icon move" :disabled="gi === draft.length - 1" :aria-label="`下移 ${g.name}`" title="下移" @click="moveGroup(gi, 1)"><Icon name="down" :size="14" /></button>
          <button class="btn ghost sm icon chev" :aria-label="open === g.id ? '收起' : '展开'" :aria-expanded="open === g.id" @click="toggle(g.id)"><Icon name="right" :size="14" /></button>
        </span>
      </div>

      <div v-if="open === g.id" class="grp-body">
        <label class="field grp-name-field"><span>名字</span><input v-model="g.name" class="input sm" maxlength="40" :aria-label="`${g.name} 的名字`" /></label>
        <p v-if="g.id === 'candidates'" class="small muted">运行前自动选 AI 时从这一组挑，每一项的说明就是它适合做什么。</p>
        <ol v-if="g.items.length" class="items">
          <li v-for="(it, i) in g.items" :key="i" class="item">
            <span class="item-n">{{ i + 1 }}</span>
            <div class="item-main">
              <AiPickRow :model-value="pickOf(it)" :backends="backends" :policy="view.backends" :label="`${g.name} 的第 ${i + 1} 项`" @update:model-value="(v) => setItem(g, i, { profile: v.profile, model: v.model, effort: v.effort })" />
              <div class="item-more">
                <input class="input sm hours mono" :class="{ bad: badHours(it) }" :value="it.hours ?? ''" placeholder="时段，如 20:00-09:00" :aria-label="`第 ${i + 1} 项只在这个时段用`" @change="setItem(g, i, { hours: ($event.target as HTMLInputElement).value.trim() || undefined })" />
                <input class="input sm note" :value="it.note ?? ''" maxlength="2000" :placeholder="g.id === 'candidates' ? '适合做什么' : '一句说明（可不写）'" :aria-label="`第 ${i + 1} 项的说明`" @change="setItem(g, i, { note: ($event.target as HTMLInputElement).value.trim() || undefined })" />
              </div>
            </div>
            <span class="item-tools">
              <button class="btn ghost sm icon" :disabled="i === 0" :aria-label="`上移第 ${i + 1} 项`" title="上移" @click="moveItem(g, i)"><Icon name="down" :size="14" class="up" /></button>
              <button class="btn ghost sm icon" :aria-label="`去掉第 ${i + 1} 项`" title="去掉" @click="g.items.splice(i, 1)"><Icon name="x" :size="14" /></button>
            </span>
          </li>
        </ol>
        <p v-else class="small muted">{{ BUILTIN_GROUPS[g.id] ? "空着时，用到这一组的流程阶段按那个角色自己的 AI。" : "还没有 AI。" }}</p>
        <div class="grp-foot">
          <button class="btn ghost sm" @click="addItem(g)"><Icon name="plus" :size="13" />加一个 AI</button>
          <span class="grow" />
          <button v-if="!BUILTIN_GROUPS[g.id]" class="btn ghost sm danger" :disabled="!!usedBy(g.id).length" :title="usedBy(g.id).length ? `${usedBy(g.id).join('、')}的规则还用着它` : undefined" @click="removeGroup(gi)">删除这一组</button>
        </div>
      </div>
    </div>

    <div v-if="dirty || error" class="grp-save">
      <span class="grow small" :class="{ 'warn-text': error }" :role="error ? 'alert' : undefined">{{ error ? `没保存：${error}` : oldSettings ? "改动还没保存 · 保存后原来的档位和候选并进这里" : "改动还没保存" }}</span>
      <button class="btn ghost sm" :disabled="saving" @click="discard">放弃</button>
      <button class="btn primary sm" :disabled="saving || !dirty" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
    </div>
  </SetCard>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
.grp-notice {
  margin: 0;
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--sunken);
  color: var(--ink-2);
}
.grp {
  border-top: 1px solid var(--line);
  min-width: 0;
}
.grp-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 6px 12px 6px 18px;
  min-width: 0;
}
.grp-main {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.grp-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
}
.grp-name {
  font-size: 14px;
  color: var(--ink);
}
.grp-meta {
  font-size: 13px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grp-tools {
  display: flex;
  align-items: center;
  gap: 2px;
}
.grp-tools .move {
  color: var(--muted);
}
@media (hover: hover) {
  .grp:not(.open):not(:hover):not(:focus-within) .move {
    visibility: hidden;
  }
}
.up {
  transform: rotate(180deg);
}
.chev :deep(svg) {
  transition: transform 0.15s ease;
}
.grp.open .chev :deep(svg) {
  transform: rotate(90deg);
}
.grp-body {
  display: grid;
  gap: 12px;
  padding: 4px 18px 16px;
  min-width: 0;
}
.grp-name-field {
  display: grid;
  gap: 6px;
  max-width: 240px;
}
.grp-name-field > span {
  font-size: 13px;
  color: var(--ink-2);
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  min-width: 0;
}
.item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--line);
  min-width: 0;
}
.item-n {
  padding-top: 6px;
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}
.item-main {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.item-more {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
}
.item-more .input {
  min-width: 0;
  width: 100%;
}
.hours.bad {
  border-color: var(--danger);
}
.item-tools {
  display: flex;
  gap: 2px;
}
.grp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.grp-save {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--panel);
  border-radius: 0 0 var(--radius) var(--radius);
  color: var(--ink-2);
}
@media (max-width: 640px) {
  .grp-row {
    padding: 6px 8px 6px 14px;
  }
  .grp:not(.open) .move {
    display: none;
  }
  .grp-body,
  .grp-notice {
    padding-left: 14px;
    padding-right: 14px;
  }
  .item-more {
    grid-template-columns: minmax(0, 1fr);
  }
  .grp-save {
    flex-wrap: wrap;
  }
}
</style>
