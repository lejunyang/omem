<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { put } from "../api";
import { aiText, defaultOrder, parseAi, refText, scopeReason, selectorText, type AiGroup, type ClassRule, type Policy, type PolicyView } from "../lib/ai-policy";
import type { Probe } from "../lib/probes";
import { fmtTime, toast } from "../store";
import AiDenyPicker from "./AiDenyPicker.vue";
import AiUseList from "./AiUseList.vue";
import Icon from "./Icon.vue";
import SetCard from "./SetCard.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 设置 → 后端与模型 → 规则, the categories: one compact line per kind of run (what it may use, what it
 * never uses, how it picks), opened to edit. The whole rule set is saved at once (PUT /api/ai/policy);
 * the server's refusal is shown as it said it. Roles of a category whose own default AI the rule leaves
 * out are pointed at: those runs skip it.
 */
type Backend = { id: string; name?: string; installed: boolean; transport?: string; model?: string; effort?: string; canProbe?: boolean; probe?: Probe | null };
const props = defineProps<{ view: PolicyView; groups: AiGroup[]; backends: Backend[]; agents: { default?: string; roles?: Record<string, string>; roleModels?: Record<string, Record<string, { model?: string; effort?: string }>> } }>();
const emit = defineEmits<{ saved: [] }>();

const clone = (p: Policy): Policy => JSON.parse(JSON.stringify({ deny: p?.deny ?? [], classes: p?.classes ?? {} }));
const draft = ref<Policy>(clone(props.view.policy));
watch(() => JSON.stringify(props.view.policy), () => (draft.value = clone(props.view.policy)));
const ids = computed(() => Object.keys(props.view.classes));
const blank = (id: string): ClassRule => ({ use: [], deny: [], order: props.view.classes[id]?.order ?? defaultOrder(id), strict: false, said: [] });
const ruleOf = (id: string): ClassRule => draft.value.classes[id] ?? blank(id);
/** A rule back to how a category is without one is taken out: an empty entry still changes how runs pick. */
function update(id: string, patch: Partial<ClassRule>) {
  const next = { ...ruleOf(id), ...patch };
  if (!next.use.length) next.strict = false;
  const plain = !next.use.length && !next.deny.length && !next.strict && next.order === defaultOrder(id);
  const classes = { ...draft.value.classes };
  if (plain) delete classes[id];
  else classes[id] = next;
  draft.value = { ...draft.value, classes };
}
const shape = (p: Policy) => JSON.stringify([p.deny, Object.fromEntries(Object.entries(p.classes).sort(([a], [b]) => a.localeCompare(b)))]);
const dirty = computed(() => shape(draft.value) !== shape(clone(props.view.policy)));

const open = ref<string | null>(null);
const denyFor = ref<string | null>(null);
function toggle(id: string) {
  open.value = open.value === id ? null : id;
  denyFor.value = null;
}

const name = (id: string) => props.view.classes[id]?.name ?? id;
const backendsUsed = computed(() => props.view.backends);
const scopeOf = (id: string) => {
  const r = ruleOf(id);
  return { name: name(id), use: r.use, deny: [...draft.value.deny.map((selector) => ({ selector, rule: "所有类别都" })), ...r.deny.map((selector) => ({ selector, rule: name(id) }))] };
};
const refs = (r: string) => refText(r, props.groups, backendsUsed.value);
const denyText = (sel: string) => selectorText(sel, backendsUsed.value);
function summaryOf(id: string) {
  const r = ruleOf(id);
  const scope = r.use.length ? r.use.map(refs).join(" → ") : "全部 AI";
  const deny = r.deny.length ? `不用 ${r.deny.slice(0, 2).map(denyText).join("、")}${r.deny.length > 2 ? ` 等 ${r.deny.length} 项` : ""}` : "";
  return { scope, deny, full: [scope, r.deny.length ? `不用 ${r.deny.map(denyText).join("、")}` : ""].filter(Boolean).join("；") };
}
const usageOf = (id: string) => props.view.usage.filter((u) => u.class === id).sort((a, b) => b.count - a.count);
const totalOf = (id: string) => usageOf(id).reduce((s, u) => s + u.count, 0);
const outOf = (id: string, p: { profile: string; model?: string; effort?: string }) => scopeReason(p, scopeOf(id), props.groups, backendsUsed.value, props.backends);
/** A single AI the category may use that one of its own exclusions (or the global one) also names. */
function useMarks(id: string) {
  const scope = { ...scopeOf(id), use: [] };
  return Object.fromEntries(ruleOf(id).use.filter((r) => r.startsWith("ai:")).flatMap((r) => {
    const why = scopeReason(parseAi(r.slice(3)), scope, props.groups, backendsUsed.value, props.backends);
    return why ? [[r, `${why}，这一项不会用到`]] : [];
  }));
}

