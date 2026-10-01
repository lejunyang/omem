<script setup lang="ts">
/** Controlled centered modal that hosts an unbounded drill-down stack (trail).
 * Uses a native <dialog showModal> so the browser provides a real focus trap
 * (Tab cannot escape to the background) and Esc/cancel semantics, matching the
 * OmDialog / EvidenceReader contract. Backdrop styling is via ::backdrop.
 *
 * Loop detection: the parent calls `noticeLoop(existingIndex)` when it tries
 * to push a frame already in the stack; we show a warning with jump/stay. */
import { ref, watch, nextTick, onBeforeUnmount, onMounted } from "vue";
import OmButton from "./OmButton.vue";
import OmIcon from "./OmIcon.vue";
import type { TrailFrame } from "../trail";

const props = defineProps<{
  open: boolean;
  frames: TrailFrame[];
  current: number;
  loopAt?: number | null;
  /** Element that triggered the trail; focus returns here on full close. */
  returnFocusTo?: HTMLElement | null;
}>();

const emit = defineEmits<{
  close: [];
  back: [];
  jump: [index: number];
  dismissLoop: [];
}>();

const dialog = ref<HTMLDialogElement>();
const scrollEl = ref<HTMLElement>();
const titleEl = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;

watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (open && !dialog.value?.open) {
      previousFocus = document.activeElement as HTMLElement;
      dialog.value?.showModal();
      await nextTick();
      titleEl.value?.focus({ preventScroll: true });
    } else if (!open && dialog.value?.open) {
      dialog.value.close();
      await nextTick();
      const target = props.returnFocusTo?.isConnected ? props.returnFocusTo : previousFocus;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  },
  { immediate: true },
);

// Hold the saved position while asynchronous Markdown/code grows back into place.
// Scroll events caused by replacing content must not overwrite the previous frame.
const contentEl = ref<HTMLElement>();
let shownFrame: TrailFrame | undefined;
let restoring: number | null = null;
let resizeObserver: ResizeObserver | undefined;
function restoreScroll() {
  if (restoring === null || !scrollEl.value) return;
  scrollEl.value.scrollTop = restoring;
}
watch(
  () => props.frames[props.current],
  async (frame) => {
    if (shownFrame && scrollEl.value && restoring === null) shownFrame.scroll = scrollEl.value.scrollTop;
    shownFrame = frame;
    restoring = frame?.scroll ?? 0;
    await nextTick();
    restoreScroll();
    titleEl.value?.focus({ preventScroll: true });
  },
  { immediate: true, flush: "pre" },
);
function takeScrollControl() {
  restoring = null;
}
onMounted(() => {
  resizeObserver = new ResizeObserver(restoreScroll);
  if (contentEl.value) resizeObserver.observe(contentEl.value);
});

function onCancel(ev: Event) {
  // Native Esc fires cancel. Pop a layer if we can, else close.
  ev.preventDefault();
  if (props.frames.length > 1) emit("back");
  else emit("close");
}

function onScroll() {
  const f = props.frames[props.current];
  if (f && scrollEl.value && restoring === null) f.scroll = scrollEl.value.scrollTop;
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (dialog.value?.open) dialog.value.close();
  if (previousFocus?.isConnected) previousFocus.focus();
});

const parentTitle = () =>
  props.current > 0 ? props.frames[props.current - 1]?.title : "";
</script>

