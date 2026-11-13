/**
 * Component blocks (docs/v2/interactive-ui.md), rendered without a framework so omem's web pages,
 * the shell's default plugin page and any plugin page draw them the same way:
 *
 * - `renderView`: display components (Markdown, heading, table, chart, metric, compare, timeline).
 * - `renderBlock`: a block of a plugin session — kind "view" (what an agent showed) or "ask" (its
 *   question, with a form when it has fields). omem's own pages draw a question's fields with their
 *   own controls (web/src/components/UiFields.vue); plugin pages use the plain ones here.
 *
 * Text goes in through textContent only, unless the caller passes a Markdown renderer that
 * sanitizes. Colors come from omem's tokens; series colors are the validated categorical slots for
 * light and dark surfaces.
 */
export type BlockView = { id: string; kind: string; status: "open" | "submitted" | "shown"; data: any; answers: Record<string, unknown> | null; result: any };

/** Block kinds the host draws (the rest are a plugin's own, e.g. the English plugin's quiz). */
export const GENERIC_KINDS = ["ask", "view"];

export type Card = { id: string; title: string; summary?: string; pros?: string[]; cons?: string[] };
/** `good`: which way is good news (up by default); `trend` is read off the change's sign when not given; `spark` is its recent course. */
export type Metric = { label: string; value: string | number; unit?: string; change?: string; trend?: "up" | "down" | "flat"; good?: "up" | "down" | "none"; note?: string; spark?: number[] };
export type ViewComponent =
  | { type: "markdown"; text: string }
  | { type: "heading"; text: string }
  | { type: "table"; title?: string; columns: string[]; rows: (string | number | boolean | null)[][]; note?: string }
  | { type: "chart"; title: string; kind: "bar" | "line" | "area" | "hbar" | "pie"; labels: string[]; series: { name: string; values: number[] }[]; stack?: boolean; goal?: number; unit?: string; note?: string }
  | { type: "metric"; title?: string; items: Metric[]; note?: string }
  | { type: "callout"; tone: "info" | "success" | "warning" | "danger" | "neutral"; title?: string; text: string }
  | { type: "compare"; title?: string; items: Card[] }
  | { type: "timeline"; items: { time: string; title: string; text?: string }[] }
  /** An interactive page (`ui_page`): drawn by omem's own pages only; elsewhere a line that says where to open it. */
  | { type: "page"; id: string; version?: number; height?: number; title?: string };
type ShowIf = { field: string; equals?: string | number | boolean; in?: string[] };
export type UiField = { id: string; label: string; help?: string; required?: boolean; show_if?: ShowIf } & (
  | { type: "text" | "textarea"; placeholder?: string; default?: string }
  | { type: "number"; min?: number; max?: number; default?: number }
  | { type: "choice"; options: string[]; default?: string }
  | { type: "multi"; options: string[]; default?: string[] }
  | { type: "scale" | "date" | "datetime" }
  | { type: "toggle"; default?: boolean }
  | { type: "pick"; items: Card[] }
  | { type: "checklist"; items: { id: string; title: string; detail?: string }[]; choices: string[]; note: boolean }
  | { type: "rank"; items: { id: string; title: string; detail?: string }[] }
  | { type: "table"; columns: { id: string; label: string; type: "text" | "number" | "choice"; options?: string[] }[]; rows: Record<string, string | number | null>[]; max_rows: number }
);

export type RenderOptions = {
  /** Draw Markdown into an element (sanitized by the caller); plain text with line breaks otherwise. */
  markdown?: (el: HTMLElement, source: string) => void;
};

