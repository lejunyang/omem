/**
 * Route-level preloading: lazy chunks are fetched ahead of the click, so the
 * menu no longer shows a blank panel while the view's JS/CSS arrives.
 *
 * - The current view is always loaded first; once it settles, every other
 *   route chunk is prefetched at idle (the SPA shell is tiny, this is cheap).
 * - Hovering (or focusing) a nav link prefetches that route immediately.
 */
import type { RouteLocationRaw } from "vue-router";

type Loader = () => Promise<unknown>;
const loaders = new Map<string, Loader>();
const started = new Set<string>();

export function registerPreload(path: string, loader: Loader) {
  loaders.set(path, loader);
}

export function preloadRoute(path: string) {
  const loader = loaders.get(path);
  if (!loader || started.has(path)) return;
  started.add(path);
  void loader().catch(() => started.delete(path));
}

/** Tell Vue the component import is also the preload entry. */
export function preloadable(path: string, loader: Loader) {
  registerPreload(path, loader);
  return loader;
}

export function preloadWhenIdle(paths: RouteLocationRaw[] = []) {
  const go = () => {
    for (const p of paths.map(String)) preloadRoute(p);
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 1500);
}
