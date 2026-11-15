/**
 * omem's charts and figures, drawn without a framework (docs/v2/interactive-ui.md, “图表的样子”).
 * One drawing for every place that shows a chart: component blocks (blocks.ts, so agents' `show`
 * and plugin pages), and omem's own pages through the thin Vue components in
 * web/src/components/charts/. Feishu cards cannot run this; src/channels/lark-ui.ts builds a VChart
 * spec in the same colours and shapes.
 *
 * The look: hairline grid (or none when every mark carries its value), thin marks with a small
 * rounding at the data end, the key values written on the chart with a solid dot instead of a
 * legend to decode, small spaced axis labels, one tick per label on the baseline so a run of days
 * can be counted. Several series take the categorical slots `--chart-1`…`--chart-8`
 * (web/src/styles.css, light and dark, checked for colour-blind separation) and are named at the
 * end of their line or in a short legend when there is no room; a single series is one colour, with
 * the emphasised mark full strength and the rest lighter. Every chart can be read without colour or
 * pointer: values on the marks, a tooltip that the arrow keys step through, and the numbers as a
 * table (“看数据”).
 *
 * Text goes in through textContent only. Colours are CSS variables only.
 */

export type ChartSeries = {
  name: string;
  values: number[];
  /** Colour slot (0–7). Defaults to the series' position; give it when a series must keep its colour while others come and go. */
  slot?: number;
  /** Per label: where this series' value at that label is listed (omem's own pages). */
  links?: (string | undefined)[];
};
export type ChartSpec = {
  title?: string;
  kind: "bar" | "line" | "area" | "hbar" | "pie";
  labels: string[];
  series: ChartSeries[];
  stack?: boolean;
  goal?: number;
  unit?: string;
  note?: string;
  /** A label to emphasise: its mark full strength with the value written beside a solid dot. */
  highlight?: string;
  /** What one mark is, under the title (“一根一天”). */
  caption?: string;
  /** Per label: where its records are listed (a row of a ranking, a day). */
  links?: (string | undefined)[];
  /** hbar only: columns of another unit after the bars, as text. */
  extras?: { name: string; values: string[]; links?: (string | undefined)[] }[];
  /** The numbers as a table under the chart (default on). */
  table?: boolean;
};
/** `good`: which way is good news (up by default); `trend` is read off the change's sign when not given; `spark` is its recent course. */
export type MetricItem = {
  label: string;
  value: string | number;
  unit?: string;
  change?: string;
  trend?: "up" | "down" | "flat";
  good?: "up" | "down" | "none";
  note?: string;
  spark?: number[];
  /** Where the figure's records are listed (omem's own pages). */
  link?: string;
  /** A longer explanation, shown on hover. */
  hint?: string;
};
export type MetricGroup = { title?: string; items: MetricItem[]; note?: string };