// Buttons, inputs and the card are omem's own classes (web/src/styles.css, /plugins/_sdk/omem.css for
// plain HTML pages); only the layout and the charts are here.
const CSS = `
.ob { display: grid; gap: 12px; min-width: 0; color: var(--ink); }
.ob h3 { margin: 0; font: 600 16px/1.35 var(--serif); }
.ob h4 { margin: 4px 0 0; font: 600 14.5px/1.4 var(--serif); }
.ob p { margin: 0; }
.ob .ob-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.ob .ob-muted { color: var(--muted); font-size: 12.5px; }
.ob .ob-field { display: grid; gap: 6px; min-width: 0; }
.ob .ob-label { font-weight: 550; overflow-wrap: anywhere; }
.ob .ob-req { color: var(--danger); margin-left: 2px; }
.ob .ob-options { display: flex; flex-wrap: wrap; gap: 6px; }
.ob .ob-opt { border-radius: 999px; font-weight: 400; }
.ob .ob-opt[aria-pressed="true"], .ob .ob-opt[aria-checked="true"], .ob .ob-opt[aria-pressed="true"]:hover, .ob .ob-opt[aria-checked="true"]:hover { border-color: var(--ink); background: var(--ink); color: var(--bg); }
.ob .ob-field > button, .ob .ob-field > input[type="number"], .ob .ob-field > input[type="date"], .ob .ob-field > input[type="datetime-local"] { justify-self: start; }
.ob .ob-field > input[type="number"] { width: 200px; max-width: 100%; }
.ob .ob-field > input[type="date"], .ob .ob-field > input[type="datetime-local"] { width: auto; max-width: 100%; }
.ob .ob-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ob .ob-spacer { flex: 1; }
.ob .ob-err { color: var(--danger); font-size: 12.5px; }
.ob .ob-value { color: var(--ink-2); overflow-wrap: anywhere; white-space: pre-wrap; }
.ob .ob-chart { gap: 8px; }
.ob .ob-chart-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ob .ob-plot { position: relative; outline: none; border-radius: 6px; }
.ob .ob-plot:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.ob .ob-plot > svg { width: 100%; height: auto; display: block; overflow: visible; touch-action: pan-y; }
.ob .ob-axis { stroke: var(--line-strong); stroke-width: 1; }
.ob .ob-grid { stroke: var(--line); stroke-width: 1; opacity: .8; }
.ob .ob-goal { stroke: var(--ink-2); stroke-width: 1; opacity: .55; }
.ob .ob-cross { stroke: var(--line-strong); stroke-width: 1; }
.ob .ob-wash { fill: var(--hover); }
.ob .ob-tick { fill: var(--muted); font-size: 11px; font-family: var(--sans); }
.ob .ob-value { fill: var(--ink-2); font-size: 11px; font-weight: 550; font-family: var(--sans); }
.ob .ob-rowlabel { fill: var(--ink-2); font-size: 12px; font-family: var(--sans); }
.ob .ob-total { fill: var(--ink); font-size: 22px; font-weight: 650; font-family: var(--sans); }
.ob .ob-ring { stroke: var(--panel); stroke-width: 2; }
.ob .ob-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--ink-2); }
.ob .ob-key { display: inline-flex; align-items: center; gap: 6px; }
.ob .ob-key i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.ob .ob-key i.line { height: 2px; width: 14px; border-radius: 1px; }
.ob .ob-tip { position: absolute; z-index: 3; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 7px 10px; font-size: 12px; line-height: 1.5; min-width: 110px; white-space: nowrap; }
.ob .ob-tip-title { color: var(--muted); margin-bottom: 2px; }
.ob .ob-tip-row { display: flex; align-items: center; gap: 8px; }
.ob .ob-tip-row i { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.ob .ob-tip-row i.line { height: 2px; width: 12px; }
.ob .ob-tip-row b { color: var(--ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.ob .ob-tip-row span { color: var(--ink-2); }
.ob .ob-donut-wrap { display: grid; grid-template-columns: 176px minmax(0, 1fr); gap: 20px; align-items: center; }
.ob .ob-donut-wrap.narrow { grid-template-columns: minmax(0, 1fr); justify-items: center; }
.ob .ob-donut { width: 176px; height: 176px; display: block; }
.ob .ob-slice { stroke: var(--panel); stroke-width: 2; transition: opacity .15s; }
.ob .ob-slice.dim { opacity: .3; }
.ob .ob-parts { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; width: 100%; font-size: 13px; }
.ob .ob-parts li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 52px; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 6px; }
.ob .ob-parts li.on { background: var(--hover); }
.ob .ob-parts i { width: 10px; height: 10px; border-radius: 3px; }
.ob .ob-part-name { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ob .ob-part-value { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.ob .ob-part-share { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
.ob .ob-callout { --c: var(--accent); display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 14px; border-radius: 8px; background: var(--sunken); }
.ob .ob-callout[data-tone="success"] { --c: var(--ok); }
.ob .ob-callout[data-tone="warning"] { --c: var(--warn); }
.ob .ob-callout[data-tone="danger"] { --c: var(--danger); }
.ob .ob-callout[data-tone="neutral"] { --c: var(--muted); }
.ob .ob-callout-icon { width: 16px; height: 16px; margin-top: 4px; fill: none; stroke: var(--c); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ob .ob-callout-body { display: grid; gap: 2px; min-width: 0; }
.ob .ob-callout-body > b { color: var(--ink); font-weight: 650; }
.ob .ob-callout-body .prose > :first-child, .ob .ob-callout-body .prose > :last-child { margin-top: 0; margin-bottom: 0; }
.ob details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
.ob .ob-scroll { overflow-x: auto; max-width: 100%; }
.ob table { border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
.ob th, .ob td { border-bottom: 1px solid var(--line); padding: 4px 12px 4px 0; text-align: left; font-weight: 400; vertical-align: top; }
.ob thead th { color: var(--muted); font-weight: 550; white-space: nowrap; }
.ob thead th button { all: unset; cursor: pointer; }
.ob thead th button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ob td.num { text-align: right; font-variant-numeric: tabular-nums; }
.ob .ob-mgroup { container-type: inline-size; }
.ob .ob-metrics { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); gap: 10px; }
@container (max-width: 520px) { .ob .ob-metrics { grid-template-columns: repeat(var(--cols-narrow, 2), minmax(0, 1fr)); } }
.ob .ob-metric { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px 10px; display: grid; gap: 3px; align-content: start; min-width: 0; background: var(--panel); }
.ob .ob-mlabel { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.ob .ob-mvalue { display: flex; align-items: baseline; gap: 4px; min-width: 0; }
.ob .ob-mvalue b { font: 600 24px/1.2 var(--sans); letter-spacing: -0.01em; color: var(--ink); overflow-wrap: anywhere; }
.ob .ob-mvalue span { color: var(--muted); font-size: 13px; }
.ob .ob-mfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; }
.ob .ob-delta { font-weight: 550; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.ob .ob-delta[data-tone="good"] { color: var(--ok); }
.ob .ob-delta[data-tone="bad"] { color: var(--danger); }
.ob .ob-spark { width: 100%; max-width: 160px; height: 24px; display: block; margin-top: 2px; }
.ob .ob-spark-line { fill: none; stroke: var(--s1); opacity: .85; stroke-width: 1.25; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
.ob .ob-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.ob .ob-pcard { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: grid; gap: 6px; align-content: start; min-width: 0; background: var(--panel); text-align: left; font: inherit; color: inherit; }
.ob button.ob-pcard { cursor: pointer; }
.ob button.ob-pcard:hover { border-color: var(--line-strong); }
.ob button.ob-pcard[aria-checked="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ob .ob-pcard ul { margin: 0; padding-left: 18px; font-size: 13px; }
.ob .ob-pcard .ob-pro { color: var(--ok, var(--ink-2)); }
.ob .ob-pcard .ob-con { color: var(--warn, var(--ink-2)); }
.ob .ob-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.ob .ob-timeline li { display: grid; grid-template-columns: minmax(64px, max-content) minmax(0, 1fr); gap: 4px 12px; }
.ob .ob-timeline time { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ob .ob-check { display: grid; gap: 6px; border-bottom: 1px solid var(--line); padding: 6px 0; }
.ob .ob-check:last-child { border-bottom: 0; }
.ob .ob-rank { list-style: none; margin: 0; padding: 0; }
.ob .ob-rank .ob-check { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.ob { --s1: #5b5bf0; --s2: #14b8c8; --s3: #ff5d73; --s4: #ee9e15; --s5: #a855f7; --s6: #17a673; --s7: #f97316; --s8: #3b9cf5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ob { --s1: #686dff; --s2: #0aa2b0; --s3: #f0587a; --s4: #c27f02; --s5: #ae5ffd; --s6: #1ca875; --s7: #e16505; --s8: #3093eb; } }
:root[data-theme="dark"] .ob { --s1: #686dff; --s2: #0aa2b0; --s3: #f0587a; --s4: #c27f02; --s5: #ae5ffd; --s6: #1ca875; --s7: #e16505; --s8: #3093eb; }
@media (max-width: 520px) { .ob .ob-mvalue b { font-size: 22px; } }
@media (max-width: 520px) { .ob .ob-timeline li { grid-template-columns: minmax(0, 1fr); } }
`;

