<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";

/**
 * A profile's `tools`, picked by group. The list keeps the syntax the profile file uses
 * (src/agents/tool-help.ts expandTools): `group:<id>` is a whole group — a tool added to the group
 * later comes with it; `-<name>` leaves one tool out; a bare name is a single tool. A whole group
 * never brings the tools a built-in role hands its result in with; those are ticked one by one.
 * `locked`: tools that stay ticked (what the built-in role being edited hands its own result in with).
 */
type Tool = { name: string; description: string; write: boolean; roleOnly?: boolean };
type Group = { id: string; label: string; tools: string[] };
type Shown = Group & { items: Tool[]; wholeable: boolean };

const props = withDefaults(defineProps<{ modelValue: string[]; tools: Tool[]; groups: Group[]; locked?: string[] }>(), { locked: () => [] });
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const open = ref(false);
const query = ref("");
const expanded = ref(new Set<string>());

const byName = computed(() => new Map(props.tools.map((t) => [t.name, t])));
/** Groups with the tools that exist here; what is in no group (a plugin's own tools) comes last, one by one only. */
const shownGroups = computed<Shown[]>(() => {
  const grouped = new Set(props.groups.flatMap((g) => g.tools));
  const list = props.groups.map((g) => {
    const items = g.tools.flatMap((n) => byName.value.get(n) ?? []);
    return { ...g, items, wholeable: items.some((t) => !t.roleOnly) || props.modelValue.includes(`group:${g.id}`) };
  });
  const rest = props.tools.filter((t) => !grouped.has(t.name));
  return [...list.filter((g) => g.items.length || g.wholeable), ...(rest.length ? [{ id: "", label: "插件带来的工具和其他", tools: rest.map((t) => t.name), items: rest, wholeable: false }] : [])];
});

const has = (entry: string) => props.modelValue.includes(entry);
const whole = (g: Shown) => g.wholeable && has(`group:${g.id}`);
const left = (name: string) => has(`-${name}`);
const on = (g: Shown, t: Tool) => !left(t.name) && (has(t.name) || (whole(g) && !t.roleOnly));
const picked = (g: Shown) => g.items.filter((t) => on(g, t)).length;
const leftOut = (g: Shown) => g.tools.filter(left).length;
const fixed = (name: string) => props.locked.includes(name);

/** The group's box: off or some → the whole group; whole → none of it. */
function toggleGroup(g: Shown) {
  const names = new Set(g.tools);
  const was = whole(g);
  const kept = props.modelValue.filter((e) => {
    if (e === `group:${g.id}`) return false;
    if (e.startsWith("-")) return !names.has(e.slice(1));
    if (!names.has(e)) return true;
    // Hand-in tools ticked by hand stay when the rest becomes "the whole group"; locked ones stay either way.
    return fixed(e) || (!was && !!byName.value.get(e)?.roleOnly);
  });
  emit("update:modelValue", was ? kept : [...kept, `group:${g.id}`]);
}
/** One tool: inside a whole group, unticking leaves it out (`-name`); otherwise it is listed by name. */
function toggleTool(g: Shown, t: Tool) {
  if (fixed(t.name) && on(g, t)) return;
  const rest = props.modelValue.filter((e) => e !== t.name && e !== `-${t.name}`);
  const covered = whole(g) && !t.roleOnly;
  if (on(g, t)) emit("update:modelValue", covered ? [...rest, `-${t.name}`] : rest);
  else emit("update:modelValue", covered ? rest : [...rest, t.name]);
}
const drop = (entry: string) => emit("update:modelValue", props.modelValue.filter((e) => e !== entry));

/** What is chosen, at a glance: whole groups first, then single tools; names that no longer exist stay removable. */
const chips = computed(() => {
  const out: { key: string; label: string; note?: string; mono?: boolean; missing?: boolean; title?: string; keep?: boolean; remove: () => void }[] = [];
  for (const g of shownGroups.value) {
    if (!whole(g)) continue;
    const n = leftOut(g);
    out.push({ key: `group:${g.id}`, label: g.label, note: n ? `整组，排除 ${n} 个` : "整组", title: `group:${g.id}${n ? `，排除 ${g.tools.filter(left).join("、")}` : ""}`, remove: () => toggleGroup(g) });
  }
  const covered = new Set(shownGroups.value.filter(whole).flatMap((g) => g.tools));
  for (const e of props.modelValue) {
    if (e.startsWith("group:")) {
      if (!shownGroups.value.some((g) => g.id && `group:${g.id}` === e)) out.push({ key: e, label: e, mono: true, missing: true, title: "没有这个分组了", remove: () => drop(e) });
    } else if (e.startsWith("-")) {
      // Leaving out a tool nothing brings in does nothing: shown so it can be cleaned up.
      if (!covered.has(e.slice(1))) out.push({ key: e, label: e, mono: true, missing: true, title: "排除的工具不在任何选中的分组里", remove: () => drop(e) });
    } else {
      const t = byName.value.get(e);
      out.push({ key: e, label: e, mono: true, missing: !t, keep: fixed(e), title: fixed(e) ? "这个角色用它交结果，不能去掉" : t ? `${t.write ? "（写）" : ""}${t.description}` : "已不存在", remove: () => drop(e) });
    }
  }
  return out;
});

