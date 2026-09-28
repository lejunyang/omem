<script setup lang="ts">
/** Deterministic layered SVG module architecture graph. No Mermaid / force
 * layout / Canvas: positions are computed from a fixed longest-path layering so
 * re-renders never drift. Nodes are modules (boxes), edges are aggregated
 * in-repo import relationships between modules.
 *
 * Edge visual encodes status: solid = confirmed, dashed = candidate, hatched =
 * stale, broken stub = missing (external). Clicking a node emits selectNode;
 * clicking an edge label emits selectEdge. Nodes are real <g tabindex=0> and
 * respond to Enter/Space.
 */
import { computed } from "vue";

export type GraphModule = {
  id: string;
  label: string;
  fileCount: number;
  symbolCount: number;
};

export type GraphEdge = {
  id: string;
  from: string; // importer module id (right/higher layer)
  to: string; // imported module id (left/lower layer)
  count: number;
  status: "confirmed" | "candidate" | "missing" | "stale";
  evidence: string[];
};

const props = defineProps<{
  modules: GraphModule[];
  edges: GraphEdge[];
  selectedId?: string;
}>();

const emit = defineEmits<{
  selectNode: [moduleId: string];
  selectEdge: [edge: GraphEdge];
}>();

const COL_W = 250;
const ROW_H = 78;
const BOX_W = 190;
const BOX_H = 50;
const PAD_X = 30;
const PAD_Y = 30;

/** layer(m) = 0 for modules that import nothing in-repo; else 1 + max layer of
 * their imports. Deterministic. */
const layout = computed(() => {
  const byId = new Map(props.modules.map((m) => [m.id, m]));
  // adjacency: module -> modules it imports
  const imports = new Map<string, Set<string>>();
  for (const e of props.edges) {
    if (e.status === "missing") continue;
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!imports.has(e.from)) imports.set(e.from, new Set());
    imports.get(e.from)!.add(e.to);
  }
  const layer = new Map<string, number>();
  const order = [...props.modules].sort((a, b) => a.id.localeCompare(b.id));
  // fixed-point layering, capped to avoid cycles
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (const m of order) {
      const deps = imports.get(m.id);
      if (!deps || !deps.size) {
        if (layer.get(m.id) !== 0) {
          layer.set(m.id, 0);
          changed = true;
        }
        continue;
      }
      let maxDep = -1;
      for (const d of deps) maxDep = Math.max(maxDep, layer.get(d) ?? 0);
      const want = maxDep + 1;
      if ((layer.get(m.id) ?? -1) !== want) {
        layer.set(m.id, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // bucket modules by layer
  const buckets = new Map<number, GraphModule[]>();
  for (const m of order) {
    const l = layer.get(m.id) ?? 0;
    if (!buckets.has(l)) buckets.set(l, []);
    buckets.get(l)!.push(m);
  }
  const layers = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach(([lvl, mods], colIdx) => {
    mods.forEach((m, rowIdx) => {
      positions.set(m.id, {
        x: PAD_X + colIdx * COL_W,
        y: PAD_Y + rowIdx * ROW_H,
      });
    });
  });
  const maxRow = Math.max(...layers.map(([, mods]) => mods.length), 1);
  const width = PAD_X * 2 + layers.length * COL_W;
  const height = PAD_Y * 2 + maxRow * ROW_H;
  return { positions, width, height };
});

function edgePath(e: GraphEdge): string {
  const a = layout.value.positions.get(e.from);
  const b = layout.value.positions.get(e.to);
  if (!a || !b) return "";
  // from (right side of importer) to (left side of imported)
  const x1 = a.x;
  const y1 = a.y + BOX_H / 2;
  const x2 = b.x + BOX_W;
  const y2 = b.y + BOX_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

function edgeMid(e: GraphEdge): { x: number; y: number } {
  const a = layout.value.positions.get(e.from);
  const b = layout.value.positions.get(e.to);
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (a.x + b.x + BOX_W) / 2, y: (a.y + b.y) / 2 + BOX_H / 2 };
}

function edgeClass(e: GraphEdge): string {
  if (e.status === "candidate") return "edge candidate";
  if (e.status === "stale") return "edge stale";
  return "edge confirmed";
}

function onNodeKey(e: KeyboardEvent, id: string) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    emit("selectNode", id);
  }
}
</script>

<template>
  <svg
    class="om-relation-graph"
    :viewBox="`0 0 ${layout.width} ${layout.height}`"
    role="group"
    aria-label="模块依赖图"
  >
    <defs>
      <pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="6" stroke="#bbb" stroke-width="2" />
      </pattern>
    </defs>
    <!-- edges under nodes -->
    <g v-for="e in edges" :key="e.id">
      <path :d="edgePath(e)" :class="edgeClass(e)" fill="none" />
      <g :transform="`translate(${edgeMid(e).x},${edgeMid(e).y})`" class="edge-label"
        role="button" tabindex="0" @click="emit('selectEdge', e)"
        @keydown="onNodeKey($event, e.id)">
        <circle r="9" />
        <text text-anchor="middle" dy="3">{{ e.count }}</text>
      </g>
    </g>
    <!-- nodes -->
    <g v-for="m in modules" :key="m.id"
      :transform="`translate(${layout.positions.get(m.id)?.x ?? 0},${layout.positions.get(m.id)?.y ?? 0})`"
      class="node" :class="{ selected: m.id === selectedId }"
      role="button" tabindex="0" :aria-label="m.label"
      @click="emit('selectNode', m.id)" @keydown="onNodeKey($event, m.id)">
      <rect :width="BOX_W" :height="BOX_H" rx="6" />
      <text class="node-title" x="12" y="20">{{ m.label }}</text>
      <text class="node-sub" x="12" y="38">{{ m.fileCount }} 文件 · {{ m.symbolCount }} 符号</text>
    </g>
  </svg>
</template>

<style scoped>
.om-relation-graph {
  width: 100%;
  height: auto;
  background: var(--om-paper);
  border: 1px solid var(--om-line);
  border-radius: 8px;
}
.edge {
  stroke: var(--om-secondary);
  stroke-width: 1.2;
}
.edge.candidate {
  stroke-dasharray: 5 4;
}
.edge.stale {
  stroke: var(--om-muted);
  stroke-dasharray: 2 4;
}
.edge-label circle {
  fill: var(--om-panel);
  stroke: var(--om-line);
  cursor: pointer;
}
.edge-label text {
  font-size: 10px;
  fill: var(--om-secondary);
  pointer-events: none;
}
.node rect {
  fill: var(--om-panel);
  stroke: var(--om-line);
  stroke-width: 1;
}
.node:hover rect,
.node:focus rect {
  stroke: var(--om-ink);
}
.node.selected rect {
  stroke: var(--om-ink);
  stroke-width: 2;
}
.node-title {
  font-size: 13px;
  font-weight: 600;
  fill: var(--om-ink);
}
.node-sub {
  font-size: 10px;
  fill: var(--om-muted);
}
</style>
