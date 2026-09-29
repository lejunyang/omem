import { computed, ref } from "vue";
import type { TrailFrame } from "./trail";

/** Shared frame state for personal and repository knowledge readers. Rendering
 * remains unbounded; URL budgets are handled by the route serializer. */
export function useEvidenceTrail(onChange: () => void = () => {}) {
  const frames = ref<TrailFrame[]>([]), current = ref(0), open = ref(false), loopAt = ref<number | null>(null), trigger = ref<HTMLElement | null>(null);
  function push(frame: TrailFrame) {
    const found = frames.value.findIndex(f => f.kind === frame.kind && f.id === frame.id);
    if (found >= 0) { loopAt.value = found; return; }
    if (!open.value && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) trigger.value = document.activeElement;
    frames.value = [...frames.value, frame]; current.value = frames.value.length - 1; open.value = true; onChange();
  }
  function close() { frames.value = []; current.value = 0; open.value = false; loopAt.value = null; onChange(); }
  function back() { if (frames.value.length <= 1) close(); else { frames.value = frames.value.slice(0, -1); current.value = frames.value.length - 1; onChange(); } }
  function jump(index: number) { frames.value = frames.value.slice(0, index + 1); current.value = index; loopAt.value = null; onChange(); }
  return { frames, current, open, loopAt, trigger, active: computed(() => frames.value[current.value]), push, back, jump, close };
}
