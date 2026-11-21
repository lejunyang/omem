import { nextTick } from "vue";

/**
 * Land on one thing of a page that was opened from the progress view (`?task=`, `?stage=`…): scroll it
 * into view, open it when it folds, and mark it for a moment. Nothing happens when it is not there.
 */
export async function landOn(id: string, tries = 10) {
  for (let i = 0; i < tries; i++) {
    await nextTick();
    const el = document.getElementById(id);
    if (el) {
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("landing");
      setTimeout(() => el.classList.remove("landing"), 2400);
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
