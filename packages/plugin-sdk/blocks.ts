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
export type ViewComponent =
  | { type: "markdown"; text: string }
  | { type: "heading"; text: string }
  | { type: "table"; title?: string; columns: string[]; rows: (string | number | boolean | null)[][]; note?: string }
  | { type: "chart"; title: string; kind: "bar" | "line" | "pie"; labels: string[]; series: { name: string; values: number[] }[]; unit?: string; note?: string }
  | { type: "metric"; items: { label: string; value: string | number; unit?: string; change?: string }[] }
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
.ob svg { width: 100%; height: auto; display: block; overflow: visible; }
.ob .ob-axis { stroke: var(--line-strong); stroke-width: 1; }
.ob .ob-grid { stroke: var(--line); stroke-width: 1; }
.ob .ob-tick { fill: var(--muted); font-size: 11px; font-family: var(--sans); }
.ob .ob-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12.5px; color: var(--ink-2); }
.ob .ob-key { display: inline-flex; align-items: center; gap: 6px; }
.ob .ob-key i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.ob details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
.ob .ob-scroll { overflow-x: auto; max-width: 100%; }
.ob table { border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
.ob th, .ob td { border-bottom: 1px solid var(--line); padding: 4px 12px 4px 0; text-align: left; font-weight: 400; vertical-align: top; }
.ob thead th { color: var(--muted); font-weight: 550; white-space: nowrap; }
.ob thead th button { all: unset; cursor: pointer; }
.ob thead th button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ob td.num { text-align: right; font-variant-numeric: tabular-nums; }
.ob .ob-metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.ob .ob-metric { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: grid; gap: 2px; min-width: 0; }
.ob .ob-metric b { font: 600 20px/1.2 var(--sans); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
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
.ob { --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #8a63d2; --s6: #6b7a8f; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ob { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #9b78e0; --s6: #8593a6; } }
:root[data-theme="dark"] .ob { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #9b78e0; --s6: #8593a6; }
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
    case "metric":
      return h(doc, "div", { class: "ob-metrics" }, ...c.items.map((m) => h(doc, "div", { class: "ob-metric" }, h(doc, "span", { class: "ob-muted" }, m.label), h(doc, "b", {}, `${m.value}${m.unit ?? ""}`), m.change ? h(doc, "span", { class: "ob-muted" }, m.change) : null)));
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
  const box = h(doc, "div", { class: "ob-field" });
  let drawnAt = 0;
  const draw = () => {
    const w = Math.max(280, Math.min(900, Math.round(box.clientWidth || owner.clientWidth || 600)));
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

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString() : String(Math.round(n * 100) / 100));
const color = (i: number) => `var(--s${(i % 6) + 1})`;

/** One value axis from zero, recessive grid, thin marks with rounded data ends; native tooltips per mark. */
function chart(doc: Document, d: Extract<ViewComponent, { type: "chart" }>, W: number): Node[] {
  const title = h(doc, "span", { class: "ob-label" }, `${d.title}${d.unit ? `（${d.unit}）` : ""}`);
  const series = d.kind === "pie" ? d.series.slice(0, 1) : d.series;
  const dataTable = h(
    doc,
    "details",
    {},
    h(doc, "summary", {}, "看数据"),
    h(doc, "div", { class: "ob-scroll" }, h(doc, "table", {}, h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, ""), ...series.map((ser) => h(doc, "th", {}, ser.name)))), h(doc, "tbody", {}, ...d.labels.map((l, i) => h(doc, "tr", {}, h(doc, "th", {}, l), ...series.map((ser) => h(doc, "td", { class: "num" }, `${fmt(ser.values[i])}${d.unit ?? ""}`))))))),
  );
  const note = d.note ? h(doc, "p", { class: "ob-muted" }, d.note) : null;
  if (d.kind === "pie") {
    const values = series[0].values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const size = 180, r = 80, cx = size / 2, cy = size / 2;
    const svg = s(doc, "svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": d.title, style: `max-width:${size}px` });
    let a0 = -Math.PI / 2;
    values.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = v >= total
        ? s(doc, "circle", { cx, cy, r, fill: color(i) })
        : s(doc, "path", { d: `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`, fill: color(i), stroke: "var(--panel)", "stroke-width": 1.5 });
      p.append(s(doc, "title", {}, `${d.labels[i]}：${fmt(v)}${d.unit ?? ""}（${Math.round((v / total) * 100)}%）`));
      svg.append(p);
      a0 = a1;
    });
    const legend = h(doc, "div", { class: "ob-legend" }, ...d.labels.map((l, i) => h(doc, "span", { class: "ob-key" }, h(doc, "i", { style: `background:${color(i)}` }), `${l} ${Math.round((values[i] / total) * 100)}%`)));
    return [title, svg, legend, note, dataTable].filter((x): x is HTMLElement => !!x);
  }
  const H = 200, L = 36, R = 8, T = 10, B = 26;
  const all = series.flatMap((x) => x.values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all) || 1;
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const band = (W - L - R) / d.labels.length;
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${d.title}${d.unit ? `（${d.unit}）` : ""}` });
  for (const t of [min, (min + max) / 2, max]) {
    svg.append(s(doc, "line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: "ob-grid" }));
    svg.append(s(doc, "text", { x: L - 6, y: y(t) + 4, "text-anchor": "end", class: "ob-tick" }, fmt(t)));
  }
  svg.append(s(doc, "line", { x1: L, x2: W - R, y1: y(0), y2: y(0), class: "ob-axis" }));
  // Label every nth tick so they never collide.
  const every = Math.max(1, Math.ceil(d.labels.length / Math.max(2, Math.floor(W / 56))));
  d.labels.forEach((l, i) => {
    if (i % every === 0) svg.append(s(doc, "text", { x: L + band * (i + 0.5), y: H - 8, "text-anchor": "middle", class: "ob-tick" }, l.length > 8 ? l.slice(0, 7) + "…" : l));
  });
  if (d.kind === "line") {
    series.forEach((ser, si) => {
      const pts = ser.values.map((v, i) => [L + band * (i + 0.5), y(v)] as const);
      svg.append(s(doc, "polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: color(si), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      pts.forEach(([px, py], i) => {
        const dot = s(doc, "circle", { cx: px, cy: py, r: 4, fill: color(si), stroke: "var(--panel)", "stroke-width": 2 });
        dot.append(s(doc, "title", {}, `${d.labels[i]} · ${ser.name}：${fmt(ser.values[i])}${d.unit ?? ""}`));
        svg.append(dot);
      });
    });
  } else {
    const n = series.length;
    const gap = 2;
    const w = Math.max(2, Math.min(28, (band * 0.7 - gap * (n - 1)) / n));
    series.forEach((ser, si) => {
      ser.values.forEach((v, i) => {
        const x = L + band * (i + 0.5) - (n * w + gap * (n - 1)) / 2 + si * (w + gap);
        const top = y(Math.max(v, 0));
        const height = Math.max(0, Math.abs(y(v) - y(0)));
        const r = Math.min(4, w / 2, height);
        // Rounded at the data end, square at the baseline.
        const path = v >= 0
          ? `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${y(0)} Z`
          : `M${x},${y(0)} V${y(v) - r} Q${x},${y(v)} ${x + r},${y(v)} H${x + w - r} Q${x + w},${y(v)} ${x + w},${y(v) - r} V${y(0)} Z`;
        const bar = s(doc, "path", { d: path, fill: color(si) });
        bar.append(s(doc, "title", {}, `${d.labels[i]} · ${ser.name}：${fmt(v)}${d.unit ?? ""}`));
        svg.append(bar);
      });
    });
  }
  // Identity is never color alone: a legend for two series or more, and the numbers as a table.
  const legend = series.length > 1 ? h(doc, "div", { class: "ob-legend" }, ...series.map((ser, si) => h(doc, "span", { class: "ob-key" }, h(doc, "i", { style: `background:${color(si)}` }), ser.name))) : null;
  return [title, legend, svg, note, dataTable].filter((x): x is HTMLElement | SVGSVGElement => !!x);
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
  for (const f of fields) if ("default" in f && f.default !== undefined) out[f.id] = f.default;
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