function ensureStyle(doc: Document) {
  if (doc.getElementById("omem-block-style")) return;
  const s = doc.createElement("style");
  s.id = "omem-block-style";
  s.textContent = CSS;
  doc.head.appendChild(s);
}

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
function h(doc: Document, tag: string, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? doc.createTextNode(c) : c);
  return el;
}
const NS = "http://www.w3.org/2000/svg";
function s(doc: Document, tag: string, attrs: Record<string, string | number> = {}, text?: string) {
  const el = doc.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

const resizers = new WeakMap<HTMLElement, ResizeObserver[]>();
function forget(el: HTMLElement) {
  for (const ro of resizers.get(el) ?? []) ro.disconnect();
  resizers.delete(el);
}

/** Draw `block` into `el` (replacing what is there). False when the kind is not a host block. */
export function renderBlock(el: HTMLElement, block: BlockView, opts: { submit: (answers: Record<string, unknown>) => Promise<void> } & RenderOptions) {
  if (!GENERIC_KINDS.includes(block.kind)) return false;
  ensureStyle(el.ownerDocument);
  forget(el);
  if (block.kind === "view") {
    const d = block.data as { title?: string; components: ViewComponent[] };
    const box = h(el.ownerDocument, "section", { class: "ob card pad", "aria-label": d.title || "展示" });
    el.replaceChildren(box);
    if (d.title) box.append(h(el.ownerDocument, "h3", {}, d.title));
    const inner = h(el.ownerDocument, "div", { class: "ob" });
    box.append(inner);
    renderView(inner, d.components, opts, el);
    return true;
  }
  el.replaceChildren(ask(el, block, opts));
  return true;
}

/** Draw display components into `el` (replacing what is there). */
export function renderView(el: HTMLElement, components: ViewComponent[], opts: RenderOptions = {}, owner: HTMLElement = el) {
  const doc = el.ownerDocument;
  ensureStyle(doc);
  if (owner === el) forget(el);
  el.classList.add("ob");
  el.replaceChildren(...components.map((c) => component(doc, c, opts, owner)));
}

function component(doc: Document, c: ViewComponent, opts: RenderOptions, owner: HTMLElement): HTMLElement {
  switch (c.type) {
    case "markdown":
      return text(doc, c.text, opts);
    case "heading":
      return h(doc, "h4", {}, c.text);
    case "table":
      return table(doc, c);
    case "chart":
      return chartBox(doc, c, owner);
    case "metric": {
      // Rows as even as the count allows: up to four in one row, then threes or fours; two to a row when narrow.
      const n = c.items.length;
      const cols = n <= 4 ? n : n <= 6 ? 3 : 4;
      return h(doc, "div", { class: "ob-field ob-mgroup" }, c.title ? h(doc, "span", { class: "ob-label" }, c.title) : null, h(doc, "div", { class: "ob-metrics", style: `--cols:${cols};--cols-narrow:${Math.min(2, n)}` }, ...c.items.map((m) => metric(doc, m))), c.note ? h(doc, "p", { class: "ob-muted" }, c.note) : null);
    }
    case "callout":
      return callout(doc, c, opts);
    case "compare":
      return h(doc, "div", { class: "ob-field" }, c.title ? h(doc, "span", { class: "ob-label" }, c.title) : null, h(doc, "div", { class: "ob-cards" }, ...c.items.map((i) => cardBody(doc, h(doc, "div", { class: "ob-pcard" }), i))));
    case "page":
      return h(doc, "p", { class: "ob-muted" }, `交互页“${c.title || c.id}”：在 omem 的问答页里打开`);
    case "timeline":
      return h(doc, "ol", { class: "ob-timeline" }, ...c.items.map((i) => h(doc, "li", {}, h(doc, "time", {}, i.time), h(doc, "div", {}, h(doc, "div", { class: "ob-label" }, i.title), i.text ? h(doc, "p", { class: "ob-muted ob-text" }, i.text) : null))));
  }
}

function text(doc: Document, source: string, opts: RenderOptions) {
  const el = h(doc, "div", { class: "ob-md" });
  if (opts.markdown) opts.markdown(el, source);
  else {
    el.classList.add("ob-text");
    el.textContent = source;
  }
  return el;
}

function cardBody(doc: Document, el: HTMLElement, c: Card) {
  const parts = [
    h(doc, "span", { class: "ob-label" }, c.title),
    c.summary ? h(doc, "p", { class: "ob-text" }, c.summary) : null,
    c.pros?.length ? h(doc, "ul", { "aria-label": "优点" }, ...c.pros.map((p) => h(doc, "li", { class: "ob-pro" }, p))) : null,
    c.cons?.length ? h(doc, "ul", { "aria-label": "代价" }, ...c.cons.map((p) => h(doc, "li", { class: "ob-con" }, p))) : null,
  ];
  el.append(...parts.filter((x): x is HTMLElement => !!x));
  return el;
}

/** Which way a metric moved: as given, else read off the start of its change (src/agents/ui-blocks.ts, metricTrend). */
function trendOf(m: Metric): "up" | "down" | "flat" | null {
  if (m.trend) return m.trend;
  const c = m.change?.trim();
  if (!c) return null;
  if (/^[+＋↑▲]/.test(c)) return /^[+＋]\s*0+(\.0+)?(?![\d.])/.test(c) ? "flat" : "up";
  if (/^[-−–↓▼]/.test(c)) return /^[-−–]\s*0+(\.0+)?(?![\d.])/.test(c) ? "flat" : "down";
  return /^(持平|不变|0+(\.0+)?%?$)/.test(c) ? "flat" : null;
}

/** A recent course as a small line in the first series colour. */
function spark(doc: Document, values: number[]) {
  const W = 120, H = 30, P = 3;
  // A small wobble stays small: the line spans at least a fifth of the level it moves around.
  const mid = (Math.min(...values) + Math.max(...values)) / 2;
  const span = Math.max(Math.max(...values) - Math.min(...values), Math.abs(mid) * 0.2) || 1;
  const lo = mid - span / 2, hi = mid + span / 2;
  const x = (i: number) => P + ((W - 2 * P) * i) / (values.length - 1);
  const y = (v: number) => (hi === lo ? H / 2 : P + (H - 2 * P) * (1 - (v - lo) / (hi - lo)));
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "ob-spark", "aria-hidden": "true" });
  svg.append(s(doc, "path", { d: smooth(pts), class: "ob-spark-line" }));
  return svg;
}

/** A metric tile: its label, the figure, the change (arrow, and green or red by whether that way is good) with its basis, and its recent course. */
function metric(doc: Document, m: Metric) {
  const t = trendOf(m);
  const tone = !t ? "" : t === "flat" || m.good === "none" ? "neutral" : t === (m.good ?? "up") ? "good" : "bad";
  const change = m.change?.trim();
  const arrow = change && t && !/^[↑↓→▲▼]/.test(change) ? `${{ up: "↑", down: "↓", flat: "→" }[t]} ` : "";
  return h(
    doc,
    "div",
    { class: "ob-metric" },
    h(doc, "span", { class: "ob-mlabel" }, m.label),
    h(doc, "div", { class: "ob-mvalue" }, h(doc, "b", {}, String(m.value)), m.unit?.trim() ? h(doc, "span", {}, m.unit.trim()) : null),
    change || m.note ? h(doc, "div", { class: "ob-mfoot" }, change ? h(doc, "span", { class: "ob-delta", "data-tone": tone || "neutral" }, `${arrow}${change}`) : null, m.note ? h(doc, "span", { class: "ob-muted" }, m.note) : null) : null,
    m.spark && m.spark.length > 1 ? spark(doc, m.spark) : null,
  );
}

const ICONS: Record<string, string> = {
  info: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM8 7.2v3.8M8 5v.2",
  success: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM5.3 8.2l1.8 1.8 3.6-3.8",
  warning: "M8 2 14.5 13.5h-13ZM8 6.5v3.2M8 11.4v.2",
  danger: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2",
};
/** A conclusion, a risk or a note set off on a tinted surface, its kind also said by an icon. */
function callout(doc: Document, c: Extract<ViewComponent, { type: "callout" }>, opts: RenderOptions) {
  const tone = c.tone ?? "info";
  const icon = s(doc, "svg", { viewBox: "0 0 16 16", class: "ob-callout-icon", "aria-hidden": "true" });
  icon.append(s(doc, "path", { d: ICONS[tone] ?? ICONS.info }));
  const label = { info: "说明", success: "达成", warning: "注意", danger: "风险", neutral: "说明" }[tone];
  return h(doc, "div", { class: "ob-callout", "data-tone": tone, role: "note", "aria-label": label }, icon, h(doc, "div", { class: "ob-callout-body" }, c.title ? h(doc, "b", {}, c.title) : null, text(doc, c.text, opts)));
}

const isNum = (v: unknown) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

/** A table whose columns sort on click (numbers as numbers), scrolling sideways when wide. */
function table(doc: Document, c: Extract<ViewComponent, { type: "table" }>) {
  let sort: { col: number; dir: 1 | -1 } | null = null;
  const tbody = h(doc, "tbody");
  const numeric = c.columns.map((_, i) => c.rows.length > 0 && c.rows.every((r) => r[i] === null || r[i] === undefined || r[i] === "" || isNum(r[i])));
  const fill = () => {
    const rows = [...c.rows];
    if (sort) {
      const { col, dir } = sort;
      rows.sort((a, b) => {
        const x = a[col], y = b[col];
        const r = numeric[col] ? Number(x ?? -Infinity) - Number(y ?? -Infinity) : String(x ?? "").localeCompare(String(y ?? ""), "zh-CN");
        return r * dir;
      });
    }
    tbody.replaceChildren(...rows.map((r) => h(doc, "tr", {}, ...c.columns.map((_, i) => h(doc, "td", numeric[i] ? { class: "num" } : {}, r[i] === null || r[i] === undefined ? "" : String(r[i]))))));
  };
  const heads = c.columns.map((name, i) => {
    const th = h(doc, "th", { scope: "col", "aria-sort": "none" });
    const b = h(doc, "button", { type: "button", title: "排序" }, name);
    b.addEventListener("click", () => {
      sort = sort?.col === i ? (sort.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 };
      thead.querySelectorAll("th").forEach((x, j) => x.setAttribute("aria-sort", sort?.col === j ? (sort.dir === 1 ? "ascending" : "descending") : "none"));
      fill();
    });
    th.append(b);
    return th;
  });
  const thead = h(doc, "thead", {}, h(doc, "tr", {}, ...heads));
  fill();
  return h(doc, "div", { class: "ob-field" }, c.title ? h(doc, "span", { class: "ob-label" }, c.title) : null, h(doc, "div", { class: "ob-scroll" }, h(doc, "table", {}, thead, tbody)), c.note ? h(doc, "p", { class: "ob-muted" }, c.note) : null);
}