<template>
  <dialog
    ref="dialog"
    class="om-trail"
    aria-label="证据路径"
    @cancel="onCancel"
    @click="(e) => { if (e.target === dialog) emit('close'); }"
  >
    <div class="om-trail-panel">
      <header class="trail-top">
        <div class="trail-top-left">
          <OmIcon name="layers" />
          <b>证据路径</b>
          <span class="layer-chip">第 {{ frames.length }} 层</span>
        </div>
        <OmButton variant="ghost" aria-label="关闭全部" @click="emit('close')">
          <OmIcon name="close" />
        </OmButton>
      </header>

      <nav class="trail-breadcrumb" aria-label="证据路径">
        <template v-for="(f, i) in frames" :key="i">
          <button
            class="crumb"
            :class="{ active: i === current }"
            :aria-current="i === current ? 'step' : undefined"
            :disabled="i > current"
            :title="f.title"
            @click="i < current && emit('jump', i)"
          >{{ i + 1 }} {{ f.title }}</button>
          <span v-if="i < frames.length - 1" class="sep">›</span>
        </template>
      </nav>

      <button
        v-if="current > 0"
        class="parent-peek"
        @click="emit('back')"
      >
        <OmIcon name="back" /> 来自第 {{ current }} 层 {{ parentTitle() }}
      </button>

      <div v-if="loopAt !== null && loopAt !== undefined" class="loop-notice" role="alert">
        <p>这份材料已在路径第 {{ loopAt + 1 }} 层。</p>
        <div class="row">
          <OmButton variant="primary" @click="emit('jump', loopAt); emit('dismissLoop')">返回已打开的那一层</OmButton>
          <OmButton variant="ghost" @click="emit('dismissLoop')">留在当前层</OmButton>
        </div>
      </div>

      <h2 ref="titleEl" class="frame-title" tabindex="-1">{{ frames[current]?.title }}</h2>

      <div ref="scrollEl" class="trail-scroll" @scroll="onScroll" @wheel.passive="takeScrollControl" @touchstart.passive="takeScrollControl" @pointerdown="takeScrollControl" @keydown="takeScrollControl">
        <div ref="contentEl"><slot /></div>
      </div>

      <footer class="trail-foot">
        <OmButton v-if="frames.length > 1" variant="ghost" @click="emit('back')">
          <OmIcon name="back" /> 返回上一层
        </OmButton>
        <OmButton v-else variant="ghost" @click="emit('close')">
          返回阅读
        </OmButton>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.om-trail {
  padding: 0;
  border: 1px solid var(--om-line, #e6e6e6);
  border-radius: 12px;
  width: min(860px, 100%);
  height: min(840px, calc(100dvh - 80px));
  max-width: none;
  max-height: none;
  background: var(--om-panel, #fff);
  color: var(--om-ink, #202020);
  box-shadow: 0 24px 80px #0005;
}
.om-trail::backdrop {
  background: rgba(23, 23, 23, 0.42);
  backdrop-filter: blur(2px);
}
.om-trail-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.trail-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--om-line, #e6e6e6);
}
.trail-top-left { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.layer-chip {
  font-size: 11px;
  background: var(--om-soft, #f2f2f2);
  border: 1px solid var(--om-line, #e6e6e6);
  border-radius: 999px;
  padding: 1px 9px;
  color: var(--om-secondary, #606060);
}
.trail-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding: 8px 16px;
  border-bottom: 1px solid var(--om-line, #e6e6e6);
  font-size: 12px;
  white-space: nowrap;
  margin: 0;
}
.crumb {
  border: 0;
  background: transparent;
  padding: 4px 6px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--om-secondary, #606060);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb:not(:disabled):hover { background: var(--om-soft, #f2f2f2); cursor: pointer; }
.crumb.active { color: var(--om-ink, #202020); font-weight: 600; }
.crumb:disabled { cursor: default; }
.sep { color: var(--om-muted, #9a9a9a); }
.parent-peek {
  margin: 8px 16px 0;
  border: 1px solid var(--om-line, #e6e6e6);
  background: var(--om-soft, #fafafa);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--om-secondary, #606060);
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  width: auto;
  cursor: pointer;
}
.parent-peek:hover { border-color: var(--om-muted, #9a9a9a); }
.frame-title {
  margin: 12px 16px 0;
  font-family: "Noto Serif CJK SC", "Songti SC", Georgia, serif;
  font-size: 20px;
  outline: none;
}
.loop-notice {
  margin: 10px 16px 0;
  padding: 10px 12px;
  border: 1px solid #e3d5b8;
  background: #faf1e3;
  border-radius: 8px;
}
.loop-notice p { margin: 0 0 8px; font-size: 13px; }
.row { display: flex; gap: 8px; }
.trail-scroll { flex: 1; overflow: auto; min-height: 0; padding: 14px 16px; }
.trail-foot {
  border-top: 1px solid var(--om-line, #e6e6e6);
  padding: 10px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
@media (max-width: 700px) {
  .om-trail { width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
}
</style>
