<script setup lang="ts">
/** Controlled single floating drawer that hosts an unbounded drill-down stack
 * (trail). It is NOT a modal: the background code stays visible, so `role` is
 * dialog + aria-modal=false. The parent owns the frames and the per-frame data;
 * this component owns the chrome — breadcrumb, back, Esc, loop warning, focus
 * and scroll restoration.
 *
 * Loop detection: the parent calls `noticeLoop(existingIndex)` when it tries to
 * push a frame whose id is already in the stack; the drawer shows a warning
 * with jump/stay buttons instead of silently pushing a 6th frame.
 */
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import OmButton from "./OmButton.vue";
import OmIcon from "./OmIcon.vue";
import type { TrailFrame } from "../trail";

const props = defineProps<{
  open: boolean;
  frames: TrailFrame[];
  current: number;
  /** Set when a push would revisit a frame already in the stack. */
  loopAt?: number | null;
}>();

const emit = defineEmits<{
  close: [];
  back: [];
  jump: [index: number];
  dismissLoop: [];
}>();

const panel = ref<HTMLElement>();
const scrollEl = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;

watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (open) {
      previousFocus = document.activeElement as HTMLElement;
      panel.value?.setAttribute("tabindex", "-1");
      panel.value?.focus({ preventScroll: true });
    } else if (previousFocus?.isConnected) {
      previousFocus.focus();
    }
  },
);

// Restore scroll for the frame we just switched to.
watch(
  () => props.current,
  async (i) => {
    await nextTick();
    const target = props.frames[i];
    if (scrollEl.value && target) scrollEl.value.scrollTop = target.scroll ?? 0;
  },
  { immediate: true },
);

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    if (props.frames.length > 1) emit("back");
    else emit("close");
  }
}

function onScroll() {
  const f = props.frames[props.current];
  if (f && scrollEl.value) f.scroll = scrollEl.value.scrollTop;
}

onBeforeUnmount(() => {
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>

<template>
  <div v-if="open" class="om-trail" role="dialog" aria-modal="false" aria-label="证据路径"
    @keydown="onKeydown">
    <div ref="panel" class="om-trail-panel" tabindex="-1">
      <header class="trail-head">
        <div class="crumbs" aria-label="证据路径">
          <OmButton v-if="frames.length > 1" variant="ghost" class="back-btn" aria-label="返回上一层"
            @click="emit('back')">
            <OmIcon name="back" /><small>返回</small>
          </OmButton>
          <button
            v-for="(f, i) in frames"
            :key="i"
            class="crumb"
            :class="{ active: i === current }"
            :title="f.title"
            @click="i < current && emit('jump', i)"
          >{{ i + 1 }}<small>{{ f.title }}</small></button>
        </div>
        <OmButton variant="ghost" aria-label="关闭抽屉" @click="emit('close')">
          <OmIcon name="close" />
        </OmButton>
      </header>

      <div v-if="loopAt !== null && loopAt !== undefined" class="loop-notice" role="alert">
        <p>你已经在第 {{ loopAt + 1 }} 层看过这条材料。</p>
        <div class="row">
          <OmButton variant="primary" @click="emit('jump', loopAt); emit('dismissLoop')">跳回该层</OmButton>
          <OmButton variant="ghost" @click="emit('dismissLoop')">留在当前层</OmButton>
        </div>
      </div>

      <div ref="scrollEl" class="trail-scroll" @scroll="onScroll">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.om-trail {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(560px, 100vw);
  z-index: 60;
  display: flex;
  justify-content: flex-end;
}
.om-trail-panel {
  width: 100%;
  height: 100%;
  background: var(--om-panel);
  border-left: 1px solid var(--om-line);
  box-shadow: -10px 0 40px #0002;
  display: flex;
  flex-direction: column;
  outline: none;
}
.trail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--om-line);
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.back-btn {
  min-height: 36px !important;
}
.crumb {
  border: 1px solid var(--om-line);
  background: var(--om-soft);
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 12px;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 140px;
}
.crumb.active {
  background: var(--om-ink);
  color: #fff;
}
.crumb small {
  font-size: 10px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
}
.loop-notice {
  margin: 10px 12px 0;
  padding: 10px 12px;
  border: 1px solid #e3d5b8;
  background: #faf1e3;
  border-radius: 6px;
}
.loop-notice p {
  margin: 0 0 8px;
  font-size: 13px;
}
.row {
  display: flex;
  gap: 8px;
}
.trail-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 16px;
}
@media (max-width: 700px) {
  .om-trail {
    width: 100vw;
  }
}
</style>
