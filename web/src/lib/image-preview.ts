import { reactive } from "vue";

/** One picture in the in-page preview: its address and what to say under it. */
export type PreviewImage = { url: string; caption?: string; name?: string };

/** The one preview the app shows (components/ImagePreview.vue, mounted in App.vue). */
export const preview = reactive<{ list: PreviewImage[]; index: number; opener: HTMLElement | null }>({ list: [], index: -1, opener: null });

/** Opens `list` at `index` in place of a new tab; ← → go through the list, Esc closes. */
export function openImages(list: PreviewImage[], index = 0) {
  if (!list.length) return;
  if (preview.index < 0) preview.opener = document.activeElement as HTMLElement | null;
  preview.list = list;
  preview.index = Math.min(Math.max(index, 0), list.length - 1);
}

export function closePreview() {
  preview.index = -1;
  preview.list = [];
  const back = preview.opener;
  preview.opener = null;
  back?.focus?.();
}

/**
 * Pictures inside rendered text (Markdown, a diff): clicking one opens all of that block's pictures,
 * starting at it. Returns true when it handled the click.
 */
export function previewFromClick(e: MouseEvent, root: HTMLElement | undefined) {
  const img = (e.target as HTMLElement).closest?.("img");
  if (!img || !root || !root.contains(img) || img.closest("[data-no-preview]")) return false;
  const imgs = [...root.querySelectorAll<HTMLImageElement>("img")].filter((i) => !i.closest("[data-no-preview]") && !!(i.currentSrc || i.src));
  e.preventDefault();
  openImages(imgs.map((i) => ({ url: i.currentSrc || i.src, caption: i.title || i.alt })), Math.max(0, imgs.indexOf(img as HTMLImageElement)));
  return true;
}