/** A chart drawn at the width it gets (redrawn when that changes), so its labels keep their real size. */
function chartBox(doc: Document, c: Extract<ViewComponent, { type: "chart" }>, owner: HTMLElement) {
  const box = h(doc, "div", { class: "ob-field ob-chart" });
  let drawnAt = 0;
  const draw = () => {
    const w = Math.max(260, Math.min(900, Math.round(box.clientWidth || owner.clientWidth || 600)));
    if (Math.abs(w - drawnAt) < 8) return;
    drawnAt = w;
    box.replaceChildren(...chart(doc, c, w));
  };
  draw();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    resizers.set(owner, [...(resizers.get(owner) ?? []), ro]);
  }
  return box;
}

/** Every digit of a value (tooltips, the data table). */
const full = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
/** A value where room is short (axis ticks, labels on marks, a donut's total): 1.2万, 3.4亿. */
function compact(n: number) {
  const a = Math.abs(n);
  const r = (x: number) => x.toLocaleString("zh-CN", { maximumFractionDigits: a >= 1e4 ? 1 : 2 });
  return a >= 1e8 ? `${r(n / 1e8)}亿` : a >= 1e4 ? `${r(n / 1e4)}万` : r(n);
}
/** One style for every tick of an axis, set by its largest: 0, 5,000, 10,000 or 0, 0.5万, 1万 — never both. */
function axisFormat(ticks: number[]) {
  const top = Math.max(...ticks.map(Math.abs));
  const [div, suffix] = top >= 1e8 ? [1e8, "亿"] : top >= 1e4 ? [1e4, "万"] : [1, ""];
  return (v: number) => (v === 0 ? "0" : `${(v / div).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`);
}
const color = (i: number) => `var(--s${(i % 8) + 1})`;
/** Rough rendered width of a label at 11–12px (CJK twice as wide), for laying out before drawing. */
const textW = (t: string, px = 11.5) => Array.from(t).reduce((n, ch) => n + (ch.codePointAt(0)! > 0xff ? px : px * 0.6), 0);
function clip(t: string, maxW: number) {
  if (textW(t) <= maxW) return t;
  const chars = Array.from(t);
  while (chars.length > 1 && textW(chars.join("") + "…") > maxW) chars.pop();
  return chars.join("") + "…";
}

/** Round ticks (steps of 1, 2, 2.5 or 5 × 10ⁿ) covering [lo, hi], about `count` of them. */
function niceScale(lo: number, hi: number, count = 4) {
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  const span = hi - lo;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { min, max, ticks };
}

