import type { App } from "vue";

/** Keep IME keystrokes out of component handlers and application shortcuts. */
export function compositionGuard(app: App) {
  const composing = new WeakSet<EventTarget>();
  let confirmingForm: HTMLFormElement | null = null;
  let resetForm: ReturnType<typeof setTimeout> | undefined;
  const start = (e: CompositionEvent) => { if (e.target) composing.add(e.target); };
  const end = (e: Event) => { if (e.target) composing.delete(e.target); };
  const onKey = (e: KeyboardEvent) => {
    // Some IMEs omit isComposing; Safari may end composition before the confirming
    // keydown and report only keyCode 229. Track events as well as both flags.
    if (e.isComposing || e.keyCode === 229 || (e.target && composing.has(e.target))) {
      if (e.type === "keydown" && e.key === "Enter") {
        confirmingForm = (e.target as HTMLInputElement | null)?.form ?? null;
        clearTimeout(resetForm);
        resetForm = setTimeout(() => { confirmingForm = null; }, 0);
      }
      // Leave the default action to the IME (confirming/cancelling/selecting a word).
      // Capture on window also covers Teleports, parent handlers and global shortcuts.
      e.stopImmediatePropagation();
    }
  };
  const onSubmit = (e: SubmitEvent) => {
    // Propagation alone does not cancel a single-line input's implicit form submit.
    if (confirmingForm && e.target === confirmingForm) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener("compositionstart", start, true);
  window.addEventListener("compositionend", end, true);
  // Losing focus can cancel composition without a compositionend event.
  window.addEventListener("blur", end, true);
  window.addEventListener("submit", onSubmit, true);
  const keys = ["keydown", "keypress", "keyup"] as const;
  for (const key of keys) window.addEventListener(key, onKey, true);
  app.onUnmount(() => {
    window.removeEventListener("compositionstart", start, true);
    window.removeEventListener("compositionend", end, true);
    window.removeEventListener("blur", end, true);
    window.removeEventListener("submit", onSubmit, true);
    clearTimeout(resetForm);
    for (const key of keys) window.removeEventListener(key, onKey, true);
  });
}
