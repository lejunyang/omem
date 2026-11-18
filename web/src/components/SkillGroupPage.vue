<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { get, post, put } from "../api";
import { moveSkill } from "../lib/skill-move";
import { toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";

/**
 * One skill group (src/agents/agent-skills.ts): what agents see of it (its description), and its
 * skills by purpose, the way its hub lists them. `purpose` (from the route) opens that section.
 */
type Member = { name: string; description: string; purpose: string; enabled: boolean; origin: string };
type Group = { id: string; title: string; description: string; autoDescription: string; enabled: boolean; count: number; enabledCount: number; skills: Member[] };

const props = defineProps<{ id: string; purpose: string | null; groups: { id: string; title: string }[] }>();
const emit = defineEmits<{ open: [name: string]; purpose: [p: string | null]; changed: [] }>();
const group = ref<Group | null>(null);
const error = ref("");
const filter = ref("");
const editing = ref(false);
const title = ref("");
const description = ref("");
const busy = ref(false);
const open = reactive(new Set<string>());

async function load() {
  error.value = "";
  try {
    group.value = await get<Group>(`/api/skill-groups/${encodeURIComponent(props.id)}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
watch(
  () => props.id,
  async () => {
    group.value = null;
    editing.value = false;
    open.clear();
    await load();
    // A small group opens whole; a large one only the purpose asked for.
    const g = group.value as Group | null; // load() set it
    if (g && g.count <= 40) for (const s of sections.value) open.add(s.purpose);
    reveal();
  },
  { immediate: true },
);
watch(() => props.purpose, () => reveal());

function reveal() {
  if (props.purpose === null || !group.value) return;
  open.add(props.purpose);
  void nextTick(() => document.getElementById(anchor(props.purpose!))?.scrollIntoView({ block: "start", behavior: "smooth" }));
}
const anchor = (p: string) => `purpose-${encodeURIComponent(p || "none")}`;

const sections = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const map = new Map<string, Member[]>();
  for (const s of group.value?.skills ?? []) {
    if (q && !`${s.name} ${s.purpose} ${s.description}`.toLowerCase().includes(q)) continue;
    map.set(s.purpose, [...(map.get(s.purpose) ?? []), s]);
  }
  return [...map].sort(([a], [b]) => (a ? (b ? a.localeCompare(b, "zh") : -1) : 1)).map(([purpose, list]) => ({ purpose, list, on: list.filter((s) => s.enabled).length }));
});
const searching = computed(() => !!filter.value.trim());
const isOpen = (p: string) => searching.value || open.has(p);
function toggle(p: string) {
  if (open.has(p)) open.delete(p);
  else open.add(p), emit("purpose", p);
}

function startEdit() {
  if (!group.value) return;
  title.value = group.value.title === group.value.id ? "" : group.value.title;
  description.value = group.value.description;
  editing.value = true;
}

async function saveGroup(patch: { title?: string; description?: string; enabled?: boolean }) {
  busy.value = true;
  try {
    await put(`/api/skill-groups/${encodeURIComponent(props.id)}`, patch);
    await load();
    editing.value = false;
    emit("changed");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function setEnabled(s: Member, enabled: boolean) {
  try {
    await put("/api/skill-groups", { skills: [{ name: s.name, enabled }] });
    s.enabled = enabled;
    emit("changed");
  } catch (e) {
    toast((e as Error).message);
  }
}

async function move(s: Member) {
  try {
    const to = await moveSkill(s.name, { group: props.id, purpose: s.purpose }, { groups: props.groups, purposes: sections.value.map((x) => x.purpose).filter(Boolean) });
    if (!to) return;
    await load();
    emit("changed");
    toast(to.group === props.id ? `已移到「${to.purpose || "未分用途"}」` : to.group ? `已移到分组 ${to.group}` : "已移出分组");
  } catch (e) {
    toast((e as Error).message);
  }
}

async function organize() {
  busy.value = true;
  try {
    await post("/api/agent-skills/organize", { group: props.id });
    toast("已交给后台整理，完成后会通知你");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page group-page">
    <p v-if="error" class="muted">{{ error }}</p>
    <Skeleton v-else-if="!group" variant="lines" :rows="10" />
    <template v-else>
      <header class="dh row">
        <h2>{{ group.title }}</h2>
        <code v-if="group.title !== group.id" class="muted small">{{ group.id }}</code>
        <span class="badge">启用 {{ group.enabledCount }}/{{ group.count }}</span>
        <span class="spacer" />
        <UiCheckbox :model-value="group.enabled" switch size="sm" :disabled="busy" @change="(v) => saveGroup({ enabled: v })">整组启用</UiCheckbox>
      </header>

      <section class="about">
        <template v-if="!editing">
          <div class="row label-row">
            <span class="muted small">Agent 看到的说明（决定它做什么事时来读这一组）</span>
            <span class="spacer" />
            <button class="btn ghost sm" @click="startEdit"><Icon name="edit" :size="13" />编辑</button>
            <button class="btn ghost sm" :disabled="busy" title="让后台的技能整理角色重新看一遍这一组：用途分得是否合理、说明够不够分流。你改过的不会动。" @click="organize"><Icon name="sparkles" :size="13" />让助手整理</button>
          </div>
          <p class="desc-text" :class="{ muted: !group.description }">{{ group.description || group.autoDescription }}</p>
        </template>
        <div v-else class="form">
          <label class="field"><span>标题</span><input v-model="title" class="input" :placeholder="group.id" /></label>
          <label class="field">
            <span>说明（做哪类事时该读这一组）</span>
            <textarea v-model="description" class="input desc" :placeholder="group.autoDescription" />
          </label>
          <div class="row">
            <button class="btn sm primary" :disabled="busy" @click="saveGroup({ title, description })">保存</button>
            <button class="btn ghost sm" @click="editing = false">取消</button>
          </div>
        </div>
      </section>

      <input v-model="filter" class="input" placeholder="按名称、用途或说明筛选" aria-label="筛选技能" />
      <p v-if="!sections.length" class="muted small">没有匹配的技能。</p>

      <section v-for="sec in sections" :id="anchor(sec.purpose)" :key="sec.purpose" class="sec">
        <button class="sec-head" :aria-expanded="isOpen(sec.purpose)" @click="toggle(sec.purpose)">
          <Icon :name="isOpen(sec.purpose) ? 'down' : 'right'" :size="14" />
          <span class="sec-title" :class="{ muted: !sec.purpose }">{{ sec.purpose || "未分用途" }}</span>
          <span class="muted small">{{ sec.on === sec.list.length ? sec.list.length : `${sec.on}/${sec.list.length} 启用` }}</span>
        </button>
        <ul v-if="isOpen(sec.purpose)" class="rows">
          <li v-for="s in sec.list" :key="s.name" class="skill-row" :class="{ off: !s.enabled }">
            <UiCheckbox :model-value="s.enabled" size="sm" :aria-label="`启用 ${s.name}`" @change="(v) => setEnabled(s, v)" />
            <div class="grow">
              <button class="link mono" @click="emit('open', s.name)">{{ s.name }}</button>
              <div class="muted small clamp">{{ s.description }}</div>
            </div>
            <button class="btn ghost sm move" :aria-label="`移动 ${s.name}`" @click="move(s)">移动</button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.group-page { display: grid; gap: 14px; }
.dh h2 { font-family: var(--serif, inherit); }
.about { display: grid; gap: 6px; }
.label-row { gap: 4px; flex-wrap: wrap; }
.desc-text { margin: 0; line-height: 1.7; }
.desc { min-height: 96px; resize: vertical; }
.sec { scroll-margin-top: 12px; border-top: 1px solid var(--line); }
.sec-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 2px; border: 0; background: none; color: var(--ink); cursor: pointer; text-align: left; font: inherit; }
.sec-head:hover { color: var(--accent); }
.sec-title { font-weight: 600; }
.rows { list-style: none; margin: 0 0 8px; padding: 0 0 0 22px; }
.skill-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px dashed var(--line); }
.skill-row:first-child { border-top: 0; }
.skill-row.off .grow { opacity: 0.55; }
.skill-row :deep(.ui-checkbox) { margin-top: 2px; }
.grow { min-width: 0; flex: 1; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; overflow-wrap: anywhere; text-align: left; font-size: 13px; }
.move { flex: none; opacity: 0.7; }
.skill-row:hover .move { opacity: 1; }
</style>
