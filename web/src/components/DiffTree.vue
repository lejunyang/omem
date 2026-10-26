<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "./Icon.vue";

/**
 * The changed files of a diff as a tree: folders fold, a chain of single folders reads as one
 * (`src/agents`), each file shows its added and removed lines. Picking a file is the caller's
 * (open its diff and scroll to it).
 */
export type TreeFile = { key: string; path: string; add: number; rm: number };
/** `hot`: the files of the change point being looked at, shown with its colour. */
const props = defineProps<{ files: TreeFile[]; active?: string | null; marked?: Set<string>; hot?: Set<string>; hotColor?: string }>();
const emit = defineEmits<{ pick: [key: string] }>();

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: TreeFile[] };
const root = computed(() => {
  const top: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of props.files) {
    const parts = f.path.split("/");
    let d = top;
    for (const part of parts.slice(0, -1)) {
      const path = d.path ? `${d.path}/${part}` : part;
      if (!d.dirs.has(part)) d.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
      d = d.dirs.get(part)!;
    }
    d.files.push(f);
  }
  // A folder holding only one folder reads as one row.
  const squash = (d: Dir): Dir => {
    let cur = d;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0];
      cur = { ...only, name: cur.name ? `${cur.name}/${only.name}` : only.name };
    }
    return { ...cur, dirs: new Map([...cur.dirs].map(([k, v]) => [k, squash(v)])) };
  };
  return { ...top, dirs: new Map([...top.dirs].map(([k, v]) => [k, squash(v)])) };
});

const closed = ref(new Set<string>());
const toggle = (path: string) => { const n = new Set(closed.value); n.has(path) ? n.delete(path) : n.add(path); closed.value = n; };
type Line = { kind: "dir"; dir: Dir; depth: number } | { kind: "file"; file: TreeFile; name: string; depth: number };
const lines = computed(() => {
  const out: Line[] = [];
  const walk = (d: Dir, depth: number) => {
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ kind: "dir", dir: sub, depth });
      if (!closed.value.has(sub.path)) walk(sub, depth + 1);
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ kind: "file", file: f, name: f.path.split("/").pop()!, depth });
  };
  walk(root.value, 0);
  return out;
});
</script>

<template>
  <nav class="tree small" aria-label="改动的文件">
    <template v-for="l in lines" :key="l.kind === 'dir' ? `d:${l.dir.path}` : `f:${l.file.key}`">
      <button v-if="l.kind === 'dir'" class="row-btn dir" :style="{ paddingLeft: `${6 + l.depth * 14}px` }" :aria-expanded="!closed.has(l.dir.path)" @click="toggle(l.dir.path)">
        <Icon :name="closed.has(l.dir.path) ? 'right' : 'down'" :size="12" /><Icon name="folder" :size="13" /><span class="ellipsis">{{ l.dir.name }}</span>
      </button>
      <button v-else class="row-btn file" :class="{ on: active === l.file.key, marked: marked?.has(l.file.key) }" :style="{ paddingLeft: `${24 + l.depth * 14}px` }" :title="l.file.path" @click="emit('pick', l.file.key)">
        <span class="ellipsis mono">{{ l.name }}</span><span v-if="hot?.has(l.file.key)" class="hot" :style="{ background: hotColor }" title="当前变更点涉及" /><span class="add">+{{ l.file.add }}</span><span class="rm">-{{ l.file.rm }}</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.tree { display: grid; gap: 1px; }
.row-btn { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; border: 0; background: none; color: var(--ink-2); font: inherit; text-align: left; padding: 3px 6px; border-radius: 6px; cursor: pointer; }
.row-btn:hover { background: var(--hover); }
.row-btn .ellipsis { flex: 1; min-width: 0; }
.dir { color: var(--ink); }
.file.on { background: var(--accent-soft); color: var(--ink); }
.file.marked .mono { font-weight: 600; }
.hot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--accent); }
.add { color: var(--ok); font-size: 11px; }
.rm { color: var(--danger); font-size: 11px; }
</style>
