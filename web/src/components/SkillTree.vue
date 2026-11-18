<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import Icon from "./Icon.vue";

/**
 * The skill groups in the list column (src/agents/agent-skills.ts): group → purpose → skill, folded.
 * The branch holding what is open on the right unfolds by itself.
 */
type Skill = { name: string; group?: string | null; purpose?: string; enabled?: boolean };
type Group = { id: string; title: string; enabled: boolean; count: number; enabledCount: number };

const props = defineProps<{ skills: Skill[]; groups: Group[]; group: string | null; purpose: string | null; skill: string | null }>();
const emit = defineEmits<{ group: [id: string, purpose?: string]; skill: [name: string] }>();

const open = reactive(new Set<string>());
const toggle = (key: string) => (open.has(key) ? open.delete(key) : open.add(key));
const NONE = "未分用途";

/** group id → [purpose, skills] in the hub's order (purposes by name, the unsorted last). */
const tree = computed(() => {
  const map = new Map<string, Map<string, Skill[]>>();
  for (const s of props.skills) {
    if (!s.group) continue;
    const g = map.get(s.group) ?? new Map<string, Skill[]>();
    const p = s.purpose?.trim() || "";
    g.set(p, [...(g.get(p) ?? []), s]);
    map.set(s.group, g);
  }
  return new Map([...map].map(([id, g]) => [id, [...g].sort(([a], [b]) => (a ? (b ? a.localeCompare(b, "zh") : -1) : 1)).map(([p, list]) => ({ purpose: p, list: list.sort((x, y) => x.name.localeCompare(y.name)) }))]));
});

watch(
  () => [props.group, props.purpose, props.skill, props.skills.length] as const,
  ([g, p, name]) => {
    if (g) {
      open.add(g);
      if (p !== null) open.add(`${g}/${p}`);
    }
    const s = name ? props.skills.find((x) => x.name === name) : null;
    if (s?.group) open.add(s.group), open.add(`${s.group}/${s.purpose?.trim() || ""}`);
  },
  { immediate: true },
);
</script>

<template>
  <div class="tree" role="tree" aria-label="技能分组">
    <template v-for="g in groups" :key="g.id">
      <div class="node lvl1" :class="{ on: group === g.id && purpose === null, off: !g.enabled }" role="treeitem" :aria-expanded="open.has(g.id)">
        <button class="caret" :aria-label="open.has(g.id) ? '收起' : '展开'" @click="toggle(g.id)"><Icon :name="open.has(g.id) ? 'down' : 'right'" :size="13" /></button>
        <button class="label" @click="open.add(g.id); emit('group', g.id)">
          <span class="ellipsis">{{ g.title }}</span>
          <span class="count">{{ g.enabledCount === g.count ? g.count : `${g.enabledCount}/${g.count}` }}</span>
        </button>
      </div>
      <template v-if="open.has(g.id)">
        <template v-for="p in tree.get(g.id) ?? []" :key="p.purpose">
          <div class="node lvl2" :class="{ on: group === g.id && purpose === p.purpose }" role="treeitem" :aria-expanded="open.has(`${g.id}/${p.purpose}`)">
            <button class="caret" :aria-label="open.has(`${g.id}/${p.purpose}`) ? '收起' : '展开'" @click="toggle(`${g.id}/${p.purpose}`)"><Icon :name="open.has(`${g.id}/${p.purpose}`) ? 'down' : 'right'" :size="12" /></button>
            <button class="label" @click="open.add(`${g.id}/${p.purpose}`); emit('group', g.id, p.purpose)">
              <span class="ellipsis" :class="{ muted: !p.purpose }">{{ p.purpose || NONE }}</span>
              <span class="count">{{ p.list.length }}</span>
            </button>
          </div>
          <template v-if="open.has(`${g.id}/${p.purpose}`)">
            <button v-for="s in p.list" :key="s.name" class="node lvl3 label" :class="{ on: skill === s.name, off: s.enabled === false }" role="treeitem" :title="s.name" @click="emit('skill', s.name)">
              <span class="ellipsis mono">{{ s.name }}</span>
            </button>
          </template>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
.tree { display: grid; gap: 1px; }
.node { display: flex; align-items: center; min-width: 0; border-radius: 6px; color: var(--ink); }
.node:hover { background: var(--hover); }
.node.on { background: var(--accent-soft); color: var(--accent); }
.node.off { opacity: 0.55; }
.caret { flex: none; display: grid; place-items: center; width: 22px; height: 28px; border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0; }
.label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; border: 0; background: none; color: inherit; text-align: left; padding: 5px 8px 5px 2px; cursor: pointer; font: inherit; }
.lvl1 { font-weight: 600; font-size: 13px; }
.lvl2 { padding-left: 16px; font-size: 13px; }
.lvl3 { padding: 4px 8px 4px 62px; font-size: 12px; color: var(--ink-2); }
.count { margin-left: auto; flex: none; font-size: 11px; font-weight: 400; color: var(--muted); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
