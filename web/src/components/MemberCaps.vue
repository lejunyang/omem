<script setup lang="ts">
import { groupCapabilities } from "../lib/capability-areas";
import { computed, ref, watch } from "vue";
import { get, put } from "../api";
import Icon from "./Icon.vue";
import SideSheet from "./SideSheet.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { state, toast } from "../store";

/**
 * What one member may do (src/auth/capabilities.ts, docs/v2/multi-user.md “成员能力”): the preset on
 * top, then every capability by area with where it comes from, and a three-way choice — follow the
 * preset, allow, or not. A space-scoped one opens to the spaces the member can read, each with its own
 * choice. Changes stay here until 保存 sends the whole set (`PUT /api/members/:id/capabilities`).
 */
export type Capability = { key: string; scope: "global" | "space"; name: string; description: string; area: string; action: string; presets: string[] };
export type MemberCapsData = {
  preset: string;
  overrides: { capability: string; scope_kind: "global" | "space"; scope_id: string; effect: "allow" | "deny" }[];
  effective: Record<string, string | null | Record<string, string>>;
};
type Role = { id: string; name: string; description: string; scope: string };
type Choice = "inherit" | "allow" | "deny";

const props = defineProps<{
  user: { id: string; name: string; role: string; spaces: { space: string; name: string; role: string }[] };
  catalog: Capability[];
  roles: Role[];
  /** The owner may give any preset; someone else with 管理成员权限 only the ones without management. */
  owner: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [data: MemberCapsData] }>();

const data = ref<MemberCapsData | null>(null);
const error = ref("");
const preset = ref("");
/** `capability\u0000scope_id` → effect; an empty scope id is the global one. */
const draft = ref<Record<string, "allow" | "deny">>({});
const keyOf = (cap: string, space = "") => `${cap}\u0000${space}`;
const savedMap = computed(() => Object.fromEntries((data.value?.overrides ?? []).map((o) => [keyOf(o.capability, o.scope_kind === "space" ? o.scope_id : ""), o.effect])));

async function load() {
  error.value = "";
  try {
    const d = await get<MemberCapsData>(`/api/members/${encodeURIComponent(props.user.id)}/capabilities`);
    data.value = d;
    preset.value = d.preset;
    draft.value = { ...savedMap.value };
  } catch (e) {
    error.value = (e as Error).message;
  }
}
void load();

// ---- the preset ---------------------------------------------------------------------------------
const presets = computed(() =>
  props.roles
    .filter((r) => r.scope === "global" && r.id !== "owner" && (props.owner || ["member", "viewer", "observer"].includes(r.id) || r.id === data.value?.preset))
    .map((r) => ({ value: r.id, label: r.name, hint: r.description })),
);
const roleName = (id: string) => props.roles.find((r) => r.id === id)?.name ?? id;
const presetHint = computed(() => props.roles.find((r) => r.id === preset.value)?.description ?? "");

// ---- the capabilities, by area -------------------------------------------------------------------
const groups = computed(() => groupCapabilities(props.catalog));

/** The spaces the member can read: their memberships, and any space a capability reaches or an override names. */
const spaces = computed(() => {
  const names = new Map<string, string>();
  for (const s of props.user.spaces) names.set(s.space, s.name);
  for (const v of Object.values(data.value?.effective ?? {})) if (v && typeof v === "object") for (const id of Object.keys(v)) if (!names.has(id)) names.set(id, "");
  for (const o of data.value?.overrides ?? []) if (o.scope_kind === "space" && !names.has(o.scope_id)) names.set(o.scope_id, "");
  return [...names].map(([id, name]) => ({ id, name: name || state.spaces.find((s) => s.id === id)?.name || id }))
    .sort((a, b) => Number(a.id.startsWith("personal")) - Number(b.id.startsWith("personal")) || a.name.localeCompare(b.name, "zh"));
});

