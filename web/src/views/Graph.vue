<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import { state } from "../store";

type Node = { id: string; title: string; space_id: string; kind: string; x: number; y: number; vx: number; vy: number; degree: number };
type Edge = { from_id: string; to_id: string };

const route = useRoute();
const router = useRouter();
const space = computed(() => (route.params.space as string) || state.space);
if (route.params.space && route.params.space !== state.space && state.spaces.some((x) => x.id === route.params.space)) state.space = route.params.space as string;
const nodes = ref<Node[]>([]);
const edges = ref<Edge[]>([]);
const hover = ref<string | null>(null);
const width = 1000;
const height = 700;
let frame = 0;

const loading = ref(true);
async function load() {
  loading.value = true;
  const r = await get<{ nodes: Omit<Node, "x" | "y" | "vx" | "vy" | "degree">[]; edges: Edge[] }>(`/api/graph?space=${space.value}`);
  const degree = new Map<string, number>();
  for (const e of r.edges) {
    degree.set(e.from_id, (degree.get(e.from_id) ?? 0) + 1);
    degree.set(e.to_id, (degree.get(e.to_id) ?? 0) + 1);
  }
  nodes.value = r.nodes.map((n, i) => {
    const a = (i / Math.max(1, r.nodes.length)) * Math.PI * 2;
    return { ...n, x: width / 2 + Math.cos(a) * 220, y: height / 2 + Math.sin(a) * 220, vx: 0, vy: 0, degree: degree.get(n.id) ?? 0 };
  });
  edges.value = r.edges;
  loading.value = false;
  simulate(300);
}

/** A small force layout: repulsion between all nodes, springs along links, gentle pull to the centre. */
function simulate(steps: number) {
  const byId = new Map(nodes.value.map((n) => [n.id, n]));
  let i = 0;
  const tick = () => {
    for (let s = 0; s < 3 && i < steps; s++, i++) {
      const ns = nodes.value;
      for (let a = 0; a < ns.length; a++)
        for (let b = a + 1; b < ns.length; b++) {
          const dx = ns[a].x - ns[b].x || 0.01;
          const dy = ns[a].y - ns[b].y || 0.01;
          const d2 = dx * dx + dy * dy;
          const f = 9000 / d2;
          ns[a].vx += dx * f * 0.05;
          ns[a].vy += dy * f * 0.05;
          ns[b].vx -= dx * f * 0.05;
          ns[b].vy -= dy * f * 0.05;
        }
      for (const e of edges.value) {
        const a = byId.get(e.from_id);
        const b = byId.get(e.to_id);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 170) * 0.008;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
      for (const n of ns) {
        n.vx += (width / 2 - n.x) * 0.002;
        n.vy += (height / 2 - n.y) * 0.002;
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x = Math.min(width - 40, Math.max(40, n.x + n.vx));
        n.y = Math.min(height - 30, Math.max(30, n.y + n.vy));
      }
    }
    nodes.value = [...nodes.value];
    if (i < steps) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
onMounted(load);
onBeforeUnmount(() => cancelAnimationFrame(frame));

const byId = computed(() => new Map(nodes.value.map((n) => [n.id, n])));
const neighbours = computed(() => {
  if (!hover.value) return null;
  const set = new Set([hover.value]);
  for (const e of edges.value) {
    if (e.from_id === hover.value) set.add(e.to_id);
    if (e.to_id === hover.value) set.add(e.from_id);
  }
  return set;
});
function open(n: Node) {
  router.push(`/wiki/${n.space_id}/${n.id.split("/").slice(1).join("/")}`);
}
</script>

<template>
  <div class="page graph-page">
    <div class="page-head">
      <div>
        <h1>页面关系</h1>
        <p>「{{ state.spaces.find((s) => s.id === space)?.name ?? space }}」中页面之间的链接。点击节点打开页面，悬停查看相邻页面。</p>
      </div>
      <span class="spacer" />
      <router-link :to="`/wiki/${space}`" class="btn sm"><Icon name="book" :size="14" />回到 Wiki</router-link>
    </div>
    <Skeleton v-if="loading" variant="cards" :rows="2" />
    <div v-else-if="!nodes.length" class="empty"><Icon name="graph" :size="32" /><h3>还没有页面</h3></div>
    <div v-else class="card canvas">
      <svg :viewBox="`0 0 ${width} ${height}`" role="img" aria-label="页面关系图">
        <line
          v-for="(e, i) in edges"
          :key="i"
          :x1="byId.get(e.from_id)?.x"
          :y1="byId.get(e.from_id)?.y"
          :x2="byId.get(e.to_id)?.x"
          :y2="byId.get(e.to_id)?.y"
          class="edge"
          :class="{ dim: neighbours && !(neighbours.has(e.from_id) && neighbours.has(e.to_id)) }"
        />
        <g v-for="n in nodes" :key="n.id" class="node" :class="{ dim: neighbours && !neighbours.has(n.id), index: n.kind === 'index' }" :transform="`translate(${n.x},${n.y})`" @mouseenter="hover = n.id" @mouseleave="hover = null" @click="open(n)">
          <circle :r="6 + Math.min(10, n.degree * 1.5)" />
          <text y="-12" text-anchor="middle">{{ n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title }}</text>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.graph-page {
  max-width: 1200px;
}
.canvas {
  padding: 8px;
  overflow: hidden;
}
.canvas svg {
  width: 100%;
  height: auto;
  display: block;
}
.edge {
  stroke: var(--line-strong);
  stroke-width: 1.2;
}
.edge.dim {
  opacity: 0.15;
}
.node {
  cursor: pointer;
}
.node circle {
  fill: var(--accent-soft);
  stroke: var(--accent);
  stroke-width: 1.5;
}
.node.index circle {
  fill: var(--accent);
}
.node text {
  font-size: 12px;
  fill: var(--ink-2);
  paint-order: stroke;
  stroke: var(--panel);
  stroke-width: 3px;
}
.node.dim {
  opacity: 0.25;
}
.node:hover text {
  fill: var(--ink);
  font-weight: 600;
}
</style>
