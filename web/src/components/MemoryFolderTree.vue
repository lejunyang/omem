<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MemoryFolder } from "../api";
import Icon from "./Icon.vue";

/** What the memory list shows: a space (or all), and in it a folder, everything, or what is not filed. */
export type FolderSelection = { space: string | null; folder: string | null | undefined };

const props = defineProps<{
  folders: MemoryFolder[];
  unfiled: Record<string, number>;
  /** Spaces shown as roots, in order (one when the page is limited to the current space). */
  spaces: { id: string; name: string }[];
  selection: FolderSelection;
  total: number;
}>();
const emit = defineEmits<{
  (e: "select", s: FolderSelection): void;
  (e: "drop", s: { space: string; folder: string; ids: string[] }): void;
}>();

const expanded = ref(new Set<string>());
const key = (space: string, path: string) => `${space}\n${path}`;
// Open the way to whatever is selected; everything else starts folded below the first level.
watch(
  () => [props.selection.space, props.selection.folder],
  () => {
    const { space, folder } = props.selection;
    if (!space || !folder) return;
    const parts = folder.split("/");
    for (let i = 1; i < parts.length; i++) expanded.value.add(key(space, parts.slice(0, i).join("/")));
  },
  { immediate: true },
);
function toggle(space: string, path: string) {
  const k = key(space, path);
  const s = new Set(expanded.value);
  if (s.has(k)) s.delete(k);
  else s.add(k);
  expanded.value = s;
}

type Row = { key: string; space: string; path: string | null | undefined; name: string; depth: number; n: number; open: boolean; children: boolean; title?: string; kind: "space" | "folder" | "unfiled" };
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const many = props.spaces.length > 1;
  for (const s of props.spaces) {
    const folders = props.folders.filter((f) => f.spaceId === s.id);
    const unfiled = props.unfiled[s.id] ?? 0;
    const total = folders.filter((f) => !f.path.includes("/")).reduce((a, f) => a + f.total, 0) + unfiled;
    if (many && !folders.length && !unfiled) continue;
    const base = many ? 1 : 0;
    if (many) out.push({ key: `s:${s.id}`, space: s.id, path: undefined, name: s.name, depth: 0, n: total, open: true, children: false, kind: "space" });
    const byParent = new Map<string, MemoryFolder[]>();
    for (const f of folders) {
      const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      byParent.set(parent, [...(byParent.get(parent) ?? []), f]);
    }
    const walk = (parent: string, depth: number) => {
      for (const f of (byParent.get(parent) ?? []).sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"))) {
        const children = byParent.has(f.path);
        const open = expanded.value.has(key(s.id, f.path));
        out.push({ key: key(s.id, f.path), space: s.id, path: f.path, name: f.path.slice(parent ? parent.length + 1 : 0), depth: base + depth, n: f.total, open, children, title: f.description || undefined, kind: "folder" });
        if (children && open) walk(f.path, depth + 1);
      }
    };
    walk("", 0);
    if (unfiled) out.push({ key: `u:${s.id}`, space: s.id, path: null, name: "未归档", depth: base, n: unfiled, open: false, children: false, title: "还没放进目录的记忆；整理目录的运行会把它们归档", kind: "unfiled" });
  }
  return out;
});

const isOn = (r: Row) => props.selection.space === r.space && props.selection.folder === r.path;
const over = ref<string | null>(null);
function onDrop(r: Row, e: DragEvent) {
  over.value = null;
  const ids = (e.dataTransfer?.getData("application/x-omem-memories") ?? "").split(",").filter(Boolean);
  if (ids.length && r.kind !== "space") emit("drop", { space: r.space, folder: r.path ?? "", ids });
}
</script>

<template>
  <nav class="tree" aria-label="记忆目录">
    <button class="node" :class="{ on: !selection.space && selection.folder === undefined }" @click="emit('select', { space: null, folder: undefined })">
      <Icon name="layers" :size="14" /><span class="name">全部记忆</span><span class="n">{{ total }}</span>
    </button>
    <div v-for="r in rows" :key="r.key" class="line" :style="{ paddingLeft: `${r.depth * 14}px` }">
      <button v-if="r.children" class="twist" :aria-label="r.open ? `收起 ${r.name}` : `展开 ${r.name}`" :aria-expanded="r.open" @click="toggle(r.space, r.path as string)">
        <Icon :name="r.open ? 'down' : 'right'" :size="12" />
      </button>
      <span v-else class="twist-space" />
      <button
        class="node"
        :class="{ on: isOn(r), space: r.kind === 'space', unfiled: r.kind === 'unfiled', over: over === r.key }"
        :title="r.title"
        @click="emit('select', { space: r.space, folder: r.path })"
        @dragover.prevent="r.kind !== 'space' && (over = r.key)"
        @dragleave="over === r.key && (over = null)"
        @drop.prevent="onDrop(r, $event)"
      >
        <Icon v-if="r.kind === 'folder'" name="folder" :size="14" />
        <Icon v-else-if="r.kind === 'unfiled'" name="inbox" :size="14" />
        <span class="name">{{ r.name }}</span><span class="n">{{ r.n }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.tree {
  display: grid;
  gap: 1px;
}
.line {
  display: flex;
  align-items: center;
  min-width: 0;
}
.twist,
.twist-space {
  width: 18px;
  height: 26px;
  flex: none;
}
.twist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: none;
  color: var(--muted);
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
}
.twist:hover {
  background: var(--hover);
}
.node {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--ink-2);
  font: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}
.node:hover {
  background: var(--hover);
}
.node.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 550;
}
.node.over {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.node.space {
  font-weight: 600;
  color: var(--ink);
}
.node.unfiled {
  color: var(--muted);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.n {
  flex: none;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
