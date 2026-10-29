<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ancestors, defaultOpen, flattenNav, type NavNode, type NavRow } from "../lib/wikiTree";
import VirtualList from "./VirtualList.vue";
import WikiTreeRow from "./WikiTreeRow.vue";

/**
 * The Wiki's folder tree: collapsible folders with page counts, a mark on pages (and the folders
 * above them) whose cited originals changed. Which folders are open is remembered per space.
 */
const props = defineProps<{ nodes: NavNode[]; space: string; current: string; filter?: string; total: number }>();
const emit = defineEmits<{ navigate: [] }>();

const store = (space: string) => `omem.wiki.open.${space}`;
function load(space: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(store(space));
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(store(props.space), JSON.stringify([...open.value]));
  } catch {}
}

const open = ref<Set<string>>(new Set());
let seeded = "";
// Once the tree of a space has arrived: what was open last time, or a first-visit default; the way
// to the page being read is always open.
watch(
  () => [props.space, props.nodes.length] as const,
  () => {
    if (!props.nodes.length || seeded === props.space) return;
    seeded = props.space;
    open.value = load(props.space) ?? defaultOpen(props.nodes, props.current, props.total);
    reveal();
  },
  { immediate: true },
);
function reveal() {
  const need = ancestors(props.current).filter((a) => !open.value.has(a));
  if (!need.length) return;
  open.value = new Set([...open.value, ...need]);
  save();
}
watch(() => props.current, reveal);

function toggle(folder: string) {
  const next = new Set(open.value);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  open.value = next;
  save();
}
function setAll(value: boolean) {
  const all = new Set<string>();
  const walk = (ns: NavNode[]) => ns.forEach((n) => (n.folder !== undefined && all.add(n.folder), walk(n.children)));
  walk(props.nodes);
  open.value = value ? all : new Set(ancestors(props.current));
  save();
}
const folderCount = computed(() => {
  let n = 0;
  const walk = (ns: NavNode[]) => ns.forEach((x) => (x.folder !== undefined && n++, walk(x.children)));
  walk(props.nodes);
  return n;
});

/** Open a folder and the ones above it (the overview's "在目录里展开"). */
function openFolder(path: string) {
  open.value = new Set([...open.value, path, ...ancestors(path + "/x")]);
  save();
}
defineExpose({ openFolder });

const rows = computed<NavRow[]>(() => flattenNav(props.nodes, open.value, props.filter));
const key = (r: NavRow) => r.key;

// Bring the page being read into view (a long folder keeps it far down the list).
const list = ref<{ scrollToIndex: (index: number, align?: "start" | "center") => Promise<void> } | null>(null);
const root = ref<HTMLElement>();
async function showCurrent() {
  await nextTick();
  const i = rows.value.findIndex((r) => !r.isFolder && r.node.slug === props.current);
  if (i < 0) return;
  if (rows.value.length > 150) list.value?.scrollToIndex(i, "center");
  else root.value?.querySelector<HTMLElement>(".node.on")?.scrollIntoView({ block: "nearest" });
}
onMounted(showCurrent);
watch(() => props.current, showCurrent);
</script>

<template>
  <div ref="root" class="wtree" role="tree" aria-label="Wiki 目录">
    <div v-if="folderCount > 1 && !filter" class="tools small">
      <button class="link" type="button" @click="setAll(true)">全部展开</button>
      <button class="link" type="button" @click="setAll(false)">折叠</button>
    </div>
    <VirtualList v-if="rows.length > 150" ref="list" :items="rows" :item-key="key" :estimate="30">
      <template #default="{ item: r }">
        <WikiTreeRow :row="r" :space="space" :current="current" @toggle="toggle" @navigate="emit('navigate')" />
      </template>
    </VirtualList>
    <template v-else>
      <WikiTreeRow v-for="r in rows" :key="r.key" :row="r" :space="space" :current="current" @toggle="toggle" @navigate="emit('navigate')" />
    </template>
    <div v-if="filter && !rows.length" class="muted small empty">没有匹配的页面</div>
  </div>
</template>

<style scoped>
.tools {
  display: flex;
  gap: 10px;
  padding: 0 8px 4px;
}
.link {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  font: inherit;
}
.link:hover {
  color: var(--ink);
}
.empty {
  padding: 8px;
}
</style>