const choice = (cap: string, space = ""): Choice => draft.value[keyOf(cap, space)] ?? "inherit";
function setChoice(cap: string, space: string, v: Choice) {
  const next = { ...draft.value };
  if (v === "inherit") delete next[keyOf(cap, space)];
  else next[keyOf(cap, space)] = v;
  draft.value = next;
}
const OPTIONS: { value: Choice; label: string }[] = [{ value: "inherit", label: "跟预设" }, { value: "allow", label: "允许" }, { value: "deny", label: "不给" }];
const SPACE_OPTIONS: { value: Choice; label: string }[] = [{ value: "inherit", label: "跟上面" }, { value: "allow", label: "允许" }, { value: "deny", label: "不给" }];

/** Where a capability comes from when nothing is set on it: the (new) preset, a space role, or nothing. */
function inherited(c: Capability, space?: string): { on: boolean; from: string } {
  if (c.presets.includes(preset.value)) return { on: true, from: "预设带的" };
  const eff = data.value?.effective[c.key];
  const viaRole = eff && typeof eff === "object" ? (space ? eff[space] === "spaceRole" : Object.values(eff).includes("spaceRole")) : eff === "spaceRole";
  return viaRole ? { on: true, from: "空间角色带的" } : { on: false, from: "" };
}
/** What the row says: 有 or 没有, and why. */
function stateOf(c: Capability, space?: string): { on: boolean; text: string; label?: string } {
  const own = choice(c.key, space ?? "");
  const top = space ? choice(c.key) : own;
  if (top === "deny" || own === "deny") return { on: false, text: space && own !== "deny" ? "上面不给" : "单独不给" };
  if (own === "allow" || top === "allow") return { on: true, text: space && own !== "allow" ? "上面允许" : "单独给的" };
  // Following the preset overall, but some spaces set apart: say it holds in some of them.
  if (!space && c.scope === "space" && spaces.value.length) {
    const on = spaces.value.filter((s) => stateOf(c, s.id).on).length;
    if (on && on < spaces.value.length) return { on: true, label: "部分有", text: `${on} / ${spaces.value.length} 个空间` };
  }
  const i = inherited(c, space);
  return { on: i.on, text: i.from };
}
const spaceSet = (cap: string) => spaces.value.filter((s) => choice(cap, s.id) !== "inherit").length;
const openCaps = ref<Set<string>>(new Set());
function toggleSpaces(cap: string) {
  const next = new Set(openCaps.value);
  if (next.has(cap)) next.delete(cap);
  else next.add(cap);
  openCaps.value = next;
}