const q = computed(() => query.value.trim().toLowerCase());
/** With a search: only the groups and tools that match (a match on the group's name keeps all of it), opened. */
const visible = computed(() =>
  shownGroups.value.flatMap((g) => {
    if (!q.value) return [{ g, items: g.items }];
    const all = g.label.toLowerCase().includes(q.value) || (!!g.id && g.id.includes(q.value));
    const items = all ? g.items : g.items.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q.value));
    return items.length || all ? [{ g, items }] : [];
  }),
);
const isOpen = (g: Shown) => !!q.value || expanded.value.has(g.id);
function toggleOpen(g: Shown) {
  const next = new Set(expanded.value);
  if (next.has(g.id)) next.delete(g.id);
  else next.add(g.id);
  expanded.value = next;
}
function stateOf(g: Shown) {
  if (whole(g)) return leftOut(g) ? `整组，排除 ${leftOut(g)} 个` : "整组";
  return picked(g) ? `已选 ${picked(g)} / ${g.items.length}` : `${g.items.length} 个`;
}
</script>

<template>
  <div class="tool-picker">
    <div class="chips">
      <span v-for="c in chips" :key="c.key" class="chip" :class="{ missing: c.missing }" :title="c.title">
        <span class="chip-name" :class="{ mono: c.mono }">{{ c.label }}</span>
        <span v-if="c.note" class="chip-note">{{ c.note }}</span>
        <button v-if="!c.keep" type="button" class="chip-x" :aria-label="`移除 ${c.label}`" @click="c.remove()">×</button>
        <span v-else class="chip-pad" />
      </span>
      <button type="button" class="btn sm" :aria-expanded="open" @click="open = !open"><Icon :name="open ? 'down' : 'plus'" :size="13" />{{ open ? "收起" : "按分组选择" }}</button>
    </div>
    <div v-if="open" class="panel">
      <label class="search"><Icon name="search" :size="14" /><input v-model="query" class="bare" placeholder="搜分组、工具名或用途" aria-label="搜索工具" /></label>
      <p class="muted small tip">勾分组名是整组都给它，以后加进这个分组的新工具自动带上；整组里取消某个工具就是排除它。只要其中几个，展开分组逐个勾。</p>
      <div class="groups">
        <div v-for="{ g, items } in visible" :key="g.id || '_other'" class="group" :class="{ on: whole(g) || picked(g) > 0 }">
          <div class="head">
            <UiCheckbox v-if="g.wholeable" size="sm" :model-value="whole(g)" :aria-label="`整组：${g.label}`" @update:model-value="toggleGroup(g)" />
            <span v-else class="no-box" />
            <button type="button" class="name" :aria-expanded="isOpen(g)" @click="toggleOpen(g)">
              <span class="label">{{ g.label }}</span>
              <span class="muted small state">{{ stateOf(g) }}</span>
              <Icon :name="isOpen(g) ? 'down' : 'right'" :size="14" />
            </button>
          </div>
          <div v-if="isOpen(g)" class="tools">
            <UiCheckbox v-for="t in items" :key="t.name" size="sm" :model-value="on(g, t)" :disabled="fixed(t.name) && on(g, t)" :aria-label="t.name" @update:model-value="toggleTool(g, t)">
              <span class="tool">
                <span class="mono">{{ t.name }}</span>
                <span v-if="t.write" class="tag">写</span>
                <span v-if="fixed(t.name)" class="tag">这个角色用它交结果，不能去掉</span>
                <span v-else-if="t.roleOnly" class="tag">内置角色交结果用，不随整组</span>
                <span v-if="whole(g) && left(t.name)" class="tag off">已排除</span>
                <span class="muted small">{{ t.description }}</span>
              </span>
            </UiCheckbox>
            <p v-if="!items.length" class="muted small">这个分组的工具由插件带来，现在还没有；勾了整组，插件启用后自动带上。</p>
          </div>
        </div>
        <p v-if="!visible.length" class="muted small">没有匹配的分组或工具。</p>
      </div>
      <p v-if="modelValue.length" class="muted small raw">档案文件里写成 <code>tools: [{{ modelValue.join(", ") }}]</code></p>
    </div>
  </div>
</template>

<style scoped>
.tool-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  background: var(--hover);
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.6;
}
.chip.missing .chip-name {
  text-decoration: line-through;
  color: var(--ink-2);
}
.chip-name {
  padding: 1px 2px 1px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-note {
  color: var(--ink-2);
  padding-left: 4px;
  white-space: nowrap;
}
.chip-x {
  border: 0;
  background: none;
  color: var(--ink-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 8px 2px 4px;
}
.chip-pad {
  width: 10px;
}
.chip-x:hover {
  color: var(--accent);
}
.panel {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 8px;
  color: var(--ink-2);
}
.search:focus-within {
  border-color: var(--accent);
}
.bare {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  color: inherit;
  font: inherit;
}
.tip,
.raw {
  margin: 0;
}
.raw code {
  overflow-wrap: anywhere;
}
.groups {
  max-height: 420px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.group + .group {
  border-top: 1px solid var(--line);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.no-box {
  flex: none;
  width: 15px;
}
.name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 7px 4px;
  cursor: pointer;
  border-radius: 6px;
}
.name:hover {
  background: var(--hover);
}
.label {
  min-width: 0;
  overflow-wrap: anywhere;
}
.group.on .label {
  font-weight: 600;
}
.state {
  margin-left: auto;
  flex: none;
}
.tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 0 10px 23px;
  min-width: 0;
}
.tools :deep(.ui-check) {
  align-items: flex-start;
}
.tool {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.tag {
  font-size: 11px;
  line-height: 1.5;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--hover);
  color: var(--ink-2);
  white-space: nowrap;
}
.tag.off {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
