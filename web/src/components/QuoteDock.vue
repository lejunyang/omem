<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import Icon from "./Icon.vue";

/**
 * The shrunk question and the gathered fix points of a run page, as a small dock that can be
 * dragged out of the way (its place is remembered). A press without a drag opens one of them.
 */
defineProps<{ ask: number; fix: number; asking: boolean }>();
const emit = defineEmits<{ ask: []; fix: [] }>();

const KEY = "omem.quoteDock";
// Distance from the bottom-right corner, so the dock stays on screen when the window shrinks.
const pos = ref<{ right: number; bottom: number }>((() => {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (p && typeof p.right === "number" && typeof p.bottom === "number") return p;
  } catch { /* private mode */ }
  return { right: 24, bottom: 24 };
})());
const clamp = (v: number, max: number) => Math.min(Math.max(8, v), Math.max(8, max));
let drag: { x: number; y: number; right: number; bottom: number; moved: boolean } | null = null;
let dragged = false;

function down(e: PointerEvent) {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, right: pos.value.right, bottom: pos.value.bottom, moved: false };
  dragged = false;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}
function move(e: PointerEvent) {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  pos.value = { right: clamp(drag.right - dx, window.innerWidth - 80), bottom: clamp(drag.bottom - dy, window.innerHeight - 60) };
}
function up() {
  window.removeEventListener("pointermove", move);
  dragged = !!drag?.moved;
  drag = null;
  if (dragged) try { localStorage.setItem(KEY, JSON.stringify(pos.value)); } catch { /* private mode */ }
}
// A drag ends with a click on the button under the pointer; that click is not a press.
function press(which: "ask" | "fix") {
  if (dragged) return void (dragged = false);
  if (which === "ask") emit("ask");
  else emit("fix");
}
onBeforeUnmount(() => window.removeEventListener("pointermove", move));
</script>

<template>
  <div class="dock" :style="{ right: `${pos.right}px`, bottom: `${pos.bottom}px` }" role="toolbar" aria-label="提问和修改点" @pointerdown="down">
    <span class="grip" title="拖动" aria-hidden="true">⋮⋮</span>
    <button v-if="asking || ask" class="btn sm" :title="asking ? '展开提问' : '有引用待提问'" @click="press('ask')">
      <Icon name="chat" :size="14" />提问<span v-if="ask" class="n">{{ ask }}</span>
    </button>
    <button v-if="fix" class="btn sm" title="查看要改的内容，开始修改" @click="press('fix')">
      <Icon name="edit" :size="14" />修改点<span class="n">{{ fix }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Above the citation drawer, so quoting from it can go on; below the selection buttons. */
.dock { position: fixed; z-index: 41; display: flex; align-items: center; gap: 6px; padding: 5px 6px 5px 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; box-shadow: var(--shadow-lg); touch-action: none; user-select: none; }
.grip { cursor: grab; color: var(--muted); font-size: 12px; letter-spacing: -2px; padding: 0 4px; }
.dock:active .grip { cursor: grabbing; }
.dock .btn { border-radius: 999px; }
.n { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; margin-left: 2px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; }
</style>