// ---- what changed, and saving ---------------------------------------------------------------------
const changes = computed(() => {
  const before = savedMap.value, after = draft.value;
  let allow = 0, deny = 0, back = 0;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] === after[k]) continue;
    if (after[k] === "allow") allow++;
    else if (after[k] === "deny") deny++;
    else back++;
  }
  return { preset: !!data.value && preset.value !== data.value.preset, allow, deny, back };
});
const dirty = computed(() => changes.value.preset || changes.value.allow + changes.value.deny + changes.value.back > 0);
const changeText = computed(() => {
  const c = changes.value;
  const parts = [c.preset ? `预设改成${roleName(preset.value)}` : ""];
  const counts = [c.allow ? `另给 ${c.allow} 项` : "", c.deny ? `不给 ${c.deny} 项` : "", c.back ? `${c.back} 项跟回预设` : ""].filter(Boolean).join("、");
  return [...parts, counts].filter(Boolean).join("；");
});
const saving = ref(false);
const saveError = ref("");
async function save() {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  saveError.value = "";
  const overrides = Object.entries(draft.value).map(([k, effect]) => {
    const [capability, space] = k.split("\u0000");
    return { capability, scope_kind: space ? ("space" as const) : ("global" as const), scope_id: space, effect };
  });
  try {
    const r = await put<MemberCapsData>(`/api/members/${encodeURIComponent(props.user.id)}/capabilities`, { preset: preset.value, overrides });
    data.value = r;
    preset.value = r.preset;
    draft.value = { ...savedMap.value };
    toast(`已保存${props.user.name}能做什么`, "ok");
    emit("saved", r);
  } catch (e) {
    saveError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
let asking = false;
async function close() {
  if (asking) return;
  if (dirty.value) {
    asking = true;
    const drop = await confirmDialog("放弃没保存的改动？", { message: changeText.value, okText: "放弃改动", danger: true }).finally(() => (asking = false));
    if (!drop) return;
  }
  emit("close");
}
// Another member opened in the same sheet starts over.
watch(() => props.user.id, () => { data.value = null; openCaps.value = new Set(); void load(); });
</script>

<template>
  <SideSheet :label="`${user.name}能做什么`" tag="能做什么" :width="620" @close="close">
    <template #head><strong class="mc-who">{{ user.name }}</strong></template>
    <Skeleton v-if="!data && !error" variant="list" :rows="8" />
    <div v-else-if="!data" class="mc-error" role="alert">
      <span>读不到{{ user.name }}的能力：{{ error }}</span>
      <button type="button" class="btn ghost sm" @click="load">重试</button>
    </div>
    <template v-else>
      <section class="mc-preset" aria-label="预设">
        <div class="mc-preset-row">
          <span class="mc-label">预设</span>
          <UiSelect v-model="preset" size="sm" width="200px" :aria-label="`${user.name}的预设`" :options="presets" />
        </div>
        <p v-if="presetHint" class="mc-preset-hint">{{ presetHint }}</p>
      </section>

      <section v-for="g in groups" :key="g.label" class="mc-group" :aria-label="g.label">
        <h3 class="mc-area">{{ g.label }}</h3>
        <div v-for="c in g.caps" :key="c.key" class="mc-cap" :class="{ open: openCaps.has(c.key) }">
          <div class="mc-row">
            <div class="mc-what">
              <div class="mc-line">
                <span class="mc-name">{{ c.name }}</span>
                <span class="mc-state" :class="{ on: stateOf(c).on, set: choice(c.key) !== 'inherit' }"><i aria-hidden="true" />{{ stateOf(c).label ?? (stateOf(c).on ? "有" : "没有") }}<template v-if="stateOf(c).text"> · {{ stateOf(c).text }}</template></span>
                <button
                  v-if="c.scope === 'space' && spaces.length"
                  type="button"
                  class="mc-spaces"
                  :class="{ marked: spaceSet(c.key) }"
                  :aria-expanded="openCaps.has(c.key)"
                  :aria-controls="`mc-sp-${c.key}`"
                  @click="toggleSpaces(c.key)"
                >
                  {{ spaceSet(c.key) ? `${spaceSet(c.key)} 个空间另设` : "按空间" }}<Icon name="down" :size="12" class="mc-chev" />
                </button>
              </div>
              <div class="mc-desc">{{ c.description }}</div>
            </div>
            <UiSegmented class="mc-pick" :model-value="choice(c.key)" size="sm" :aria-label="`${c.name}：所有空间`" :options="OPTIONS" @change="(v) => setChoice(c.key, '', v)" />
          </div>
          <div v-if="c.scope === 'space' && openCaps.has(c.key)" :id="`mc-sp-${c.key}`" class="mc-space-list">
            <div v-for="s in spaces" :key="s.id" class="mc-space">
              <span class="mc-space-name" :title="s.name">{{ s.name }}</span>
              <span class="mc-state" :class="{ on: stateOf(c, s.id).on, set: choice(c.key, s.id) !== 'inherit' }"><i aria-hidden="true" />{{ stateOf(c, s.id).on ? "有" : "没有" }}<template v-if="stateOf(c, s.id).text"> · {{ stateOf(c, s.id).text }}</template></span>
              <UiSegmented class="mc-pick" :model-value="choice(c.key, s.id)" size="sm" :aria-label="`${c.name}：${s.name}`" :options="SPACE_OPTIONS" @change="(v) => setChoice(c.key, s.id, v)" />
            </div>
          </div>
        </div>
      </section>
    </template>

    <template #foot>
      <span class="mc-change" :class="{ none: !dirty }">{{ dirty ? changeText : "没有改动" }}</span>
      <span v-if="saveError" class="mc-save-error" role="alert">{{ saveError }}</span>
      <span class="mc-grow" />
      <button type="button" class="btn ghost sm" @click="close">{{ dirty ? "取消" : "关闭" }}</button>
      <button type="button" class="btn sm primary" :disabled="!dirty || saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
    </template>
  </SideSheet>
</template>
