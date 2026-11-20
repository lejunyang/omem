<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { changeTone, changeTypeLabel, dayLabel, nextKindLabel, type ChangeLite, type NextLite } from "../lib/work";

/**
 * A line's last key changes as a dot-and-line row, oldest on the left: hollow dots coloured by what
 * changed, the newest filled, then a dashed node for each next step still open. Each node is a button
 * (the change or the step opens on the side). Wider than its card it scrolls sideways, opening at the
 * newest end; the edge that has more fades out.
 */
const props = defineProps<{ changes: ChangeLite[]; next: NextLite[]; lineId?: string }>();
const emit = defineEmits<{ change: [c: ChangeLite]; next: [n: NextLite] }>();
const scroller = ref<HTMLElement>();
const fade = ref({ left: false, right: false });
function measure() {
  const el = scroller.value;
  if (!el) return;
  fade.value = { left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 };
}
async function toEnd() {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollLeft = el.scrollWidth;
  measure();
}
onMounted(toEnd);
watch(() => [props.changes.length, props.next.length], toEnd);
const other = (c: ChangeLite) => props.lineId && c.itemId !== props.lineId ? c.itemTitle : "";
</script>

<template>
  <div v-if="changes.length || next.length" ref="scroller" class="tl" :class="{ 'fade-l': fade.left, 'fade-r': fade.right }" role="list" aria-label="最近的关键变化和下一步" @scroll.passive="measure">
    <div v-for="(c, i) in changes" :key="c.id" role="listitem" class="node" :class="[changeTone(c.type), { newest: i === changes.length - 1, 'into-next': i === changes.length - 1 && next.length }]">
      <button type="button" class="hit" :title="c.summary" @click="emit('change', c)">
        <span class="dot" aria-hidden="true" />
        <span class="when">{{ dayLabel(c.at) }}<span class="tag">{{ changeTypeLabel[c.type] ?? c.type }}</span></span>
        <span class="what">{{ c.summary }}</span>
        <span v-if="other(c)" class="where">{{ other(c) }}</span>
      </button>
    </div>
    <div v-for="n in next" :key="n.id" role="listitem" class="node next" :class="{ doing: n.status === 'doing' }">
      <button type="button" class="hit" :title="n.text" @click="emit('next', n)">
        <span class="dot" aria-hidden="true" />
        <span class="when">下一步<span class="tag">{{ n.status === "doing" ? "在做" : nextKindLabel[n.kind] }}</span></span>
        <span class="what">{{ n.text }}</span>
      </button>
    </div>
  </div>
  <p v-else class="muted small none">还没有记下的变化。</p>
</template>

<style scoped>
.tl {
  display: flex;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  padding: 2px 0 6px;
  --dot: 11px;
}
.tl.fade-l { mask-image: linear-gradient(to right, transparent, #000 40px); }
.tl.fade-r { mask-image: linear-gradient(to left, transparent, #000 40px); }
.tl.fade-l.fade-r { mask-image: linear-gradient(to right, transparent, #000 40px, #000 calc(100% - 40px), transparent); }
.node { position: relative; flex: 0 0 156px; min-width: 0; }
/* The line from this dot to the next one; dashed into and between the next steps. */
.node::after {
  content: "";
  position: absolute;
  top: calc(6px + var(--dot) / 2);
  left: calc(6px + var(--dot) + 4px);
  right: 2px;
  border-top: 1.5px solid var(--line-strong);
  pointer-events: none;
}
.node:last-child::after { display: none; }
.node.into-next::after, .node.next::after { border-top-style: dashed; }
.hit {
  all: unset;
  box-sizing: border-box;
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 6px 14px 8px 6px;
  border-radius: 8px;
  cursor: pointer;
}
.hit:hover { background: var(--hover); }
.hit:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dot {
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  background: var(--panel);
  box-sizing: border-box;
}
.warn .dot { border-color: var(--warn); }
.accent .dot { border-color: var(--accent); }
.ok .dot { border-color: var(--ok); }
.quiet .dot { border-color: var(--muted); }
.newest .dot { background: currentColor; border-color: currentColor; }
.newest { color: var(--ink); }
.newest.warn { color: var(--warn); }
.newest.accent { color: var(--accent); }
.newest.ok { color: var(--ok); }
.next .dot { border-style: dashed; border-color: var(--muted); }
.next.doing .dot { border-color: var(--accent); }
.when { display: flex; gap: 6px; align-items: baseline; font-size: 12px; color: var(--muted); white-space: nowrap; }
.tag { font-size: 11px; letter-spacing: 0.04em; }
.warn .tag { color: var(--warn); }
.accent .tag { color: var(--accent); }
.ok .tag { color: var(--ok); }
.what {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ink);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.next .what { color: var(--muted); }
.where { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.none { margin: 4px 0; }
@media (max-width: 760px) {
  .node { flex-basis: 148px; }
}
</style>
