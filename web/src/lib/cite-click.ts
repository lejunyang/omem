import { openCitation, state } from "../store";

/**
 * A click on rendered text (lib/markdown.ts): a citation opens in the citation drawer (one layer deeper
 * when the text is already inside it), a Wiki link goes to the page. Returns whether the click was taken.
 * `runId`: the text is about a coding run, so `路径:行` opens that run's file instead of an indexed original.
 */
export function citeClick(e: MouseEvent, opts: { space?: string; runId?: string; go: (path: string) => void }): boolean {
  const el = e.target as HTMLElement;
  const a = el.closest("a") as HTMLAnchorElement | null;
  if (!a) return false;
  const inDrawer = !!el.closest(".drawer");
  const cite = a.dataset.cite;
  if (cite) {
    e.preventDefault();
    const from = a.dataset.from ? Number(a.dataset.from) : undefined;
    const to = a.dataset.to ? Number(a.dataset.to) : undefined;
    const replace = !inDrawer;
    if (cite === "source" && a.dataset.uri && opts.runId) openCitation({ kind: "file", runId: opts.runId, path: a.dataset.uri, from, to }, replace);
    else if (cite === "source") openCitation(a.dataset.uri ? { kind: "source", uri: a.dataset.uri, space: opts.space ?? state.space, from, to, label: a.textContent ?? "" } : { kind: "source", id: a.dataset.ref, from, to, label: a.textContent ?? "" }, replace);
    else if (cite === "memory") openCitation({ kind: "memory", id: a.dataset.ref! }, replace);
    else if (cite === "message") openCitation({ kind: "message", id: a.dataset.ref! }, replace);
    return true;
  }
  if (a.dataset.wiki) {
    e.preventDefault();
    const target = a.dataset.wiki;
    const [space, slug] = target.includes(":") ? target.split(":") : [opts.space ?? state.space, target];
    if (inDrawer) openCitation({ kind: "page", space, slug });
    else opts.go(`/wiki/${space}/${slug}`);
    return true;
  }
  return false;
}