/** A smooth path through the points that never overshoots them (monotone cubic). */
function smooth(pts: [number, number][]) {
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const n = pts.length;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
  const t = pts.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])));
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx[i] / 3;
    d += ` C${pts[i][0] + h3},${pts[i][1] + t[i] * h3} ${pts[i + 1][0] - h3},${pts[i + 1][1] - t[i + 1] * h3} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/** A bar with its data end rounded and its baseline end square; `dir` is where the data end points. */
function barPath(x: number, y: number, w: number, hgt: number, dir: "up" | "down" | "right" | "left", r = 4) {
  const q = Math.max(0, Math.min(r, w / 2, hgt));
  if (q < 0.5) return `M${x},${y} h${w} v${hgt} h${-w} Z`;
  switch (dir) {
    case "up":
      return `M${x},${y + hgt} V${y + q} Q${x},${y} ${x + q},${y} H${x + w - q} Q${x + w},${y} ${x + w},${y + q} V${y + hgt} Z`;
    case "down":
      return `M${x},${y} V${y + hgt - q} Q${x},${y + hgt} ${x + q},${y + hgt} H${x + w - q} Q${x + w},${y + hgt} ${x + w},${y + hgt - q} V${y} Z`;
    case "right":
      return `M${x},${y} H${x + w - q} Q${x + w},${y} ${x + w},${y + q} V${y + hgt - q} Q${x + w},${y + hgt} ${x + w - q},${y + hgt} H${x} Z`;
    case "left":
      return `M${x + w},${y} H${x + q} Q${x},${y} ${x},${y + q} V${y + hgt - q} Q${x},${y + hgt} ${x + q},${y + hgt} H${x + w} Z`;
  }
}

type Chart = Extract<ViewComponent, { type: "chart" }>;
type TipRow = { key: string; name: string; value: string; line?: boolean };

/** The one tooltip of a chart: values lead, series names follow, each keyed by its colour. */
function tooltip(doc: Document, plot: HTMLElement) {
  const tip = h(doc, "div", { class: "ob-tip", role: "status", hidden: true });
  plot.append(tip);
  return {
    show(x: number, y: number, title: string, rows: TipRow[]) {
      tip.replaceChildren(
        h(doc, "div", { class: "ob-tip-title" }, title),
        ...rows.map((r) => h(doc, "div", { class: "ob-tip-row" }, h(doc, "i", { class: r.line ? "line" : "", style: `background:${r.key}` }), h(doc, "b", {}, r.value), h(doc, "span", {}, r.name))),
      );
      tip.hidden = false;
      const pw = plot.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
      const left = x + 14 + tw > pw ? Math.max(0, x - 14 - tw) : x + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, Math.min(y - th / 2, plot.clientHeight - th))}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

/** Pointer and keyboard over a chart: `at` turns a position into a slot (or -1); arrows step through the slots. */
function hover(plot: HTMLElement, target: SVGElement, slots: number, at: (x: number, y: number) => number, show: (i: number) => void, hide: () => void) {
  let current = -1;
  const go = (i: number) => {
    if (i === current) return;
    current = i;
    if (i < 0) hide();
    else show(i);
  };
  target.addEventListener("pointermove", (e) => {
    const r = plot.getBoundingClientRect();
    go(at((e as PointerEvent).clientX - r.left, (e as PointerEvent).clientY - r.top));
  });
  target.addEventListener("pointerleave", () => go(-1));
  plot.addEventListener("focus", () => go(Math.max(0, current)));
  plot.addEventListener("blur", () => go(-1));
  plot.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "ArrowRight" || k === "ArrowDown") go(Math.min(slots - 1, current + 1));
    else if (k === "ArrowLeft" || k === "ArrowUp") go(Math.max(0, current - 1));
    else if (k === "Escape") go(-1);
    else return;
    e.preventDefault();
  });
}

/** The title, a legend for two series or more (lines keyed with a line, bars and areas with a block), the plot, the note and the numbers as a table. */
function chart(doc: Document, d: Chart, W: number): Node[] {
  const series = d.kind === "pie" ? d.series.slice(0, 1) : d.series;
  const title = h(doc, "div", { class: "ob-chart-head" }, h(doc, "span", { class: "ob-label" }, d.title), d.unit ? h(doc, "span", { class: "ob-muted" }, `单位：${d.unit}`) : null);
  const dataTable = h(
    doc,
    "details",
    {},
    h(doc, "summary", {}, "看数据"),
    h(doc, "div", { class: "ob-scroll" }, h(doc, "table", {}, h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, ""), ...series.map((ser) => h(doc, "th", {}, ser.name)))), h(doc, "tbody", {}, ...d.labels.map((l, i) => h(doc, "tr", {}, h(doc, "th", {}, l), ...series.map((ser) => h(doc, "td", { class: "num" }, `${full(ser.values[i])}${d.unit ?? ""}`))))))),
  );
  const note = d.note ? h(doc, "p", { class: "ob-muted" }, d.note) : null;
  const plot = h(doc, "div", { class: "ob-plot", tabindex: 0, "aria-label": `${d.title}：方向键逐个看数值` });
  const legend = d.kind !== "pie" && series.length > 1 ? h(doc, "div", { class: "ob-legend" }, ...series.map((ser, si) => h(doc, "span", { class: "ob-key" }, h(doc, "i", { class: d.kind === "line" ? "line" : "", style: `background:${color(si)}` }), ser.name))) : null;
  if (d.kind === "pie") donut(doc, d, W, plot);
  else if (d.kind === "hbar") rows(doc, d, W, plot);
  else cartesian(doc, d, W, plot);
  return [title, legend, plot, note, dataTable].filter((x): x is HTMLElement => !!x);
}

/** Columns, lines and areas over one value axis from zero. */
function cartesian(doc: Document, d: Chart, W: number, plot: HTMLElement) {
  const n = d.labels.length;
  const m = d.series.length;
  const stacked = m > 1 && !!d.stack && d.kind !== "line";
  const unit = d.unit ?? "";
  // Stacks: each label's running totals, positives up and negatives down.
  const base = d.series.map(() => new Array<number>(n).fill(0));
  const top = d.series.map((s) => [...s.values]);
  if (stacked) {
    const pos = new Array<number>(n).fill(0), neg = new Array<number>(n).fill(0);
    d.series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        const acc = v >= 0 ? pos : neg;
        base[si][i] = acc[i];
        acc[i] += v;
        top[si][i] = acc[i];
      }),
    );
  }
  const all = [...top.flat(), ...base.flat(), 0, ...(d.goal !== undefined ? [d.goal] : [])];
  const { min, max, ticks } = niceScale(Math.min(...all), Math.max(...all));
  const H = 220, T = 14, B = 26;
  const tickLabels = ticks.map(axisFormat(ticks));
  const L = Math.ceil(Math.max(...tickLabels.map((t) => textW(t)))) + 12;
  const single = m === 1;
  const lineLike = d.kind === "line" || d.kind === "area";
  // Room at the right for the last value of a single line.
  const endLabel = lineLike && single ? compact(d.series[0].values[n - 1]) : "";
  const R = endLabel ? Math.ceil(textW(endLabel)) + 14 : 10;
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const band = (W - L - R) / n;
  const cx = (i: number) => L + band * (i + 0.5);
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${d.title}${unit ? `（${unit}）` : ""}` });
  ticks.forEach((t, k) => {
    if (t !== 0) svg.append(s(doc, "line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: "ob-grid" }));
    svg.append(s(doc, "text", { x: L - 8, y: y(t) + 4, "text-anchor": "end", class: "ob-tick" }, tickLabels[k]));
  });
  // A band highlight under the marks, moved on hover.
  const wash = s(doc, "rect", { x: 0, y: T, width: 0, height: H - T - B, class: "ob-wash", visibility: "hidden" });
  svg.append(wash);
  const maxChars = Math.max(2, band - 6);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / Math.max(48, Math.min(96, Math.max(...d.labels.map((l) => textW(l))) + 12))))));
  d.labels.forEach((l, i) => {
    if (i % every === 0 || (i === n - 1 && n > 2 && (n - 1) % every > every / 2)) svg.append(s(doc, "text", { x: cx(i), y: H - 8, "text-anchor": "middle", class: "ob-tick" }, clip(l, Math.max(maxChars * every, 40))));
  });
  const marks = s(doc, "g");
  svg.append(marks);
  if (lineLike) {
    d.series.forEach((ser, si) => {
      const pts = top[si].map((v, i) => [cx(i), y(v)] as [number, number]);
      if (d.kind === "area") {
        const lower = stacked ? base[si].map((v, i) => [cx(i), y(v)] as [number, number]).reverse() : [[cx(n - 1), y(0)], [cx(0), y(0)]] as [number, number][];
        const upper = smooth(pts);
        const back = stacked ? smooth(lower).replace(/^M/, "L") : lower.map(([x, yy]) => `L${x},${yy}`).join(" ");
        marks.append(s(doc, "path", { d: `${upper} ${back} Z`, fill: color(si), "fill-opacity": stacked ? 0.22 : m > 1 ? 0.08 : 0.12, stroke: "none" }));
      }
      marks.append(s(doc, "path", { d: smooth(pts), fill: "none", stroke: color(si), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      if (d.kind === "line" && n <= 12) for (const [px, py] of pts.slice(0, -1)) marks.append(s(doc, "circle", { cx: px, cy: py, r: 3, fill: color(si), class: "ob-ring" }));
      const [ex, ey] = pts[n - 1];
      marks.append(s(doc, "circle", { cx: ex, cy: ey, r: 4, fill: color(si), class: "ob-ring" }));
    });
    if (endLabel) {
      const [ex, ey] = [cx(n - 1), y(top[0][n - 1])];
      marks.append(s(doc, "text", { x: ex + 8, y: ey + 4, class: "ob-value" }, endLabel));
    }
  } else {
    const groups = stacked ? 1 : m;
    const gap = 2;
    const w = Math.max(2, Math.min(24, (band * 0.72 - gap * (groups - 1)) / groups));
    const labelled = single && n <= 16 && band >= 26;
    d.series.forEach((ser, si) => {
      ser.values.forEach((v, i) => {
        const x = stacked ? cx(i) - w / 2 : cx(i) - (groups * w + gap * (groups - 1)) / 2 + si * (w + gap);
        const a = y(stacked ? base[si][i] : 0), b = y(top[si][i]);
        let y0 = Math.min(a, b), hgt = Math.abs(a - b);
        // Stacked segments: a 2px gap of surface between them; only the outermost end is rounded.
        const outer = !stacked || d.series.every((o, oi) => oi <= si || Math.sign(o.values[i]) !== Math.sign(v) || o.values[i] === 0);
        if (stacked && !outer && hgt > 3) {
          if (v >= 0) y0 += gap;
          hgt -= gap;
        }
        if (hgt <= 0) return;
        marks.append(s(doc, "path", { d: barPath(x, y0, w, hgt, v >= 0 ? "up" : "down", outer ? 4 : 0), fill: color(si) }));
        if (labelled) marks.append(s(doc, "text", { x: x + w / 2, y: v >= 0 ? y0 - 5 : y0 + hgt + 12, "text-anchor": "middle", class: "ob-value" }, compact(v)));
      });
    });
    if (stacked && n <= 16 && band >= 30) top[m - 1].forEach((_, i) => {
      const total = d.series.reduce((sum, ser) => sum + ser.values[i], 0);
      const hi = Math.min(...top.map((t) => y(t[i])), y(0));
      marks.append(s(doc, "text", { x: cx(i), y: hi - 5, "text-anchor": "middle", class: "ob-value" }, compact(total)));
    });
  }
  svg.append(s(doc, "line", { x1: L, x2: W - R, y1: y(0), y2: y(0), class: "ob-axis" }));
  if (d.goal !== undefined) {
    const gy = y(d.goal);
    svg.append(s(doc, "line", { x1: L, x2: W - R, y1: gy, y2: gy, class: "ob-goal" }));
    svg.append(s(doc, "text", { x: W - R, y: gy - 5, "text-anchor": "end", class: "ob-tick" }, `目标 ${compact(d.goal)}`));
  }
  const cross = s(doc, "line", { x1: 0, x2: 0, y1: T, y2: H - B, class: "ob-cross", visibility: "hidden" });
  svg.append(cross);
  const hit = s(doc, "rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
  svg.append(hit);
  plot.append(svg);
  const tip = tooltip(doc, plot);
  hover(
    plot,
    hit,
    n,
    (x) => (x < L || x > W - R ? -1 : Math.min(n - 1, Math.max(0, Math.floor((x - L) / band)))),
    (i) => {
      if (lineLike) {
        cross.setAttribute("x1", String(cx(i)));
        cross.setAttribute("x2", String(cx(i)));
        cross.setAttribute("visibility", "visible");
      } else {
        wash.setAttribute("x", String(L + band * i));
        wash.setAttribute("width", String(band));
        wash.setAttribute("visibility", "visible");
      }
      const rowsOut: TipRow[] = d.series.map((ser, si) => ({ key: color(si), name: ser.name, value: `${full(ser.values[i])}${unit}`, line: d.kind === "line" }));
      if (stacked) rowsOut.push({ key: "transparent", name: "合计", value: `${full(d.series.reduce((sum, ser) => sum + ser.values[i], 0))}${unit}` });
      const yTop = Math.min(...top.map((t) => y(t[i])));
      tip.show(cx(i), yTop, d.labels[i], rowsOut);
    },
    () => {
      cross.setAttribute("visibility", "hidden");
      wash.setAttribute("visibility", "hidden");
      tip.hide();
    },
  );
}

/** Horizontal bars, one row per label in the given order (rankings, long names): name on the left, value at the bar's end. */
function rows(doc: Document, d: Chart, W: number, plot: HTMLElement) {
  const n = d.labels.length;
  const m = d.series.length;
  const stacked = m > 1 && !!d.stack;
  const unit = d.unit ?? "";
  const thick = stacked || m === 1 ? 16 : Math.max(8, Math.min(14, 28 / m));
  const rowH = stacked || m === 1 ? 32 : m * (thick + 2) + 14;
  const sums = d.labels.map((_, i) => d.series.reduce((a, ser) => a + Math.max(0, ser.values[i]), 0));
  const negs = d.labels.map((_, i) => d.series.reduce((a, ser) => a + Math.min(0, ser.values[i]), 0));
  const all = [0, ...(stacked ? [...sums, ...negs] : d.series.flatMap((ser) => ser.values)), ...(d.goal !== undefined ? [d.goal] : [])];
  const { min, max, ticks } = niceScale(Math.min(...all), Math.max(...all));
  const Lw = Math.min(Math.round(W * 0.32), Math.ceil(Math.max(...d.labels.map((l) => textW(l, 12)))) + 10);
  const valueW = Math.ceil(Math.max(...(stacked ? sums : d.series.flatMap((ser) => ser.values)).map((v) => textW(compact(v))))) + 12;
  // A goal's label sits in its own strip above the rows.
  const L = Lw, R = valueW, T = d.goal !== undefined ? 18 : 4, B = 22;
  const H = T + n * rowH + B;
  const x = (v: number) => L + (W - L - R) * ((v - min) / (max - min));
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${d.title}${unit ? `（${unit}）` : ""}` });
  const tickText = axisFormat(ticks);
  for (const t of ticks) {
    if (t !== 0) svg.append(s(doc, "line", { x1: x(t), x2: x(t), y1: T, y2: H - B, class: "ob-grid" }));
    svg.append(s(doc, "text", { x: x(t), y: H - 6, "text-anchor": "middle", class: "ob-tick" }, tickText(t)));
  }
  const wash = s(doc, "rect", { x: 0, y: 0, width: W, height: rowH, class: "ob-wash", visibility: "hidden" });
  svg.append(wash);
  d.labels.forEach((l, i) => {
    const ry = T + i * rowH;
    svg.append(s(doc, "text", { x: 0, y: ry + rowH / 2 + 4, class: "ob-rowlabel" }, clip(l, Lw - 10)));
    let pos = 0, neg = 0;
    d.series.forEach((ser, si) => {
      const v = ser.values[i];
      const by = stacked || m === 1 ? ry + (rowH - thick) / 2 : ry + 7 + si * (thick + 2);
      const from = stacked ? (v >= 0 ? pos : neg) : 0;
      const to = from + v;
      if (stacked) v >= 0 ? (pos = to) : (neg = to);
      const outer = !stacked || d.series.every((o, oi) => oi <= si || Math.sign(o.values[i]) !== Math.sign(v) || o.values[i] === 0);
      let x0 = Math.min(x(from), x(to)), w = Math.abs(x(to) - x(from));
      if (stacked && !outer && w > 3) {
        if (v < 0) x0 += 2;
        w -= 2;
      }
      if (w <= 0) return;
      svg.append(s(doc, "path", { d: barPath(x0, by, w, thick, v >= 0 ? "right" : "left", outer ? 4 : 0), fill: color(si) }));
      if (!stacked) svg.append(s(doc, "text", { x: v >= 0 ? x0 + w + 6 : x0 - 6, y: by + thick / 2 + 4, "text-anchor": v >= 0 ? "start" : "end", class: "ob-value" }, compact(v)));
    });
    if (stacked) svg.append(s(doc, "text", { x: x(sums[i]) + 6, y: ry + rowH / 2 + 4, class: "ob-value" }, compact(d.series.reduce((a, ser) => a + ser.values[i], 0))));
  });
  svg.append(s(doc, "line", { x1: x(0), x2: x(0), y1: T, y2: H - B, class: "ob-axis" }));
  if (d.goal !== undefined) {
    svg.append(s(doc, "line", { x1: x(d.goal), x2: x(d.goal), y1: T - 4, y2: H - B, class: "ob-goal" }));
    svg.append(s(doc, "text", { x: x(d.goal), y: T - 7, "text-anchor": "middle", class: "ob-tick" }, `目标 ${compact(d.goal)}`));
  }
  const hit = s(doc, "rect", { x: 0, y: T, width: W, height: n * rowH, fill: "transparent" });
  svg.append(hit);
  plot.append(svg);
  const tip = tooltip(doc, plot);
  hover(
    plot,
    hit,
    n,
    (_, yy) => (yy < T || yy > T + n * rowH ? -1 : Math.min(n - 1, Math.floor((yy - T) / rowH))),
    (i) => {
      wash.setAttribute("y", String(T + i * rowH));
      wash.setAttribute("visibility", "visible");
      const out: TipRow[] = d.series.map((ser, si) => ({ key: color(si), name: ser.name, value: `${full(ser.values[i])}${unit}` }));
      if (stacked) out.push({ key: "transparent", name: "合计", value: `${full(d.series.reduce((a, ser) => a + ser.values[i], 0))}${unit}` });
      tip.show(Math.min(W - 40, x(stacked ? sums[i] : Math.max(...d.series.map((ser) => ser.values[i])))), T + i * rowH + rowH / 2, d.labels[i], out);
    },
    () => {
      wash.setAttribute("visibility", "hidden");
      tip.hide();
    },
  );
}

/** Shares of a whole as a ring with the total in its middle, and a list of the parts with value and share. */
function donut(doc: Document, d: Chart, W: number, plot: HTMLElement) {
  const ser = d.series[0];
  const values = ser.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const unit = d.unit ?? "";
  const size = 176, R = 84, r = 54, c0 = size / 2;
  const svg = s(doc, "svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": d.title, class: "ob-donut" });
  const slices: SVGElement[] = [];
  let a0 = -Math.PI / 2;
  const pt = (rad: number, a: number) => `${c0 + rad * Math.cos(a)},${c0 + rad * Math.sin(a)}`;
  values.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p =
      v >= total
        ? s(doc, "path", { d: `M${c0},${c0 - R} A${R},${R} 0 1 1 ${c0 - 0.01},${c0 - R} L${c0 - 0.01},${c0 - r} A${r},${r} 0 1 0 ${c0},${c0 - r} Z`, fill: color(i), class: "ob-slice" })
        : s(doc, "path", { d: `M${pt(R, a0)} A${R},${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r},${r} 0 ${large} 0 ${pt(r, a0)} Z`, fill: color(i), class: "ob-slice" });
    slices.push(p);
    if (v > 0) svg.append(p);
    a0 = a1;
  });
  // The total, unless the parts are already shares of 100.
  if (unit !== "%") {
    svg.append(s(doc, "text", { x: c0, y: c0 + 2, "text-anchor": "middle", class: "ob-total" }, compact(total)));
    svg.append(s(doc, "text", { x: c0, y: c0 + 20, "text-anchor": "middle", class: "ob-tick" }, unit ? `合计（${unit}）` : "合计"));
  }
  const pct = (v: number) => `${Math.round((v / total) * 1000) / 10}%`;
  const list = h(
    doc,
    "ol",
    { class: "ob-parts" },
    ...d.labels.map((l, i) =>
      h(doc, "li", { "data-i": i }, h(doc, "i", { style: `background:${color(i)}` }), h(doc, "span", { class: "ob-part-name" }, l), h(doc, "span", { class: "ob-part-value" }, `${compact(values[i])}${unit}`), h(doc, "span", { class: "ob-part-share" }, pct(values[i]))),
    ),
  );
  const wrap = h(doc, "div", { class: `ob-donut-wrap${W < 420 ? " narrow" : ""}` });
  wrap.append(svg, list);
  plot.append(wrap);
  const tip = tooltip(doc, plot);
  const focus = (i: number) => {
    slices.forEach((p, j) => p.classList.toggle("dim", i >= 0 && j !== i));
    list.querySelectorAll("li").forEach((li, j) => li.classList.toggle("on", j === i));
  };
  hover(
    plot,
    svg,
    d.labels.length,
    (x, y) => {
      const b = svg.getBoundingClientRect(), p = plot.getBoundingClientRect();
      const k = size / b.width;
      const px = (x - (b.left - p.left)) * k - c0, py = (y - (b.top - p.top)) * k - c0;
      const dist = Math.hypot(px, py);
      if (dist < r - 2 || dist > R + 4) return -1;
      let a = Math.atan2(py, px) + Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      let acc = 0;
      for (let i = 0; i < values.length; i++) {
        acc += (values[i] / total) * Math.PI * 2;
        if (a <= acc) return i;
      }
      return values.length - 1;
    },
    (i) => {
      focus(i);
      const b = svg.getBoundingClientRect(), p = plot.getBoundingClientRect();
      tip.show(b.right - p.left - 8, b.top - p.top + b.height / 2, d.labels[i], [{ key: color(i), name: pct(values[i]), value: `${full(ser.values[i])}${unit}` }]);
    },
    () => {
      focus(-1);
      tip.hide();
    },
  );
  list.addEventListener("pointerover", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (li) focus(Number(li.dataset.i));
  });
  list.addEventListener("pointerleave", () => focus(-1));
}

// ------------------------------------------------------------------ questions (plugin pages)

/** Whether a field shows, given the values so far (docs/v2/interactive-ui.md, show_if). */
export function fieldVisible(f: UiField, values: Record<string, unknown>) {
  if (!f.show_if) return true;
  const v = values[f.show_if.field];
  const list = Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === "" ? [] : [String(v)];
  if (f.show_if.in) return f.show_if.in.some((x) => list.includes(x));
  if (f.show_if.equals !== undefined) return list.includes(String(f.show_if.equals));
  return list.length > 0;
}

/** A field's starting value: its default, if it has one. */
export function initialValues(fields: UiField[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if ("default" in f && f.default !== undefined) out[f.id] = f.default;
    // An order starts as the one suggested; a table with the rows handed in, or one empty row.
    if (f.type === "rank") out[f.id] = f.items.map((i) => i.id);
    if (f.type === "table") out[f.id] = f.rows.length ? f.rows.map((r) => ({ ...r })) : [{}];
  }
  return out;
}

type AskData = { question: string; options: { label: string }[]; allowText: boolean; fields?: UiField[]; view?: ViewComponent[]; submitLabel?: string };

function ask(el: HTMLElement, block: BlockView, opts: { submit: (answers: Record<string, unknown>) => Promise<void> } & RenderOptions) {
  const doc = el.ownerDocument;
  const d = block.data as AskData;
  const open = block.status === "open";
  const box = h(doc, "section", { class: "ob card pad", "aria-label": "需要你回答" });
  box.append(text(doc, d.question, opts));
  if (d.view?.length) {
    const v = h(doc, "div", { class: "ob" });
    box.append(v);
    renderView(v, d.view, opts, el);
  }
  const err = h(doc, "span", { class: "ob-err", role: "alert" });
  const send = async (answers: Record<string, unknown>, button?: HTMLButtonElement) => {
    if (button) button.disabled = true;
    err.textContent = "";
    try {
      await opts.submit(answers);
    } catch (e) {
      err.textContent = (e as Error).message;
      if (button) button.disabled = false;
    }
  };
  if (!open) {
    const r = block.result as { answer?: string | null; cancelled?: boolean } | null;
    box.append(h(doc, "p", { class: "ob-muted" }, r?.cancelled ? "已失效" : "已回答"));
    if (r?.answer) box.append(h(doc, "p", { class: "ob-value" }, r.answer));
    return box;
  }
  const values: Record<string, unknown> = { ...initialValues(d.fields ?? []) };
  const note = d.allowText ? (h(doc, d.fields?.length ? "textarea" : "input", { class: d.fields?.length ? "textarea" : "input", rows: 2, placeholder: d.fields?.length ? "补充说明（可不填）" : d.options.length ? "也可以写别的回答" : "你的回答", "aria-label": "文字回答" }) as HTMLInputElement) : null;
  if (d.fields?.length) {
    const list = h(doc, "div", { class: "ob" });
    const redraw = () => list.replaceChildren(...d.fields!.filter((f) => fieldVisible(f, values)).map((f) => fieldEl(doc, block.id, f, values, redraw)));
    redraw();
    box.append(list);
    if (note) box.append(note);
    const button = h(doc, "button", { type: "button", class: "btn primary" }, d.submitLabel || "提交") as HTMLButtonElement;
    button.addEventListener("click", () => send({ value: values, ...(note?.value.trim() ? { text: note.value.trim() } : {}) }, button));
    box.append(h(doc, "div", { class: "ob-foot" }, err, h(doc, "span", { class: "ob-spacer" }), button));
    return box;
  }
  if (d.options.length) box.append(h(doc, "div", { class: "ob-options" }, ...d.options.map((o, i) => {
    const b = h(doc, "button", { type: "button", class: `btn sm${i === 0 ? " primary" : ""}` }, o.label) as HTMLButtonElement;
    b.addEventListener("click", () => send({ choice: i, ...(note?.value.trim() ? { text: note.value.trim() } : {}) }, b));
    return b;
  })));
  if (note) {
    const b = h(doc, "button", { type: "button", class: "btn sm" }, "回答") as HTMLButtonElement;
    b.addEventListener("click", () => note.value.trim() && send({ text: note.value.trim() }, b));
    box.append(h(doc, "div", { class: "ob-foot" }, note, b));
  }
  box.append(err);
  return box;
}

/** One field with plain controls (choices are buttons; dates use the page's native inputs). */
function fieldEl(doc: Document, blockId: string, f: UiField, values: Record<string, unknown>, redraw: () => void) {
  const labelId = `ob-${blockId}-${f.id}`;
  const label = h(doc, "span", { class: "ob-label", id: labelId }, f.label, f.required ? h(doc, "span", { class: "ob-req", "aria-hidden": "true" }, "*") : null);
  const help = f.help ? h(doc, "span", { class: "ob-muted" }, f.help) : null;
  const set = (v: unknown, again = false) => {
    values[f.id] = v;
    if (again) redraw();
  };
  const dependents = true; // a later field may depend on this one: redraw on choices (cheap).
  let control: HTMLElement;
  switch (f.type) {
    case "textarea":
      control = h(doc, "textarea", { class: "textarea", rows: 3, placeholder: f.placeholder, "aria-labelledby": labelId, oninput: (e) => set((e.target as HTMLTextAreaElement).value) });
      (control as HTMLTextAreaElement).value = String(values[f.id] ?? "");
      break;
    case "text":
    case "number":
    case "date":
    case "datetime": {
      const type = f.type === "datetime" ? "datetime-local" : f.type;
      control = h(doc, "input", { class: "input", type, placeholder: "placeholder" in f ? f.placeholder : undefined, min: "min" in f ? f.min : undefined, max: "max" in f ? f.max : undefined, "aria-labelledby": labelId, oninput: (e) => set((e.target as HTMLInputElement).value), onchange: () => redraw() });
      (control as HTMLInputElement).value = String(values[f.id] ?? "");
      break;
    }
    case "toggle": {
      const b = h(doc, "button", { type: "button", class: "btn sm ob-opt", "aria-pressed": String(!!values[f.id]), "aria-labelledby": labelId }, values[f.id] ? "是" : "否");
      b.addEventListener("click", () => set(!values[f.id], dependents));
      control = b;
      break;
    }
    case "pick":
      control = h(doc, "div", { class: "ob-cards", role: "radiogroup", "aria-labelledby": labelId }, ...f.items.map((i) => {
        const b = cardBody(doc, h(doc, "button", { type: "button", role: "radio", class: "ob-pcard", "aria-checked": String(values[f.id] === i.id) }), i);
        b.addEventListener("click", () => set(i.id, dependents));
        return b;
      }));
      break;
    case "rank": {
      const order = values[f.id] as string[];
      control = h(doc, "ol", { class: "ob-rank", "aria-labelledby": labelId }, ...order.map((id, i) => {
        const it = f.items.find((x) => x.id === id)!;
        const move = (d: number) => {
          const next = [...order];
          [next[i], next[i + d]] = [next[i + d], next[i]];
          set(next, true);
        };
        return h(doc, "li", { class: "ob-check" }, h(doc, "span", {}, `${i + 1}. ${it.title}`), h(doc, "span", { class: "ob-options" },
          h(doc, "button", { type: "button", class: "btn sm", disabled: i === 0, "aria-label": `${it.title} 上移`, onclick: () => move(-1) }, "上移"),
          h(doc, "button", { type: "button", class: "btn sm", disabled: i === order.length - 1, "aria-label": `${it.title} 下移`, onclick: () => move(1) }, "下移")));
      }));
      break;
    }
    case "table": {
      const rows = values[f.id] as Record<string, unknown>[];
      const head = h(doc, "tr", {}, ...f.columns.map((c) => h(doc, "th", {}, c.label)), h(doc, "th", {}, ""));
      const body = rows.map((r, i) => h(doc, "tr", {}, ...f.columns.map((c) => {
        const input = (c.type === "choice"
          ? h(doc, "select", { class: "input", "aria-label": `第 ${i + 1} 行 ${c.label}` }, h(doc, "option", { value: "" }, ""), ...(c.options ?? []).map((o) => h(doc, "option", { value: o }, o)))
          : h(doc, "input", { class: "input", type: c.type === "number" ? "number" : "text", "aria-label": `第 ${i + 1} 行 ${c.label}` })) as HTMLInputElement;
        input.value = r[c.id] == null ? "" : String(r[c.id]);
        input.addEventListener("input", () => (r[c.id] = input.value));
        return h(doc, "td", {}, input);
      }), h(doc, "td", {}, h(doc, "button", { type: "button", class: "btn sm", "aria-label": `删除第 ${i + 1} 行`, onclick: () => set(rows.filter((_, j) => j !== i), true) }, "删除"))));
      const add = h(doc, "button", { type: "button", class: "btn sm", disabled: rows.length >= f.max_rows, onclick: () => set([...rows, {}], true) }, "加一行");
      control = h(doc, "div", { class: "ob-field" }, h(doc, "div", { class: "ob-scroll" }, h(doc, "table", { "aria-labelledby": labelId }, h(doc, "thead", {}, head), h(doc, "tbody", {}, ...body))), add);
      break;
    }
    case "checklist": {
      const map = ((values[f.id] as Record<string, { choice: string; note?: string }> | undefined) ?? {});
      values[f.id] = map;
      control = h(doc, "div", { role: "group", "aria-labelledby": labelId }, ...f.items.map((it) => {
        const row = h(doc, "div", { class: "ob-check" }, h(doc, "span", {}, it.title), it.detail ? h(doc, "span", { class: "ob-muted ob-text" }, it.detail) : null);
        const group = h(doc, "div", { class: "ob-options", role: "radiogroup", "aria-label": it.title }, ...f.choices.map((c) => {
          const b = h(doc, "button", { type: "button", role: "radio", class: "btn sm ob-opt", "aria-checked": String(map[it.id]?.choice === c) }, c);
          b.addEventListener("click", () => {
            map[it.id] = { ...map[it.id], choice: c };
            group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x.textContent === c)));
          });
          return b;
        }));
        row.append(group);
        if (f.note) {
          const n = h(doc, "input", { class: "input", placeholder: "备注（可不填）", "aria-label": `${it.title} 的备注` }) as HTMLInputElement;
          n.value = map[it.id]?.note ?? "";
          n.addEventListener("input", () => (map[it.id] = { choice: map[it.id]?.choice ?? "", note: n.value }));
          row.append(n);
        }
        return row;
      }));
      break;
    }
    default: {
      // choice, multi, scale: buttons (single: radio group; several: toggles; scale: 1–5).
      const options = f.type === "scale" ? ["1", "2", "3", "4", "5"] : (f as { options: string[] }).options;
      const multi = f.type === "multi";
      control = h(doc, "div", { class: "ob-options", role: multi ? "group" : "radiogroup", "aria-labelledby": labelId }, ...options.map((o) => {
        const cur = values[f.id];
        const on = multi ? ((cur as string[] | undefined) ?? []).includes(o) : String(cur ?? "") === o;
        const b = h(doc, "button", { type: "button", class: "btn sm ob-opt", ...(multi ? { "aria-pressed": String(on) } : { role: "radio", "aria-checked": String(on) }) }, o);
        b.addEventListener("click", () => {
          if (multi) {
            const next = new Set((values[f.id] as string[] | undefined) ?? []);
            next.has(o) ? next.delete(o) : next.add(o);
            set([...next], dependents);
          } else set(f.type === "scale" ? Number(o) : o, dependents);
        });
        return b;
      }));
    }
  }
  return h(doc, "div", { class: "ob-field" }, label, help, control);
}