/** The roles of a category whose own default the rule leaves out, and the shared default when it is. */
function conflictsOf(id: string) {
  const roles = props.view.classes[id]?.roles ?? [];
  const fallback = props.agents.default || props.backends.find((b) => b.installed)?.id || "";
  const own: { role?: string; text: string; warn: boolean }[] = [];
  let following = 0;
  let followReason = "";
  for (const role of roles) {
    const explicit = props.agents.roles?.[role];
    const profile = explicit || fallback;
    if (!profile) continue;
    const pick = { profile, ...(props.agents.roleModels?.[role]?.[profile] ?? {}) };
    const why = outOf(id, pick);
    if (!why) continue;
    if (explicit) own.push({ role, text: `${role} 平时用 ${aiText(pick, backendsUsed.value)}：${why}，运行时跳过它`, warn: true });
    else { following++; followReason = why; }
  }
  // Roles that only follow the default Agent start from the rule's range: expected, said without alarm.
  if (following) own.push({ text: `${following} 个跟随默认 Agent（${aiText({ profile: fallback }, backendsUsed.value)}）的角色：${followReason}，从范围里的开始`, warn: false });
  return own;
}
const warnsOf = (id: string) => conflictsOf(id).filter((c) => c.warn);

function addDeny(where: string, sel: string) {
  if (where === "*") draft.value = { ...draft.value, deny: [...draft.value.deny, sel] };
  else update(where, { deny: [...ruleOf(where).deny, sel] });
}
function removeDeny(where: string, sel: string) {
  if (where === "*") draft.value = { ...draft.value, deny: draft.value.deny.filter((s) => s !== sel) };
  else update(where, { deny: ruleOf(where).deny.filter((s) => s !== sel) });
}