const CSS = `
.oc { display: grid; gap: 10px; min-width: 0; color: var(--ink); }
.oc-head { display: grid; gap: 1px; min-width: 0; }
.oc-title { font-size: 13.5px; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.oc-sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.oc-note { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.oc-plot { position: relative; outline: none; border-radius: 6px; min-width: 0; }
.oc-plot:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.oc-plot > svg { width: 100%; height: auto; display: block; overflow: visible; touch-action: pan-y; }
.oc-plot.clickable > svg { cursor: pointer; }
.oc-grid { stroke: var(--chart-grid); stroke-width: 1; shape-rendering: crispEdges; }
.oc-base { stroke: var(--chart-axis); stroke-width: 1; shape-rendering: crispEdges; }
.oc-tick { stroke: var(--chart-axis); stroke-width: 1; shape-rendering: crispEdges; }
.oc-goal { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 4 3; opacity: .7; }
.oc-cross { stroke: var(--chart-axis); stroke-width: 1; }
.oc-wash { fill: var(--hover); }
.oc-axis { fill: var(--muted); font: 500 10.5px var(--sans); letter-spacing: .04em; }
.oc-val { fill: var(--ink-2); font: 500 10.5px var(--sans); font-variant-numeric: tabular-nums; }
.oc-val.key { fill: var(--ink); font-weight: 650; font-size: 11.5px; }
.oc-name { fill: var(--ink-2); font: 500 11px var(--sans); }
.oc-dot { stroke: var(--chart-surface, var(--panel)); stroke-width: 1.5; }
.oc-dim { opacity: .45; }
.oc-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); }
.oc-key { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.oc-key i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.oc-key i.line { width: 12px; height: 2px; border-radius: 1px; }
.oc-key b { font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.oc-tip { position: absolute; z-index: 3; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 7px 10px; font-size: 12px; line-height: 1.5; min-width: 110px; white-space: nowrap; }
.oc-tip-title { color: var(--muted); margin-bottom: 2px; }
.oc-tip-row { display: flex; align-items: center; gap: 8px; }
.oc-tip-row i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.oc-tip-row i.line { height: 2px; width: 12px; }
.oc-tip-row b { color: var(--ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.oc-tip-row span { color: var(--ink-2); }
.oc details summary { cursor: pointer; color: var(--muted); font-size: 12px; width: fit-content; }
.oc-scroll { overflow-x: auto; max-width: 100%; }
.oc table { border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
.oc th, .oc td { border-bottom: 1px solid var(--line); padding: 4px 12px 4px 0; text-align: left; font-weight: 400; vertical-align: top; }
.oc thead th { color: var(--muted); font-weight: 550; white-space: nowrap; }
.oc td.num { text-align: right; font-variant-numeric: tabular-nums; }
.oc td a { color: inherit; }
/* rows: a ranking, long names, several measures side by side */
.oc-rows { display: grid; gap: 2px; min-width: 0; --label-w: 9.5em; }
.oc-row { display: grid; grid-template-columns: minmax(0, var(--label-w)) minmax(48px, 1fr) var(--extras, 0); align-items: center; column-gap: 12px; padding: 4px 0; font-size: 13px; color: inherit; text-decoration: none; min-width: 0; }
.oc-row.head { padding-top: 0; padding-bottom: 0; font-size: 11.5px; color: var(--muted); }
a.oc-row:hover, .oc-row a.oc-track:hover { background: var(--hover); box-shadow: -6px 0 0 var(--hover), 6px 0 0 var(--hover); }
a.oc-row:focus-visible, .oc-row a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 2px; }
a.oc-row:hover .oc-row-label { text-decoration: underline; text-underline-offset: 2px; }
.oc-row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.oc-row-label.key { color: var(--ink); font-weight: 600; }
.oc-bars { position: relative; display: grid; gap: 2px; min-width: 0; padding: 1px 0; }
.oc-bars::before { content: ""; position: absolute; top: -4px; bottom: -4px; left: var(--zero, 0%); border-left: 1px solid var(--chart-axis); }
.oc-track { position: relative; height: max(var(--thick, 8px), var(--line-h, 8px)); margin-right: var(--room, 3em); margin-left: var(--room-left, 0); display: block; color: inherit; text-decoration: none; border-radius: 2px; }
.oc-bar { position: absolute; top: 50%; height: var(--thick, 8px); transform: translateY(-50%); border-radius: 0 2px 2px 0; min-width: 1px; }
.oc-bar.neg { border-radius: 2px 0 0 2px; }
.oc-bar.seg { border-radius: 0; }
.oc-bar.seg.end { border-radius: 0 2px 2px 0; }
.oc-bar-v { position: absolute; top: 50%; transform: translateY(-50%); padding: 0 6px; font-size: 11.5px; line-height: 1; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.oc-bar-v.key { color: var(--ink); font-weight: 650; }
.oc-goal-v { position: absolute; top: -6px; bottom: -6px; border-left: 1px dashed var(--ink-2); opacity: .55; pointer-events: none; }
.oc-goal-label { position: relative; height: 14px; font-size: 11px; color: var(--muted); }
.oc-goal-label span { position: absolute; bottom: 0; transform: translateX(-50%); white-space: nowrap; }
.oc-plot > svg.oc-donut { width: 168px; height: 168px; }
.oc-extras { display: grid; grid-template-columns: repeat(var(--n, 1), minmax(3.6em, auto)); column-gap: 12px; justify-content: end; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.oc-extras a { color: inherit; text-decoration: none; }
.oc-extras a:hover { text-decoration: underline; }
.oc-extras small { margin-left: 2px; font-size: 11px; color: var(--muted); }
/* shares of a whole */
.oc-donut-wrap { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 24px; align-items: center; }
.oc-donut-wrap.narrow { grid-template-columns: minmax(0, 1fr); justify-items: center; }
.oc-donut { width: 168px; height: 168px; display: block; }
.oc-slice { transition: opacity .15s; }
.oc-slice.dim { opacity: .28; }
.oc-total { fill: var(--ink); font: 650 22px var(--sans); font-variant-numeric: tabular-nums; }
.oc-parts { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; width: 100%; font-size: 13px; }
.oc-parts li { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 48px; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 6px; }
.oc-parts li.on { background: var(--hover); }
.oc-parts i { width: 8px; height: 8px; border-radius: 2px; }
.oc-part-name { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-part-value { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.oc-part-share { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
/* figures */
.oc-mgroup { display: grid; gap: 8px; min-width: 0; container-type: inline-size; }
.oc-mtitle { font-size: 13.5px; font-weight: 600; }
.oc-metrics { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); row-gap: 14px; overflow: hidden; }
@container (max-width: 520px) { .oc-metrics { grid-template-columns: repeat(var(--cols-narrow, 2), minmax(0, 1fr)); } }
.oc-metric { display: grid; gap: 2px; align-content: start; min-width: 0; padding: 2px 16px; margin-left: -1px; border-left: 1px solid var(--line); color: inherit; text-decoration: none; }
a.oc-metric { border-radius: 0 6px 6px 0; }
a.oc-metric:hover { background: var(--hover); }
a.oc-metric:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.oc-mlabel { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.oc-mvalue { display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.oc-mvalue b { font: 600 26px/1.2 var(--sans); letter-spacing: -0.015em; color: var(--ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.oc-mvalue span { color: var(--muted); font-size: 12.5px; }
.oc-mfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; font-size: 12px; color: var(--muted); }
.oc-delta { font-weight: 550; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.oc-delta[data-tone="good"] { color: var(--ok); }
.oc-delta[data-tone="bad"] { color: var(--danger); }
.oc-spark { width: 100%; max-width: 140px; height: auto; display: block; margin-top: 4px; overflow: visible; }
.oc-spark-line { fill: none; stroke: var(--ink-2); stroke-width: 1.25; stroke-linejoin: round; stroke-linecap: round; opacity: .8; }
.oc-spark-dot { fill: var(--ink); }
@media (max-width: 520px) { .oc-mvalue b { font-size: 23px; } .oc-rows { --label-w: 7em; } }
`;

export function ensureChartStyle(doc: Document) {
  if (doc.getElementById("omem-chart-style")) return;
  const st = doc.createElement("style");
  st.id = "omem-chart-style";
  st.textContent = CSS;
  doc.head.appendChild(st);
}

// ------------------------------------------------------------------ DOM helpers

type Attrs = Record<string, string | number | boolean | undefined>;
function h(doc: Document, tag: string, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
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
/** A link when there is somewhere to go, a plain element otherwise. */
const linkOr = (doc: Document, href: string | undefined, cls: string, attrs: Attrs = {}) => h(doc, href ? "a" : "div", { class: cls, ...(href ? { href } : {}), ...attrs });

// ------------------------------------------------------------------ numbers

/** Every digit of a value (tooltips, the data table). */
export const full = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
/** A value where room is short (labels on marks, a donut's total): 1.2万, 3.4亿. */
export function compact(n: number) {
  const a = Math.abs(n);
  const r = (x: number) => x.toLocaleString("zh-CN", { maximumFractionDigits: a >= 1e4 ? 1 : a >= 100 ? 0 : a >= 10 ? 1 : 2 });
  return a >= 1e8 ? `${r(n / 1e8)}亿` : a >= 1e4 ? `${r(n / 1e4)}万` : r(n);
}
/** Seconds read as seconds only when they are few (a duration written on a bar). */
export function withUnit(v: number, unit = "", short = true): string {
  if (unit === "秒" && Math.abs(v) >= 7200) return `${Math.round(v / 360) / 10}小时`;
  if (unit === "秒" && Math.abs(v) >= 120) return `${Math.round(v / 6) / 10}分钟`;
  return `${short ? compact(v) : full(v)}${unit === "%" ? "%" : ""}`;
}
/** One style for every tick of an axis, set by its largest: 0, 5,000, 10,000 or 0, 0.5万, 1万 — never both. */
function axisFormat(ticks: number[]) {
  const top = Math.max(...ticks.map(Math.abs));
  const [div, suffix] = top >= 1e8 ? [1e8, "亿"] : top >= 1e4 ? [1e4, "万"] : [1, ""];
  return (v: number) => (v === 0 ? "0" : `${(v / div).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`);
}
/** Round ticks (steps of 1, 2, 2.5 or 5 × 10ⁿ) covering [lo, hi], about `count` of them; whole numbers stay whole. */
function niceScale(lo: number, hi: number, count = 3, whole = false) {
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  const span = hi - lo;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= count) ?? 10 * mag;
  if (whole && step < 1) step = 1;
  if (whole && !Number.isInteger(step)) step = Math.ceil(step);
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { min, max, ticks };
}
/** Rough rendered width of a label at 11–12px (CJK twice as wide), for laying out before drawing. */
const textW = (t: string, px = 11) => Array.from(t).reduce((n, ch) => n + (ch.codePointAt(0)! > 0xff ? px : px * 0.6), 0);
function clip(t: string, maxW: number, px = 11) {
  if (textW(t, px) <= maxW) return t;
  const chars = Array.from(t);
  while (chars.length > 1 && textW(chars.join("") + "…", px) > maxW) chars.pop();
  return chars.join("") + "…";
}
/** Dates on an axis: 2026-11-03 reads 11-03 (the year is in the title or the range). */
const shortLabel = (l: string) => l.replace(/^\d{4}-(\d{2})-(\d{2})(?!\d)/, "$1-$2");