const saving = ref(false);
const error = ref("");
async function save() {
  saving.value = true;
  error.value = "";
  try {
    await put("/api/ai/policy", draft.value);
    toast("已保存 AI 规则", "ok");
    emit("saved");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
function discard() {
  draft.value = clone(props.view.policy);
  error.value = "";
}
const ORDER = [{ value: "choose" as const, label: "自动挑" }, { value: "fixed" as const, label: "按先后" }];
async function focusRow(id: string) {
  await nextTick();
  document.getElementById(`cls-${id}`)?.scrollIntoView({ block: "nearest" });
}
defineExpose({ focusRow });
</script>

<template>
  <SetCard id="set-ai-rules" title="任务类别" :keys="['agents']">
    <template #help>每次运行属于一类，按运行的种类和角色定。点开一类，选它能用哪些组或 AI、哪些不用、怎么排先后；对话里本人点名用的 AI 不受限制。</template>

    <div class="cls-global">
      <div class="cls-global-head">
        <span class="cls-global-label">所有类别都不用</span>
        <span v-for="s in draft.deny" :key="s" class="deny-chip" :title="`不用 ${denyText(s)}`">{{ denyText(s) }}<button type="button" class="deny-x" :aria-label="`不再排除 ${denyText(s)}`" @click="removeDeny('*', s)">×</button></span>
        <span v-if="!draft.deny.length && denyFor !== '*'" class="small muted">没有</span>
        <button v-if="denyFor !== '*'" class="btn ghost sm" @click="denyFor = '*'"><Icon name="plus" :size="13" />排除</button>
      </div>
      <AiDenyPicker v-if="denyFor === '*'" :policy="backendsUsed" :backends="backends" :taken="draft.deny" @add="(s) => addDeny('*', s)" @close="denyFor = null" />
    </div>

    <div v-for="id in ids" :id="`cls-${id}`" :key="id" class="cls" :class="{ open: open === id }">
      <button type="button" class="cls-row" :aria-expanded="open === id" @click="toggle(id)">
        <span class="cls-main">
          <span class="cls-title">
            <span class="cls-name">{{ name(id) }}</span>
            <span v-if="ruleOf(id).strict" class="badge">只用这些</span>
            <span v-if="warnsOf(id).length" class="badge warn" :title="warnsOf(id).map((c) => c.text).join('\n')">角色默认 AI 被排除</span>
          </span>
          <span class="cls-meta" :title="summaryOf(id).full">{{ summaryOf(id).scope }}<template v-if="summaryOf(id).deny"> · {{ summaryOf(id).deny }}</template></span>
        </span>
        <span class="cls-end">
          <span class="cls-order">{{ ruleOf(id).order === "fixed" ? "按先后" : "自动挑" }}</span>
          <span v-if="totalOf(id)" class="cls-count">近 7 天 {{ totalOf(id) }} 次</span>
        </span>
        <Icon name="right" :size="14" class="chev" />
      </button>

      <div v-if="open === id" class="cls-body">
        <p class="small muted">{{ view.classes[id].description }}</p>
        <div class="field">
          <span>能用的（按先后）</span>
          <AiUseList :model-value="ruleOf(id).use" :groups="groups" :policy="backendsUsed" :backends="backends" :marks="useMarks(id)" @update:model-value="(use) => update(id, { use })" />
        </div>
        <div class="field">
          <span>不用的</span>
          <div class="deny-list">
            <span v-for="s in ruleOf(id).deny" :key="s" class="deny-chip" :title="`不用 ${denyText(s)}`">{{ denyText(s) }}<button type="button" class="deny-x" :aria-label="`不再排除 ${denyText(s)}`" @click="removeDeny(id, s)">×</button></span>
            <span v-if="!ruleOf(id).deny.length && denyFor !== id" class="small muted">没有</span>
            <button v-if="denyFor !== id" class="btn ghost sm" @click="denyFor = id"><Icon name="plus" :size="13" />排除</button>
          </div>
          <AiDenyPicker v-if="denyFor === id" :policy="backendsUsed" :backends="backends" :taken="ruleOf(id).deny" @add="(s) => addDeny(id, s)" @close="denyFor = null" />
        </div>
        <div class="cls-grid">
          <div class="field">
            <span>先后</span>
            <UiSegmented :model-value="ruleOf(id).order" size="sm" aria-label="先后方式" :options="ORDER" @update:model-value="(order) => update(id, { order })" />
            <span class="hint">{{ ruleOf(id).order === "fixed" ? "按上面的先后，取第一个现在能用的" : "范围里有两个以上的组时，让决策模型挑组；拿不准就按先后" }}</span>
          </div>
          <div class="field">
            <span>用不了时</span>
            <UiCheckbox :model-value="ruleOf(id).strict" switch :disabled="!ruleOf(id).use.length" @update:model-value="(v) => update(id, { strict: v === true })">只用这些</UiCheckbox>
            <span class="hint">{{ ruleOf(id).use.length ? (ruleOf(id).strict ? "只在上面这些里换，都用不了就排队等，不换到别处" : "都用不了时照常换到兜底的后端") : "先选能用的组或 AI" }}</span>
          </div>
        </div>
        <div v-if="conflictsOf(id).length" class="field">
          <span>和角色的默认 AI</span>
          <p v-for="c in conflictsOf(id)" :key="c.text" class="small" :class="c.warn ? 'warn-text' : 'muted'">{{ c.text }}<template v-if="c.role">。<RouterLink :to="{ path: '/agents', query: { tab: 'agents', role: c.role } }">改它的默认 AI</RouterLink></template></p>
        </div>
        <div v-if="ruleOf(id).said.length" class="field">
          <span>这条规则从哪来</span>
          <p v-for="s in ruleOf(id).said" :key="s.at + s.text" class="small said">“{{ s.text }}”<span class="muted"> · {{ fmtTime(s.at) }}</span></p>
        </div>
        <div class="field">
          <span>近 7 天用了</span>
          <div v-if="usageOf(id).length" class="usage">
            <template v-for="u in usageOf(id)" :key="`${u.profile}|${u.model}|${u.effort}`">
              <span class="usage-ai" :title="aiText(u, backendsUsed)">{{ aiText(u, backendsUsed) }}</span>
              <span class="usage-n">{{ u.count }} 次<span v-if="outOf(id, u)" class="warn-text">，按这条规则会换掉</span></span>
            </template>
          </div>
          <p v-else class="small muted">近 7 天没有这一类的运行。</p>
        </div>
        <details class="kinds">
          <summary class="small muted">包括 {{ view.classes[id].kinds.length }} 种运行、{{ view.classes[id].roles.length }} 个角色</summary>
          <div class="kinds-body">
            <span class="small muted">运行</span>
            <span class="kind-list"><code v-for="k in view.classes[id].kinds" :key="k">{{ k }}</code></span>
            <template v-if="view.classes[id].roles.length">
              <span class="small muted">角色</span>
              <span class="kind-list"><code v-for="r in view.classes[id].roles" :key="r">{{ r }}</code></span>
            </template>
            <span v-if="id === 'agents'" class="small muted kinds-note">Agent 档案在档案里写 <code>class</code> 可以归到别的类。</span>
          </div>
        </details>
      </div>
    </div>

    <div v-if="dirty || error" class="cls-save">
      <span class="grow small" :class="{ 'warn-text': error }" :role="error ? 'alert' : undefined">{{ error ? `没保存：${error}` : "改动还没保存" }}</span>
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
.cls-global {
  display: grid;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.cls-global-head,
.deny-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}
.cls-global-label {
  font-size: 14px;
  margin-right: 4px;
}
.deny-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 2px 0 9px;
  border-radius: 999px;
  background: var(--sunken);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deny-x {
  flex: none;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}
.deny-x:hover {
  color: var(--ink);
}
.cls {
  border-top: 1px solid var(--line);
  min-width: 0;
}
.cls-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px 10px 18px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.cls-row:hover {
  background-image: linear-gradient(var(--hover), var(--hover));
}
.cls-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.cls-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
}
.cls-name {
  font-size: 14px;
  color: var(--ink);
}
.cls-meta {
  font-size: 13px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cls-end {
  display: grid;
  justify-items: end;
  gap: 2px;
  white-space: nowrap;
}
.cls-order {
  font-size: 13px;
  color: var(--ink-2);
}
.cls-count {
  font-size: 12px;
  color: var(--muted);
}
.chev {
  color: var(--muted);
  transition: transform 0.15s ease;
}
.cls.open .chev {
  transform: rotate(90deg);
}
.cls-body {
  display: grid;
  gap: 16px;
  padding: 4px 18px 16px;
  min-width: 0;
}
.cls-body > .field,
.cls-grid > .field {
  display: grid;
  gap: 6px;
  min-width: 0;
  align-content: start;
}
.cls-body .field > span:first-child {
  font-size: 13px;
  color: var(--ink-2);
}
.cls-body :deep(.ui-seg) {
  justify-self: start;
  max-width: 100%;
}
.cls-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  min-width: 0;
}
.said {
  margin: 0;
  color: var(--ink-2);
}
.usage {
  display: grid;
  grid-template-columns: minmax(0, max-content) auto;
  gap: 2px 16px;
  font-size: 13px;
  color: var(--ink-2);
  min-width: 0;
}
.usage-ai {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-n {
  color: var(--muted);
  white-space: nowrap;
}
.kinds summary {
  cursor: pointer;
  width: fit-content;
}
.kinds-body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 12px;
  padding-top: 8px;
  align-items: baseline;
  min-width: 0;
}
.kind-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
}
.kind-list code {
  font-size: 12px;
  color: var(--ink-2);
}
.kinds-note {
  grid-column: 1 / -1;
}
.cls-save {
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
  .cls-row {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 10px 12px 10px 14px;
  }
  .cls-end {
    grid-column: 1;
    grid-row: 2;
    display: flex;
    gap: 8px;
    justify-items: start;
  }
  .chev {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
  .cls-meta {
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .cls-body,
  .cls-global {
    padding-left: 14px;
    padding-right: 14px;
  }
  .cls-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .usage {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}
</style>