/** A smooth path through the points that never overshoots them (monotone cubic). */
function smooth(pts: [number, number][]) {
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const n = pts.length;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
  const t = pts.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])));
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i] / 3;
    d += ` C${pts[i][0] + third},${pts[i][1] + t[i] * third} ${pts[i + 1][0] - third},${pts[i + 1][1] - t[i + 1] * third} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}
/** A column with its data end slightly rounded and its baseline end square. */
function colPath(x: number, y: number, w: number, hgt: number, up: boolean, r = 2) {
  const q = Math.max(0, Math.min(r, w / 2, hgt));
  if (q < 0.5) return `M${x},${y} h${w} v${hgt} h${-w} Z`;
  return up
    ? `M${x},${y + hgt} V${y + q} Q${x},${y} ${x + q},${y} H${x + w - q} Q${x + w},${y} ${x + w},${y + q} V${y + hgt} Z`
    : `M${x},${y} V${y + hgt - q} Q${x},${y + hgt} ${x + q},${y + hgt} H${x + w - q} Q${x + w},${y + hgt} ${x + w},${y + hgt - q} V${y} Z`;
}

/** A series' colour: its slot, else its position. */
export const seriesColor = (ser: Pick<ChartSeries, "slot"> | undefined, i: number) => `var(--chart-${(((ser?.slot ?? i) % 8) + 8) % 8 + 1})`;

// ------------------------------------------------------------------ the frame

/**
 * Draw a chart into `el` (replacing what is there) at the width it gets, redrawn when that changes.
 * Returns a function that stops following the width.
 */
export function mountChart(el: HTMLElement, spec: ChartSpec): () => void {
  const doc = el.ownerDocument;
  ensureChartStyle(doc);
  el.classList.add("oc");
  const d = normalize(spec);
  const unitText = d.unit && d.unit !== "%" ? `单位：${d.unit}` : "";
  const sub = [d.caption, unitText].filter(Boolean).join(" · ");
  const head = d.title || sub ? h(doc, "div", { class: "oc-head" }, d.title ? h(doc, "span", { class: "oc-title" }, d.title) : null, sub ? h(doc, "span", { class: "oc-sub" }, sub) : null) : null;
  const body = h(doc, "div", { class: "oc", style: "gap:8px" });
  const note = d.note ? h(doc, "p", { class: "oc-note" }, d.note) : null;
  // Rows and a ring's list already show every value as text; the others fold their numbers into a table.
  const table = d.table !== false && d.kind !== "hbar" && d.kind !== "pie";
  el.replaceChildren(...[head, body, note, table ? dataTable(doc, d) : null].filter((x): x is HTMLElement => !!x));
  // Rows and shares lay themselves out; the others are drawn for a width.
  if (d.kind === "hbar") {
    body.replaceChildren(...rows(doc, d));
    return () => {};
  }
  let drawnAt = 0;
  const draw = () => {
    const w = Math.max(240, Math.min(960, Math.round(body.clientWidth || el.clientWidth || 600)));
    if (Math.abs(w - drawnAt) < 8) return;
    drawnAt = w;
    body.replaceChildren(...(d.kind === "pie" ? donut(doc, d, w) : cartesian(doc, d, w)));
  };
  draw();
  if (typeof ResizeObserver === "undefined") return () => {};
  const ro = new ResizeObserver(draw);
  ro.observe(body);
  return () => ro.disconnect();
}

function normalize(spec: ChartSpec): ChartSpec {
  const n = spec.labels.length;
  const series = (spec.kind === "pie" ? spec.series.slice(0, 1) : spec.series).map((x) => ({ ...x, values: Array.from({ length: n }, (_, i) => (Number.isFinite(x.values[i]) ? x.values[i] : 0)) }));
  return { ...spec, series };
}

/** The numbers as a table, folded under the chart: the way to read it without the picture. */
function dataTable(doc: Document, d: ChartSpec) {
  const unit = d.unit ?? "";
  const cell = (ser: ChartSeries, i: number) => {
    const text = `${full(ser.values[i])}${unit}`;
    const href = ser.links?.[i] ?? (d.series.length === 1 ? d.links?.[i] : undefined);
    return h(doc, "td", { class: "num" }, href ? h(doc, "a", { href }, text) : text);
  };
  const extras = d.extras ?? [];
  return h(
    doc,
    "details",
    {},
    h(doc, "summary", {}, "看数据"),
    h(doc, "div", { class: "oc-scroll" }, h(doc, "table", {},
      h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, ""), ...d.series.map((ser) => h(doc, "th", {}, ser.name)), ...extras.map((x) => h(doc, "th", {}, x.name)))),
      h(doc, "tbody", {}, ...d.labels.map((l, i) => h(doc, "tr", {}, h(doc, "th", {}, l), ...d.series.map((ser) => cell(ser, i)), ...extras.map((x) => h(doc, "td", { class: "num" }, x.values[i] ?? "")))))),
    ),
  );
}

type TipRow = { key: string; name: string; value: string; line?: boolean };
/** The one tooltip of a chart: values lead, series names follow, each keyed by its colour. */
function tooltip(doc: Document, plot: HTMLElement) {
  const tip = h(doc, "div", { class: "oc-tip", role: "status", hidden: true });
  plot.append(tip);
  return {
    show(x: number, y: number, title: string, rowsOut: TipRow[]) {
      tip.replaceChildren(
        h(doc, "div", { class: "oc-tip-title" }, title),
        ...rowsOut.map((r) => h(doc, "div", { class: "oc-tip-row" }, h(doc, "i", { class: r.line ? "line" : "", style: `background:${r.key}` }), h(doc, "b", {}, r.value), h(doc, "span", {}, r.name))),
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

/** Pointer and keyboard over a chart: `at` turns a position into a slot (or -1); arrows step through the slots; Enter opens the slot's records. */
function hover(plot: HTMLElement, target: SVGElement, slots: number, at: (x: number, y: number) => number, show: (i: number) => void, hide: () => void, open?: (i: number, x: number, y: number) => void) {
  let current = -1;
  const go = (i: number) => {
    if (i === current) return;
    current = i;
    if (i < 0) hide();
    else show(i);
  };
  const local = (e: Event) => {
    const r = plot.getBoundingClientRect();
    return [(e as PointerEvent).clientX - r.left, (e as PointerEvent).clientY - r.top] as const;
  };
  target.addEventListener("pointermove", (e) => go(at(...local(e))));
  target.addEventListener("pointerleave", () => go(-1));
  if (open) target.addEventListener("click", (e) => {
    const [x, y] = local(e);
    const i = at(x, y);
    if (i >= 0) open(i, x, y);
  });
  plot.addEventListener("focus", () => go(Math.max(0, current)));
  plot.addEventListener("blur", () => go(-1));
  plot.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "ArrowRight" || k === "ArrowDown") go(Math.min(slots - 1, current + 1));
    else if (k === "ArrowLeft" || k === "ArrowUp") go(Math.max(0, current - 1));
    else if (k === "Home") go(0);
    else if (k === "End") go(slots - 1);
    else if (k === "Escape") go(-1);
    else if (k === "Enter" && open && current >= 0) open(current, -1, -1);
    else return;
    e.preventDefault();
  });
}

function follow(doc: Document, href: string | undefined) {
  if (!href) return;
  const win = doc.defaultView;
  if (win) win.location.href = href;
}

/** A short legend: a colour key per series, with its total when the series add up (stacks). */
function legend(doc: Document, d: ChartSpec, totals: boolean) {
  return h(doc, "div", { class: "oc-legend" }, ...d.series.map((ser, si) => h(doc, "span", { class: "oc-key" },
    h(doc, "i", { class: d.kind === "line" ? "line" : "", style: `background:${seriesColor(ser, si)}` }),
    ser.name,
    totals ? h(doc, "b", {}, withUnit(ser.values.reduce((a, b) => a + b, 0), d.unit)) : null)));
}

// ------------------------------------------------------------------ columns, lines, areas

/** Columns, lines and areas over one value axis from zero. */
function cartesian(doc: Document, d: ChartSpec, W: number): HTMLElement[] {
  const n = d.labels.length;
  const m = d.series.length;
  const unit = d.unit ?? "";
  const stacked = m > 1 && !!d.stack && d.kind !== "line";
  const lineLike = d.kind === "line" || d.kind === "area";
  const single = m === 1;
  const hl = d.highlight ? d.labels.indexOf(d.highlight) : -1;
  // Stacks: each label's running totals, positives up and negatives down.
  const base = d.series.map(() => new Array<number>(n).fill(0));
  const top = d.series.map((x) => [...x.values]);
  if (stacked) {
    const pos = new Array<number>(n).fill(0), neg = new Array<number>(n).fill(0);
    d.series.forEach((x, si) => x.values.forEach((v, i) => {
      const acc = v >= 0 ? pos : neg;
      base[si][i] = acc[i];
      acc[i] += v;
      top[si][i] = acc[i];
    }));
  }
  const totals = d.labels.map((_, i) => d.series.reduce((a, x) => a + x.values[i], 0));
  const whole = d.series.every((x) => x.values.every(Number.isInteger)) && (d.goal === undefined || Number.isInteger(d.goal));
  // Columns and areas stand on zero; a line that stays well above it may start nearer its values.
  const data = [...top.flat(), ...(stacked ? base.flat() : []), ...(d.goal !== undefined ? [d.goal] : [])];
  const floatLine = d.kind === "line" && Math.min(...data) > 0 && Math.min(...data) > Math.max(...data) * 0.45;
  const all = floatLine ? [Math.min(...data) - (Math.max(...data) - Math.min(...data)) * 0.15, ...data] : [...data, 0];
  const { min, max, ticks } = niceScale(Math.min(...all), Math.max(...all), 3, whole);

  // Columns that all carry their value need no grid; otherwise three hairlines with small ticks.
  const groups = stacked || d.kind !== "bar" ? 1 : m;
  const valuedBars = d.kind === "bar" && n * groups <= 16;
  const H = W < 480 ? 176 : 204;
  const T = 22, B = n > 1 ? 24 : 20;
  const tickLabels = ticks.map(axisFormat(ticks));
  const L = valuedBars ? 2 : Math.ceil(Math.max(...tickLabels.map((t) => textW(t, 10.5)))) + 10;

  // Lines are named where they end; when the names would take too much of a narrow chart, a legend does it.
  const ends = lineLike && !stacked ? d.series.map((ser, si) => ({ si, v: top[si][n - 1], text: compact(ser.values[n - 1]), name: single ? "" : ser.name })) : [];
  const endW = (e: { text: string; name: string }) => textW(e.text, 11.5) + (e.name ? textW(e.name, 11) + 6 : 0);
  let named = ends.length > 0 && !single;
  let R = ends.length ? Math.ceil(Math.max(...ends.map(endW))) + 14 : 8;
  if (named && R > W * 0.3) {
    named = false;
    R = Math.ceil(Math.max(...ends.map((e) => textW(e.text, 11.5)))) + 14;
  }
  if (!named) ends.forEach((e) => (e.name = ""));
  const needLegend = m > 1 && !named;

  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const band = (W - L - R) / n;
  const cx = (i: number) => L + band * (i + 0.5);
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": ariaSummary(d) });

  if (!valuedBars) ticks.forEach((t, k) => {
    if (t !== 0) svg.append(s(doc, "line", { x1: L, x2: W - R + (ends.length ? 4 : 0), y1: Math.round(y(t)) + 0.5, y2: Math.round(y(t)) + 0.5, class: "oc-grid" }));
    svg.append(s(doc, "text", { x: L - 8, y: y(t) + 3.5, "text-anchor": "end", class: "oc-axis" }, tickLabels[k]));
  });
  // A band highlight under the marks, moved on hover.
  const wash = s(doc, "rect", { x: 0, y: T - 8, width: 0, height: H - T - B + 8, rx: 4, class: "oc-wash", visibility: "hidden" });
  svg.append(wash);

  // The labels along the bottom, as many as fit; one tick per label on the baseline.
  const y0 = Math.round(y(Math.max(0, min))) + 0.5;
  const labelW = Math.max(...d.labels.map((l) => textW(shortLabel(l), 10.5))) + 10;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((W - L - R) / Math.max(28, Math.min(110, labelW))))));
  // Every `every`-th label, and the last one (in place of the one before it when they would touch).
  const shown = new Set<number>();
  for (let i = 0; i < n; i += every) shown.add(i);
  const lastShown = Math.max(...shown);
  if (lastShown !== n - 1) {
    if (n - 1 - lastShown < every * 0.75 && lastShown !== 0) shown.delete(lastShown);
    shown.add(n - 1);
  }
  d.labels.forEach((l, i) => {
    if (n > 6) svg.append(s(doc, "line", { x1: Math.round(cx(i)) + 0.5, x2: Math.round(cx(i)) + 0.5, y1: y0, y2: y0 + 3, class: "oc-tick" }));
    if (!shown.has(i)) return;
    const t = clip(shortLabel(l), Math.max(36, band * every - 6), 10.5);
    const half = textW(t, 10.5) / 2;
    svg.append(s(doc, "text", { x: Math.max(half, Math.min(W - half, cx(i))), y: H - 6, "text-anchor": "middle", class: "oc-axis" }, t));
  });

  const marks = s(doc, "g");
  svg.append(marks);
  const keyPoints: { x: number; y: number; text: string; color: string; below?: boolean }[] = [];
  if (lineLike) {
    // Which points to write: the highlighted one, else the highest; the last always (at the line's end).
    const peak = (vals: number[]) => (hl >= 0 ? hl : vals.indexOf(Math.max(...vals)));
    // Small counts (a few a day) go point to point: a curve between 0 and 1 would invent the values between.
    const path = whole && Math.max(...top.flat()) <= 20 ? (pts: [number, number][]) => pts.map(([x, yy], i) => `${i ? "L" : "M"}${x},${yy}`).join(" ") : smooth;
    d.series.forEach((ser, si) => {
      const color = seriesColor(ser, si);
      const pts = top[si].map((v, i) => [cx(i), y(v)] as [number, number]);
      if (d.kind === "area") {
        if (single && band >= 3) {
          // One hairline per label from the floor to the line: the area is made of countable days.
          for (const [px, py] of pts) marks.append(s(doc, "line", { x1: px, x2: px, y1: y(0), y2: py, stroke: color, "stroke-width": 1, opacity: 0.32 }));
        } else {
          const lower = stacked ? base[si].map((v, i) => [cx(i), y(v)] as [number, number]).reverse() : ([[cx(n - 1), y(0)], [cx(0), y(0)]] as [number, number][]);
          const back = stacked ? path(lower).replace(/^M/, "L") : lower.map(([x, yy]) => `L${x},${yy}`).join(" ");
          marks.append(s(doc, "path", { d: `${path(pts)} ${back} Z`, fill: color, "fill-opacity": stacked ? 0.5 : single ? 0.12 : 0.07, stroke: "none" }));
        }
      }
      marks.append(s(doc, "path", { d: path(pts), fill: "none", stroke: color, "stroke-width": single ? 1.5 : 1.75, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      // One small dot per label when a single line has few enough to count.
      if (single && d.kind === "line" && n <= 45 && band >= 6) pts.forEach(([px, py], i) => i !== n - 1 && marks.append(s(doc, "circle", { cx: px, cy: py, r: n <= 14 ? 2.25 : 1.75, fill: color })));
      if (!stacked) {
        const k = peak(ser.values);
        if (single && k !== n - 1 && n > 2) keyPoints.push({ x: pts[k][0], y: pts[k][1], text: compact(ser.values[k]), color });
        else if (!single && hl >= 0 && hl !== n - 1) keyPoints.push({ x: pts[hl][0], y: pts[hl][1], text: compact(ser.values[hl]), color });
        marks.append(s(doc, "circle", { cx: pts[n - 1][0], cy: pts[n - 1][1], r: 3.5, fill: color, class: "oc-dot" }));
      }
    });
    if (stacked) {
      const k = hl >= 0 ? hl : totals.indexOf(Math.max(...totals));
      keyPoints.push({ x: cx(k), y: y(Math.max(...top.map((t) => t[k]))), text: compact(totals[k]), color: "var(--ink)" });
    }
    // Names and last values at the line ends, pushed apart so they never overlap.
    const placed = ends.map((e) => ({ ...e, ty: y(e.v) })).sort((a, b) => a.ty - b.ty);
    for (let i = 1; i < placed.length; i++) placed[i].ty = Math.max(placed[i].ty, placed[i - 1].ty + 15);
    const over = placed.length ? placed[placed.length - 1].ty - (H - B - 2) : 0;
    if (over > 0) for (const p of placed) p.ty -= over;
    for (let i = placed.length - 2; i >= 0; i--) placed[i].ty = Math.min(placed[i].ty, placed[i + 1].ty - 15);
    for (const p of placed) {
      const x = cx(n - 1) + 8;
      const t = s(doc, "text", { x, y: p.ty + 4, class: "oc-val key" });
      t.textContent = p.text;
      marks.append(t);
      if (p.name) marks.append(s(doc, "text", { x: x + textW(p.text, 11.5) + 5, y: p.ty + 4, class: "oc-name" }, p.name));
    }
  } else {
    const gap = groups > 1 ? 4 : 2;
    const w = Math.max(2, Math.min(single || stacked ? 22 : 14,(band * (single || stacked ? 0.56 : 0.7) - gap * (groups - 1)) / groups));
    // Single series: the emphasised column full strength, the rest lighter; values on every column when they fit, else on the key ones.
    const keyIdx = new Set<number>(hl >= 0 ? [hl] : valuedBars ? [] : [totals.indexOf(Math.max(...totals)), n - 1]);
    d.series.forEach((ser, si) => {
      const color = seriesColor(ser, si);
      ser.values.forEach((v, i) => {
        const x = groups === 1 ? cx(i) - w / 2 : cx(i) - (groups * w + gap * (groups - 1)) / 2 + si * (w + gap);
        const a = y(stacked ? base[si][i] : 0), b = y(top[si][i]);
        let yy = Math.min(a, b), hgt = Math.abs(a - b);
        // Stacked segments: a gap of surface between them; only the outermost end is rounded.
        const outer = !stacked || d.series.every((o, oi) => oi <= si || Math.sign(o.values[i]) !== Math.sign(v) || o.values[i] === 0);
        if (stacked && !outer && hgt > 2.5) {
          if (v >= 0) yy += 1.5;
          hgt -= 1.5;
        }
        if (hgt <= 0) return;
        const p = s(doc, "path", { d: colPath(x, yy, w, hgt, v >= 0, outer ? 2 : 0), fill: color });
        if (single && hl >= 0 && i !== hl) p.setAttribute("class", "oc-dim");
        marks.append(p);
        if (!stacked && (valuedBars || keyIdx.has(i))) {
          const key = keyIdx.has(i) || (single && hl === i);
          marks.append(s(doc, "text", { x: x + w / 2, y: v >= 0 ? yy - 5 : yy + hgt + 12, "text-anchor": "middle", class: key || (valuedBars && single && hl < 0) ? "oc-val key" : "oc-val" }, compact(v)));
        }
      });
    });
    if (stacked) totals.forEach((total, i) => {
      if (!(valuedBars || keyIdx.has(i))) return;
      const hi = Math.min(...top.map((t) => y(t[i])), y(0));
      marks.append(s(doc, "text", { x: cx(i), y: hi - 5, "text-anchor": "middle", class: "oc-val key" }, compact(total)));
    });
  }
  // The written key points: a solid dot and its value above (below when it would leave the chart).
  for (const k of keyPoints) {
    marks.append(s(doc, "circle", { cx: k.x, cy: k.y, r: 3.5, fill: k.color, class: "oc-dot" }));
    marks.append(s(doc, "text", { x: k.x, y: k.y - 8 < T - 12 ? k.y + 16 : k.y - 8, "text-anchor": "middle", class: "oc-val key" }, k.text));
  }
  svg.append(s(doc, "line", { x1: L, x2: W - R + (ends.length ? 4 : 0), y1: y0, y2: y0, class: "oc-base" }));
  if (d.goal !== undefined) {
    const gy = y(d.goal);
    svg.append(s(doc, "line", { x1: L, x2: W - R, y1: gy, y2: gy, class: "oc-goal" }));
    svg.append(s(doc, "text", { x: W - R, y: gy - 5, "text-anchor": "end", class: "oc-axis" }, `目标 ${compact(d.goal)}`));
  }
  const cross = s(doc, "line", { x1: 0, x2: 0, y1: T - 8, y2: H - B, class: "oc-cross", visibility: "hidden" });
  svg.append(cross);
  const hit = s(doc, "rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
  svg.append(hit);

  const clickable = !!(d.links?.some(Boolean) || d.series.some((x) => x.links?.some(Boolean)));
  const plot = h(doc, "div", { class: `oc-plot${clickable ? " clickable" : ""}`, tabindex: 0, "aria-label": `${d.title ?? "图表"}：方向键逐个看数值${clickable ? "，回车打开明细" : ""}` });
  plot.append(svg);
  const tip = tooltip(doc, plot);
  const slotAt = (x: number) => (x < L || x > W - R ? -1 : Math.min(n - 1, Math.max(0, Math.floor((x - L) / band))));
  const scale = () => W / (svg.getBoundingClientRect().width || W);
  hover(
    plot,
    hit,
    n,
    (x) => slotAt(x * scale()),
    (i) => {
      if (lineLike) {
        cross.setAttribute("x1", String(cx(i)));
        cross.setAttribute("x2", String(cx(i)));
        cross.setAttribute("visibility", "visible");
      } else {
        wash.setAttribute("x", String(L + band * i + 1));
        wash.setAttribute("width", String(Math.max(0, band - 2)));
        wash.setAttribute("visibility", "visible");
      }
      const out: TipRow[] = d.series.map((ser, si) => ({ key: seriesColor(ser, si), name: ser.name, value: `${full(ser.values[i])}${unit}`, line: d.kind === "line" }));
      if (stacked) out.push({ key: "transparent", name: "合计", value: `${full(totals[i])}${unit}` });
      tip.show(cx(i) / scale(), Math.min(...top.map((t) => y(t[i]))) / scale(), d.labels[i], out);
    },
    () => {
      cross.setAttribute("visibility", "hidden");
      wash.setAttribute("visibility", "hidden");
      tip.hide();
    },
    clickable
      ? (i, px, py) => {
          // The series under the pointer (a stack's segment, the nearest line), else the label's own records.
          let si = -1;
          if (py >= 0 && m > 1) {
            const v = min + (max - min) * (1 - (py * scale() - T) / (H - T - B));
            if (stacked) si = d.series.findIndex((_, k) => Math.min(base[k][i], top[k][i]) <= v && v <= Math.max(base[k][i], top[k][i]));
            else if (lineLike) si = top.map((t, k) => [Math.abs(t[i] - v), k]).sort((a, b) => a[0] - b[0])[0][1];
            else si = Math.min(m - 1, Math.max(0, Math.floor(((px * scale() - (cx(i) - band * 0.35)) / (band * 0.7)) * m)));
          }
          follow(doc, (si >= 0 ? d.series[si].links?.[i] : undefined) ?? d.links?.[i] ?? d.series.map((x) => x.links?.[i]).find(Boolean));
        }
      : undefined,
  );
  return [needLegend ? legend(doc, d, stacked) : null, plot].filter((x): x is HTMLElement => !!x);
}

/** What a screen reader hears for the picture: the title, the range of labels and each series' total or last value. */
function ariaSummary(d: ChartSpec) {
  const n = d.labels.length;
  const range = n > 1 ? `${d.labels[0]} 到 ${d.labels[n - 1]}` : d.labels[0] ?? "";
  const per = d.series.map((x) => `${x.name} ${d.kind === "line" ? `最后 ${full(x.values[n - 1])}` : `合计 ${full(x.values.reduce((a, b) => a + b, 0))}`}`).join("，");
  return `${d.title ?? "图表"}${d.unit ? `（${d.unit}）` : ""}：${range}；${per}`;
}

// ------------------------------------------------------------------ rows

/**
 * Horizontal bars, one row per label in the given order (rankings, long names, several measures side
 * by side): the name on the left, each value right after its bar, other columns as text at the end.
 * Plain HTML, so names wrap to the room there is, rows can be links and nothing needs redrawing.
 */
function rows(doc: Document, d: ChartSpec): HTMLElement[] {
  const n = d.labels.length;
  const m = d.series.length;
  const stacked = m > 1 && !!d.stack;
  const unit = d.unit ?? "";
  const hl = d.highlight ? d.labels.indexOf(d.highlight) : -1;
  const sums = d.labels.map((_, i) => d.series.reduce((a, x) => a + Math.max(0, x.values[i]), 0));
  const negs = d.labels.map((_, i) => d.series.reduce((a, x) => a + Math.min(0, x.values[i]), 0));
  const vals = stacked ? [...sums, ...negs] : d.series.flatMap((x) => x.values);
  const lo = Math.min(0, ...vals, ...(d.goal !== undefined ? [d.goal] : []));
  const hi = Math.max(0, ...vals, ...(d.goal !== undefined ? [d.goal] : [])) || 1;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const zero = pct(0);
  const valueText = (v: number) => withUnit(v, unit);
  const longest = Math.max(...(stacked ? d.labels.map((_, i) => valueText(d.series.reduce((a, x) => a + x.values[i], 0))) : d.series.flatMap((x) => x.values.map(valueText))).map((t) => t.length));
  const room = `${Math.max(2.4, longest * 0.62 + 1.2)}em`;
  const roomLeft = lo < 0 ? room : "0px";
  // Thin bars; several to a row each get a line tall enough for its value.
  const thick = m === 1 || stacked ? 7 : m === 2 ? 6 : 5;
  const lineH = m > 1 && !stacked ? 13 : thick;
  const extras = d.extras ?? [];
  const labelW = Math.min(16, Math.max(4, Math.max(...d.labels.map((l) => textW(l, 13) / 13)) + 0.6));
  const style = `--label-w:${labelW}em;--zero:calc(${roomLeft} + (100% - ${roomLeft} - ${room}) * ${zero / 100});${extras.length ? `--extras:auto;` : ""}`;
  const list = h(doc, "div", { class: "oc-rows", style, role: "list", "aria-label": ariaSummary(d) });
  if (extras.length) list.append(h(doc, "div", { class: "oc-row head", "aria-hidden": "true" }, h(doc, "span", {}, ""), h(doc, "span", {}, ""), h(doc, "span", { class: "oc-extras", style: `--n:${extras.length}` }, ...extras.map((x) => h(doc, "span", {}, x.name)))));
  if (d.goal !== undefined) {
    list.append(h(doc, "div", { class: "oc-row head", "aria-hidden": "true" }, h(doc, "span", {}, ""), h(doc, "span", { class: "oc-goal-label", style: `margin-left:${roomLeft};margin-right:${room}` }, h(doc, "span", { style: `left:clamp(2.5em, ${pct(d.goal)}%, calc(100% - 2.5em))` }, `目标 ${compact(d.goal)}`)), extras.length ? h(doc, "span", {}, "") : null));
  }
  for (let i = 0; i < n; i++) {
    const rowLink = d.links?.[i];
    const seriesLinked = !rowLink && d.series.some((x) => x.links?.[i]);
    const label = d.labels[i];
    const said = stacked
      ? `${label}：合计 ${full(d.series.reduce((a, x) => a + x.values[i], 0))}${unit}（${d.series.map((x) => `${x.name} ${full(x.values[i])}`).join("，")}）`
      : `${label}：${d.series.map((x) => `${m > 1 ? `${x.name} ` : ""}${full(x.values[i])}${unit}`).join("，")}`;
    const row = linkOr(doc, rowLink, "oc-row", { role: "listitem", "aria-label": said, title: said });
    row.append(h(doc, "span", { class: `oc-row-label${hl === i ? " key" : ""}` }, label));
    const bars = h(doc, "span", { class: "oc-bars", style: `--thick:${thick}px;--line-h:${lineH}px;--room:${room};--room-left:${roomLeft}` });
    const goal = d.goal !== undefined ? h(doc, "span", { class: "oc-goal-v", style: `left:calc(${roomLeft} + (100% - ${roomLeft} - ${room}) * ${pct(d.goal) / 100})` }) : null;
    if (stacked) {
      const track = h(doc, "span", { class: "oc-track" });
      let pos = 0;
      const last = d.series.map((x) => x.values[i] > 0).lastIndexOf(true);
      d.series.forEach((ser, si) => {
        const v = Math.max(0, ser.values[i]);
        if (!v) return;
        const from = pct(pos) , to = pct(pos + v);
        pos += v;
        // A sliver of surface between segments.
        track.append(h(doc, "span", { class: `oc-bar seg${si === last ? " end" : ""}`, style: `left:${from}%;width:calc(${to - from}% - ${si === last ? 0 : 2}px);background:${seriesColor(ser, si)}` }));
      });
      const total = d.series.reduce((a, x) => a + x.values[i], 0);
      track.append(h(doc, "span", { class: "oc-bar-v key", style: `left:${pct(Math.max(0, sums[i]))}%` }, valueText(total)));
      bars.append(track);
    } else {
      d.series.forEach((ser, si) => {
        const v = ser.values[i];
        const href = seriesLinked ? ser.links?.[i] : undefined;
        const track = h(doc, href ? "a" : "span", { class: "oc-track", ...(href ? { href, "aria-label": `${label} ${ser.name} ${full(v)}${unit}` } : {}) });
        const a = pct(Math.min(0, v)), b = pct(Math.max(0, v));
        const dim = m === 1 && hl >= 0 && hl !== i;
        track.append(h(doc, "span", { class: `oc-bar${v < 0 ? " neg" : ""}${dim ? " oc-dim" : ""}`, style: `left:${a}%;width:${Math.max(b - a, v ? 0.4 : 0)}%;background:${seriesColor(ser, si)}` }));
        track.append(h(doc, "span", { class: `oc-bar-v${hl === i ? " key" : ""}`, style: v < 0 ? `right:${100 - a}%` : `left:${b}%` }, valueText(v)));
        bars.append(track);
      });
    }
    if (goal) bars.append(goal);
    row.append(bars);
    if (extras.length) row.append(h(doc, "span", { class: "oc-extras", style: `--n:${extras.length}` }, ...extras.map((x) => {
      const t = x.values[i] ?? "";
      const href = x.links?.[i];
      return href && !rowLink ? h(doc, "a", { href }, t) : h(doc, "span", {}, t || "—");
    })));
    list.append(row);
  }
  return [m > 1 ? legend(doc, d, false) : null, list].filter((x): x is HTMLElement => !!x);
}

// ------------------------------------------------------------------ shares

/** Shares of a whole as a thin ring with the total in its middle, and the parts listed with value and share. */
function donut(doc: Document, d: ChartSpec, W: number): HTMLElement[] {
  const ser = d.series[0];
  const values = ser.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const unit = d.unit ?? "";
  const size = 168, R = 80, r = 64, c0 = size / 2;
  const svg = s(doc, "svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": `${d.title ?? "构成"}：${d.labels.map((l, i) => `${l} ${full(ser.values[i])}${unit}`).join("，")}`, class: "oc-donut" });
  const slices: SVGElement[] = [];
  const pt = (rad: number, a: number) => `${c0 + rad * Math.cos(a)},${c0 + rad * Math.sin(a)}`;
  const parts = values.filter((v) => v > 0).length;
  // A thin gap of surface between slices (angle for about 2px at the outer edge).
  const gapA = parts > 1 ? 2 / R : 0;
  let a0 = -Math.PI / 2;
  values.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const from = a0 + gapA / 2, to = a1 - gapA / 2;
    const large = to - from > Math.PI ? 1 : 0;
    const color = seriesColor({ slot: i }, i);
    const p =
      v >= total
        ? s(doc, "path", { d: `M${c0},${c0 - R} A${R},${R} 0 1 1 ${c0 - 0.01},${c0 - R} L${c0 - 0.01},${c0 - r} A${r},${r} 0 1 0 ${c0},${c0 - r} Z`, fill: color, class: "oc-slice" })
        : s(doc, "path", { d: `M${pt(R, from)} A${R},${R} 0 ${large} 1 ${pt(R, to)} L${pt(r, to)} A${r},${r} 0 ${large} 0 ${pt(r, from)} Z`, fill: color, class: "oc-slice" });
    slices.push(p);
    if (v > 0 && to > from) svg.append(p);
    a0 = a1;
  });
  // The total, unless the parts are already shares of 100.
  if (unit !== "%") {
    svg.append(s(doc, "text", { x: c0, y: c0 + 4, "text-anchor": "middle", class: "oc-total" }, compact(total)));
    svg.append(s(doc, "text", { x: c0, y: c0 + 21, "text-anchor": "middle", class: "oc-axis" }, unit ? `合计（${unit}）` : "合计"));
  }
  const share = (v: number) => `${Math.round((v / total) * 1000) / 10}%`;
  const list = h(doc, "ol", { class: "oc-parts" }, ...d.labels.map((l, i) => {
    const li = h(doc, "li", { "data-i": i }, h(doc, "i", { style: `background:${seriesColor({ slot: i }, i)}` }), h(doc, "span", { class: "oc-part-name" }, l), h(doc, "span", { class: "oc-part-value" }, `${compact(values[i])}${unit === "%" ? "%" : ""}`), h(doc, "span", { class: "oc-part-share" }, share(values[i])));
    const href = d.links?.[i] ?? ser.links?.[i];
    if (href) li.replaceChild(h(doc, "a", { class: "oc-part-name", href }, l), li.children[1]);
    return li;
  }));
  const wrap = h(doc, "div", { class: `oc-donut-wrap${W < 420 ? " narrow" : ""}` });
  const plot = h(doc, "div", { class: "oc-plot", tabindex: 0, "aria-label": `${d.title ?? "构成"}：方向键逐个看数值` });
  plot.append(svg);
  wrap.append(plot, list);
  const tip = tooltip(doc, plot);
  const focus = (i: number) => {
    slices.forEach((p, j) => p.classList.toggle("dim", i >= 0 && j !== i));
    list.querySelectorAll("li").forEach((li, j) => li.classList.toggle("on", j === i));
  };
  hover(
    plot,
    svg,
    d.labels.length,
    (x, yy) => {
      const k = size / (svg.getBoundingClientRect().width || size);
      const px = x * k - c0, py = yy * k - c0;
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
      tip.show(size * 0.75, size / 2, d.labels[i], [{ key: seriesColor({ slot: i }, i), name: share(values[i]), value: `${full(ser.values[i])}${unit}` }]);
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
  return [wrap];
}

// ------------------------------------------------------------------ figures

/** Which way a metric moved: as given, else read off the start of its change (src/agents/ui-blocks.ts, metricTrend). */
export function trendOf(m: Pick<MetricItem, "trend" | "change">): "up" | "down" | "flat" | null {
  if (m.trend) return m.trend;
  const c = m.change?.trim();
  if (!c) return null;
  if (/^[+＋↑▲]/.test(c)) return /^[+＋]\s*0+(\.0+)?(?![\d.])/.test(c) ? "flat" : "up";
  if (/^[-−–↓▼]/.test(c)) return /^[-−–]\s*0+(\.0+)?(?![\d.])/.test(c) ? "flat" : "down";
  return /^(持平|不变|0+(\.0+)?%?$)/.test(c) ? "flat" : null;
}

/** A recent course as a hairline with a dot on its last value. */
export function sparkline(doc: Document, values: number[], label?: string) {
  ensureChartStyle(doc);
  const W = 140, H = 28, P = 3;
  // A small wobble stays small: the line spans at least a fifth of the level it moves around.
  const mid = (Math.min(...values) + Math.max(...values)) / 2;
  const span = Math.max(Math.max(...values) - Math.min(...values), Math.abs(mid) * 0.2) || 1;
  const lo = mid - span / 2, hi = mid + span / 2;
  const x = (i: number) => P + ((W - 2 * P) * i) / Math.max(1, values.length - 1);
  const y = (v: number) => P + (H - 2 * P) * (1 - (v - lo) / (hi - lo));
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, class: "oc-spark", ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }) });
  svg.append(s(doc, "path", { d: smooth(pts), class: "oc-spark-line" }));
  const [ex, ey] = pts[pts.length - 1];
  svg.append(s(doc, "circle", { cx: ex, cy: ey, r: 2.25, class: "oc-spark-dot" }));
  return svg;
}

/** One figure: its label, the number, the change (arrow, and green or red by whether that way is good) with its basis, and its recent course. */
function metricEl(doc: Document, m: MetricItem) {
  const t = trendOf(m);
  const tone = !t ? "" : t === "flat" || m.good === "none" ? "neutral" : t === (m.good ?? "up") ? "good" : "bad";
  const change = m.change?.trim();
  const arrow = change && t && !/^[↑↓→▲▼]/.test(change) ? `${{ up: "↑", down: "↓", flat: "→" }[t]} ` : "";
  const el = linkOr(doc, m.link, "oc-metric", { title: m.hint });
  el.append(
    h(doc, "span", { class: "oc-mlabel" }, m.label),
    h(doc, "span", { class: "oc-mvalue" }, h(doc, "b", {}, String(m.value)), m.unit?.trim() ? h(doc, "span", {}, m.unit.trim()) : null),
  );
  if (change || m.note) el.append(h(doc, "span", { class: "oc-mfoot" }, change ? h(doc, "span", { class: "oc-delta", "data-tone": tone || "neutral" }, `${arrow}${change}`) : null, m.note ? h(doc, "span", {}, m.note) : null));
  if (m.spark && m.spark.length > 1) el.append(sparkline(doc, m.spark, `${m.label}最近的走势：${m.spark.map(full).join("、")}`));
  return el;
}

/** A row of figures divided by hairlines: as even as the count allows (up to four in a row), two to a row when narrow. */
export function metricsElement(doc: Document, g: MetricGroup) {
  ensureChartStyle(doc);
  const n = g.items.length;
  const cols = n <= 4 ? n : n <= 6 ? 3 : 4;
  return h(doc, "div", { class: "oc-mgroup" },
    g.title ? h(doc, "span", { class: "oc-mtitle" }, g.title) : null,
    h(doc, "div", { class: "oc-metrics", style: `--cols:${cols};--cols-narrow:${Math.min(2, n)}` }, ...g.items.map((m) => metricEl(doc, m))),
    g.note ? h(doc, "p", { class: "oc-note" }, g.note) : null);
}
