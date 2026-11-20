/**
 * omem's charts and figures, drawn without a framework (docs/v2/interactive-ui.md, “图表的样子”).
 * One drawing for every place that shows a chart: component blocks (blocks.ts, so agents' `show`
 * and plugin pages), and omem's own pages through the thin Vue components in
 * web/src/components/charts/. Feishu cards cannot run this; src/channels/lark-ui.ts builds a VChart
 * spec in the same colours.
 *
 * The look is “countable units”: the unit a reader would count is drawn as a mark of its own.
 * - Columns are ladders of thin rungs, one rung a unit (or a round number of units, said under the
 *   chart), every fifth rung heavier; the value is written on top.
 * - Rows are runs of short upright ticks, the value at the end of the run.
 * - A line has a dot per point (hollow on weekends for days), a barcode of one tick per label on its
 *   floor, and its highest and last points written beside a larger dot.
 * - An area is a hairline per point from the floor up to an outline, the peak's hairline drawn in.
 * - Shares are a dial of a hundred ticks, one tick a percent, coloured by part, named around the rim.
 * - Figures are large numbers under a small spaced label, with a course drawn the same way.
 * Colour: one series is the blue ramp (`--chart-seq-*`); several are the categorical slots
 * `--chart-1`…`--chart-8`, named on the chart; `--chart-accent` marks the one thing to look at (the
 * highlighted label, a peak, what passes a goal). No frames, no fills behind the marks.
 * Motion: when a chart first comes into view its marks are drawn in once (rungs climb, lines are
 * stroked, hairlines rise, the dial sweeps, numbers count up), about a second, never looping; not at
 * all under `prefers-reduced-motion`, inside `[data-chart-still]`, with `<html data-chart-motion="off">`
 * or after `setChartMotion(false)`. On hover the pointed mark stays and the rest fade.
 * Every chart can be read without colour or pointer: values on the marks, a tooltip that the arrow
 * keys step through, and the numbers as a table (“看数据”).
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
  /** A label to emphasise: its mark in the accent colour with the value written beside it. */
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
  /** A short word beside the label in a warm pill (“待确认”). */
  tag?: string;
  /** No number yet: this line (“还没取到 · 下次 02:50”) stands where the number would, at its height, instead of a dash. */
  pending?: string;
};
/** `even`: every figure the same shape — the label at most two lines, the line under the number one — so a grid of many lines up. */
export type MetricGroup = { title?: string; items: MetricItem[]; note?: string; even?: boolean };
/** `select`: every figure is a button that opens its details (omem's own pages); the page marks the open one with `aria-expanded`. */
export type MetricsOptions = { select?: (index: number) => void };

const EASE = "cubic-bezier(.22,.7,.25,1)";
const CSS = `
.oc { display: grid; gap: 10px; min-width: 0; color: var(--ink); }
.oc-head { display: grid; gap: 2px; min-width: 0; }
.oc-title { font-size: 14px; font-weight: 650; letter-spacing: -0.005em; color: var(--ink); overflow-wrap: anywhere; }
.oc-sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.oc-note { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.oc-foot { margin: 0; font-size: 10.5px; letter-spacing: .14em; color: var(--muted); opacity: .85; text-align: center; overflow-wrap: anywhere; }
.oc-plot { position: relative; outline: none; border-radius: 6px; min-width: 0; }
.oc-plot:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.oc-plot > svg { width: 100%; height: auto; display: block; overflow: visible; touch-action: pan-y; }
.oc-plot.clickable > svg { cursor: pointer; }
.oc-base { stroke: var(--chart-axis); stroke-width: 1; shape-rendering: crispEdges; }
.oc-tick { stroke: var(--chart-axis); stroke-width: 1; shape-rendering: crispEdges; }
.oc-tick.major { stroke: var(--muted); }
.oc-goal { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 3; opacity: .75; }
.oc-cross { stroke: var(--ink-2); stroke-width: 1; opacity: .55; shape-rendering: crispEdges; }
.oc-axis { fill: var(--muted); font: 500 10px var(--sans); letter-spacing: .1em; }
.oc-val { fill: var(--ink-2); font: 500 10.5px var(--sans); font-variant-numeric: tabular-nums; }
.oc-val.key { fill: var(--ink); font-weight: 700; font-size: 12px; }
.oc-val.accent { fill: var(--chart-accent); }
.oc-name { fill: var(--muted); font: 500 10.5px var(--sans); letter-spacing: .08em; }
.oc-dot { stroke: var(--chart-surface, var(--panel)); stroke-width: 1.5; }
.oc-hollow { fill: var(--chart-surface, var(--panel)); stroke-width: 1.25; }
.oc-rung { shape-rendering: crispEdges; }
.oc-col, .oc-series, .oc-part { transition: opacity .18s; }
.oc-hovering .oc-col:not(.on), .oc-hovering .oc-series:not(.on), .oc-hovering .oc-part:not(.on) { opacity: .26; }
.oc-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 11.5px; letter-spacing: .06em; color: var(--ink-2); }
.oc-key { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.oc-key i { width: 9px; height: 7px; flex: none; background: repeating-linear-gradient(to bottom, var(--k) 0 1.5px, transparent 1.5px 3px); }
.oc-key i.line { height: 2px; width: 12px; background: var(--k); }
.oc-key b { font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: 0; }
.oc-tip { position: absolute; z-index: 3; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 7px 10px; font-size: 12px; line-height: 1.5; min-width: 110px; white-space: nowrap; }
.oc-tip-title { color: var(--muted); margin-bottom: 2px; letter-spacing: .06em; font-size: 11px; }
.oc-tip-row { display: flex; align-items: center; gap: 8px; }
.oc-tip-row i { width: 8px; height: 2px; flex: none; }
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
.oc-rows { display: grid; gap: 1px; min-width: 0; --label-w: 9.5em; }
.oc-row { display: grid; grid-template-columns: minmax(0, var(--label-w)) minmax(48px, 1fr) var(--extras, 0); align-items: center; column-gap: 14px; padding: 4px 0; font-size: 13px; color: inherit; text-decoration: none; min-width: 0; transition: opacity .18s; }
.oc-row.head { padding-top: 0; padding-bottom: 0; font-size: 10.5px; letter-spacing: .1em; color: var(--muted); }
.oc-rows:hover > .oc-row:not(.head):not(:hover) { opacity: .4; }
a.oc-row:focus-visible, .oc-row a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 2px; }
a.oc-row:hover .oc-row-label { text-decoration: underline; text-underline-offset: 2px; }
.oc-row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.oc-row-label.key { color: var(--ink); font-weight: 650; }
.oc-bars { position: relative; display: grid; gap: 3px; min-width: 0; padding: 1px 0; }
.oc-track { position: relative; height: 14px; margin-right: var(--room, 3em); margin-left: var(--room-left, 0); display: block; color: inherit; text-decoration: none; }
.oc-bars.multi { gap: 4px; padding: 3px 0; }
.oc-row.multi { padding: 7px 0; }
.oc-row.multi + .oc-row.multi { border-top: 1px solid var(--chart-grid); }
.oc-bars.multi .oc-track { height: 11px; }
.oc-bars.multi .oc-bar-v { font-size: 11px; }
.oc-ticks { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.oc-ticks line { vector-effect: non-scaling-stroke; shape-rendering: crispEdges; }
.oc-thin { position: absolute; top: 50%; height: 2px; transform: translateY(-50%); }
.oc-bar-v { position: absolute; top: 50%; transform: translateY(-50%); padding: 0 7px; font-size: 11.5px; line-height: 1; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.oc-bar-v.key { color: var(--ink); font-weight: 700; }
.oc-bar-v small { margin-left: 5px; font-size: 10.5px; letter-spacing: .08em; color: var(--muted); font-weight: 500; }
.oc-goal-v { position: absolute; top: -5px; bottom: -5px; border-left: 1px dashed var(--ink-2); opacity: .5; pointer-events: none; }
.oc-goal-label { position: relative; height: 14px; font-size: 10.5px; letter-spacing: .1em; color: var(--muted); }
.oc-goal-label span { position: absolute; bottom: 0; transform: translateX(-50%); white-space: nowrap; }
.oc-extras { display: grid; grid-template-columns: repeat(var(--n, 1), minmax(3.6em, auto)); column-gap: 12px; justify-content: end; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.oc-extras a { color: inherit; text-decoration: none; }
.oc-extras a:hover { text-decoration: underline; }
.oc-extras small { margin-left: 2px; font-size: 11px; color: var(--muted); }
/* shares */
.oc-total { fill: var(--ink); font: 650 26px var(--sans); letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
/* figures */
.oc-mgroup { display: grid; gap: 10px; min-width: 0; container-type: inline-size; }
.oc-mtitle { font-size: 14px; font-weight: 650; }
.oc-metrics { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); row-gap: 18px; overflow: hidden; }
@container (max-width: 520px) { .oc-metrics { grid-template-columns: repeat(var(--cols-narrow, 2), minmax(0, 1fr)); } }
.oc-metric { display: grid; gap: 3px; align-content: start; min-width: 0; padding: 2px 18px; margin-left: -1px; border-left: 1px solid var(--line); color: inherit; text-decoration: none; }
a.oc-metric, button.oc-metric { border-radius: 0 6px 6px 0; }
button.oc-metric { font: inherit; text-align: left; background: none; border: 0; border-left: 1px solid var(--line); padding-top: 6px; padding-bottom: 8px; cursor: pointer; transition: background-color .15s, box-shadow .15s; }
a.oc-metric:hover, button.oc-metric:hover { background: var(--hover); }
a.oc-metric:focus-visible, button.oc-metric:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
button.oc-metric[aria-expanded="true"] { background: var(--accent-soft, var(--hover)); box-shadow: inset 0 -2px 0 var(--accent); }
.oc-mlabel { color: var(--muted); font-size: 11.5px; letter-spacing: .1em; overflow-wrap: anywhere; }
.oc-mtag { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--warn-soft, var(--hover)); color: var(--warn, var(--ink-2)); font-size: 10.5px; letter-spacing: .04em; line-height: 17px; vertical-align: 1px; white-space: nowrap; }
.oc-mvalue { display: flex; align-items: baseline; gap: 4px; min-width: 0; }
.oc-mvalue b { font: 650 30px/1.15 var(--sans); letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.oc-mvalue span { color: var(--muted); font-size: 12px; letter-spacing: .06em; }
.oc-mfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; font-size: 12px; color: var(--muted); }
.oc-delta { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.oc-delta[data-tone="good"] { color: var(--ok); }
.oc-delta[data-tone="bad"] { color: var(--danger); }
.oc-even .oc-metrics { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
@container (max-width: 520px) { .oc-even .oc-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.oc-mpending { display: flex; align-items: center; min-height: 34.5px; font-size: 12.5px; color: var(--ink-2); }
.oc-even .oc-mlabel { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; line-height: 1.5; }
.oc-even .oc-mfoot { flex-wrap: nowrap; overflow: hidden; white-space: nowrap; }
.oc-even .oc-mfoot > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.oc-even .oc-mfoot > .oc-delta { flex: none; }
.oc-spark { width: 100%; max-width: 150px; height: auto; display: block; margin-top: 6px; overflow: visible; }
.oc-spark-hair { stroke: var(--chart-seq-2); stroke-width: 1; }
.oc-spark-line { fill: none; stroke: var(--chart-seq-3); stroke-width: 1.25; stroke-linejoin: round; stroke-linecap: round; }
.oc-spark-dot { fill: var(--chart-seq-4); }
@media (max-width: 520px) { .oc-mvalue b { font-size: 26px; } .oc-rows { --label-w: 7em; } }
/* entrance: drawn in once, paused until the chart is in view */
.oc-anim .oc-m { animation-duration: var(--t, 220ms); animation-timing-function: ${EASE}; animation-fill-mode: both; animation-delay: var(--d, 0ms); animation-play-state: paused; }
.oc-anim.oc-run .oc-m { animation-play-state: running; }
.oc-anim .oc-m.in { animation-name: oc-in; }
.oc-anim .oc-m.up { animation-name: oc-up; }
.oc-anim .oc-m.grow { animation-name: oc-grow; transform-box: fill-box; transform-origin: 50% 100%; }
.oc-anim .oc-m.draw { animation-name: oc-draw; animation-timing-function: cubic-bezier(.45,.05,.35,1); }
.oc-anim .oc-m.wipe { animation-name: oc-wipe; animation-timing-function: cubic-bezier(.3,.6,.3,1); }
.oc-anim .oc-m.pop { animation-name: oc-pop; transform-box: fill-box; transform-origin: center; }
@keyframes oc-in { from { opacity: 0; } }
@keyframes oc-up { from { opacity: 0; transform: translateY(4px); } }
@keyframes oc-grow { from { transform: scaleY(0); } }
@keyframes oc-draw { from { stroke-dashoffset: 1; } }
@keyframes oc-wipe { from { clip-path: inset(0 100% 0 0); } }
@keyframes oc-pop { from { opacity: 0; transform: scale(.3); } }
@media (prefers-reduced-motion: reduce) { .oc-anim .oc-m { animation: none !important; } }
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
function s(doc: Document, tag: string, attrs: Record<string, string | number | undefined> = {}, text?: string) {
  const el = doc.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
/** A link when there is somewhere to go, a plain element otherwise. */
const linkOr = (doc: Document, href: string | undefined, cls: string, attrs: Attrs = {}) => h(doc, href ? "a" : "div", { class: cls, ...(href ? { href } : {}), ...attrs });
/** Mark an element for the entrance: its animation (in, up, grow, draw, wipe, pop), when it starts and how long it takes. */
function anim(el: Element, kind: string, delay: number, dur?: number) {
  el.classList.add("oc-m", kind);
  const style = `--d:${Math.round(delay)}ms${dur ? `;--t:${Math.round(dur)}ms` : ""}`;
  const prev = el.getAttribute("style");
  el.setAttribute("style", prev ? `${prev};${style}` : style);
  return el;
}

// ------------------------------------------------------------------ motion

let motionOn = true;
/** Turn the entrance motion off (or back on) for charts drawn from now on, e.g. for screenshots. */
export function setChartMotion(on: boolean) {
  motionOn = on;
}
function motionWanted(doc: Document) {
  const win = doc.defaultView;
  if (!motionOn || !win || typeof win.IntersectionObserver === "undefined") return false;
  if (doc.documentElement.dataset.chartMotion === "off") return false;
  return !(typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
/**
 * Hold `el`'s marked marks at their start until it first comes into view, then play them once and
 * run `start` (numbers counting up). Returns a stop for the observer.
 */
function playWhenSeen(el: HTMLElement, start?: () => void): () => void {
  const doc = el.ownerDocument;
  if (!motionWanted(doc)) return () => {};
  el.classList.add("oc-anim");
  const io = new (doc.defaultView as Window & typeof globalThis).IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    if (el.closest("[data-chart-still]")) return el.classList.remove("oc-anim");
    el.classList.add("oc-run");
    start?.();
    // Once played, the marks are plain again (a redraw or a theme change does not replay them).
    const longest = Math.max(0, ...Array.from(el.querySelectorAll<HTMLElement | SVGElement>(".oc-m")).map((m) => (parseFloat(m.style.getPropertyValue("--d")) || 0) + (parseFloat(m.style.getPropertyValue("--t")) || 220)));
    setTimeout(() => el.classList.remove("oc-anim", "oc-run"), longest + 60);
  }, { threshold: 0.2 });
  io.observe(el);
  return () => io.disconnect();
}
/** A number in `el` counted up from zero to what it says, in the same format (digits after the point, separators, a suffix like 万). */
function countUp(el: Element, dur = 800) {
  const text = el.textContent ?? "";
  const m = text.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
  const win = el.ownerDocument.defaultView;
  if (!m || !win) return;
  const target = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(target) || target === 0) return;
  const decimals = (m[2].split(".")[1] ?? "").length;
  const grouped = m[2].includes(",");
  const fmt = (v: number) => `${m[1]}${grouped ? v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : v.toFixed(decimals)}${m[3]}`;
  const t0 = win.performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = p >= 1 ? text : fmt(target * (1 - (1 - p) ** 3));
    if (p < 1) win.requestAnimationFrame(step);
  };
  win.requestAnimationFrame(step);
}

// ------------------------------------------------------------------ numbers

/** Every digit of a value (tooltips, the data table). */
export const full = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
/** A value where room is short (labels on marks, a dial's total): 1.2万, 3.4亿. */
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
/**
 * How much one rung (or tick) is worth: one unit while the largest value is small enough to count
 * (at most `most` of them), else the smallest of 1, 2, 5 × 10ⁿ that keeps it to `most`, so the
 * largest mark has about half to all of that many.
 */
export function rungUnit(largest: number, whole: boolean, most = 45): number {
  const top = Math.abs(largest);
  if (!(top > 0)) return 1;
  if (whole && top <= most) return 1;
  let mag = 10 ** Math.floor(Math.log10(top / most));
  for (let k = 0; k < 40; k++, mag *= 10) {
    for (const m of [1, 2, 5]) {
      const u = Number((m * mag).toPrecision(6));
      if (top / u <= most && (!whole || u >= 1)) return u;
    }
  }
  return top;
}
/** A hundred ticks shared out by value (largest remainder), every part above zero getting at least one. */
export function dialTicks(values: number[], ticks = 100): number[] {
  const vals = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return vals.map(() => 0);
  const raw = vals.map((v) => (v / total) * ticks);
  const out = raw.map((r, i) => (vals[i] > 0 ? Math.max(1, Math.floor(r)) : 0));
  let left = ticks - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).filter(([, i]) => vals[i] > 0).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  // Parts lifted to one may have overshot: take back from the largest.
  while (left < 0) {
    const big = out.indexOf(Math.max(...out));
    out[big]--;
    left++;
  }
  return out;
}
/** Rough rendered width of a label at 10–12px (CJK twice as wide), for laying out before drawing. */
const textW = (t: string, px = 11, spacing = 0) => Array.from(t).reduce((n, ch) => n + (ch.codePointAt(0)! > 0xff ? px : px * 0.6) + spacing, 0);
function clip(t: string, maxW: number, px = 11) {
  if (textW(t, px) <= maxW) return t;
  const chars = Array.from(t);
  while (chars.length > 1 && textW(chars.join("") + "…", px) > maxW) chars.pop();
  return chars.join("") + "…";
}
/** Dates on an axis: 2026-11-03 reads 11-03 (the year is in the title or the range). */
const shortLabel = (l: string) => l.replace(/^\d{4}-(\d{2})-(\d{2})(?!\d)/, "$1-$2");
/** Labels that are consecutive days give their weekdays (0 Sunday … 6 Saturday); anything else gives null. */
function weekdays(labels: string[]): number[] | null {
  if (labels.length < 2) return null;
  const t = labels.map((l) => (/^\d{4}-\d{2}-\d{2}$/.test(l) ? Date.parse(`${l}T00:00:00Z`) : NaN));
  if (t.some((x) => !Number.isFinite(x))) return null;
  for (let i = 1; i < t.length; i++) if (Math.round((t[i] - t[i - 1]) / 86400_000) !== 1) return null;
  return t.map((x) => new Date(x).getUTCDay());
}
const polyline = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
/**
 * A smooth line through the points that never overshoots them (monotone cubic): it does not dip
 * below zero between two zeros or rise above a peak, so the curve shows no value the data lacks.
 */
export function curve(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 3) return polyline(pts);
  const h: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1][0] - pts[i][0]);
    m.push(h[i] ? (pts[i + 1][1] - pts[i][1]) / h[i] : 0);
  }
  // Tangents: flat at a turn, otherwise the weighted harmonic mean of the two slopes around the point.
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / m[i - 1] + (h[i] + 2 * h[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], k = h[i] / 3;
    d += ` C${(x0 + k).toFixed(1)},${(y0 + t[i] * k).toFixed(1)} ${(x1 - k).toFixed(1)},${(y1 - t[i + 1] * k).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}
const fmtUnit = (u: number, unit: string) => `${full(u)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;

/** A series' colour among several: its slot, else its position. */
export const seriesColor = (ser: Pick<ChartSeries, "slot"> | undefined, i: number) => `var(--chart-${(((ser?.slot ?? i) % 8) + 8) % 8 + 1})`;
/** The colour of a chart's series: the blue of a single series, the categorical slots for several. */
const colorOf = (d: ChartSpec, si: number) => (d.series.length === 1 ? "var(--chart-seq-3)" : seriesColor(d.series[si], si));
const ACCENT = "var(--chart-accent)";

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
  // Rows already show every value as text; the others fold their numbers into a table.
  const table = d.table !== false && d.kind !== "hbar";
  el.replaceChildren(...[head, body, note, table ? dataTable(doc, d) : null].filter((x): x is HTMLElement => !!x));
  let stopMotion = () => {};
  let counters: Element[] = [];
  let armed = false, played = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    stopMotion = playWhenSeen(body, () => {
      played = true;
      counters.forEach((c) => countUp(c));
    });
  };
  // Everything is drawn for a width (rows only to pick how much a tick is worth).
  let drawnAt = 0;
  const draw = () => {
    const w = Math.max(240, Math.min(960, Math.round(body.clientWidth || el.clientWidth || 600)));
    if (Math.abs(w - drawnAt) < 8) return;
    // A redraw after the entrance has played draws the marks plain.
    if (played) body.classList.remove("oc-anim", "oc-run");
    drawnAt = w;
    const out = d.kind === "pie" ? dial(doc, d, w) : d.kind === "hbar" ? rows(doc, d, w) : cartesian(doc, d, w);
    counters = Array.from(out.flatMap((x) => Array.from(x.querySelectorAll(".oc-count"))));
    body.replaceChildren(...out);
    arm();
  };
  draw();
  if (typeof ResizeObserver === "undefined") return () => stopMotion();
  const ro = new ResizeObserver(draw);
  ro.observe(body);
  return () => {
    ro.disconnect();
    stopMotion();
  };
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

type TipRow = { key: string; name: string; value: string };
/** The one tooltip of a chart: values lead, series names follow, each keyed by its colour. */
function tooltip(doc: Document, plot: HTMLElement) {
  const tip = h(doc, "div", { class: "oc-tip", role: "status", hidden: true });
  plot.append(tip);
  return {
    show(x: number, y: number, title: string, rowsOut: TipRow[]) {
      tip.replaceChildren(
        h(doc, "div", { class: "oc-tip-title" }, title),
        ...rowsOut.map((r) => h(doc, "div", { class: "oc-tip-row" }, h(doc, "i", { style: `background:${r.key}` }), h(doc, "b", {}, r.value), h(doc, "span", {}, r.name))),
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
function hover(plot: HTMLElement, target: SVGElement, slots: number, at: (x: number, y: number) => number, show: (i: number, y: number) => void, hide: () => void, open?: (i: number, x: number, y: number) => void) {
  let current = -1;
  const go = (i: number, y = -1) => {
    if (i === current && y < 0) return;
    current = i;
    if (i < 0) hide();
    else show(i, y);
  };
  const local = (e: Event) => {
    const r = plot.getBoundingClientRect();
    return [(e as PointerEvent).clientX - r.left, (e as PointerEvent).clientY - r.top] as const;
  };
  target.addEventListener("pointermove", (e) => {
    const [x, y] = local(e);
    go(at(x, y), y);
  });
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

/** A short legend: a key per series (a little ladder for columns, a stroke for lines), with its total when the series add up. */
function legend(doc: Document, d: ChartSpec, totals: boolean) {
  return h(doc, "div", { class: "oc-legend" }, ...d.series.map((ser, si) => h(doc, "span", { class: "oc-key" },
    h(doc, "i", { class: d.kind === "line" ? "line" : "", style: `--k:${colorOf(d, si)}` }),
    ser.name,
    totals ? h(doc, "b", {}, withUnit(ser.values.reduce((a, b) => a + b, 0), d.unit)) : null)));
}

/** Labels at the right of the plot (line ends, a stack's parts), pushed apart so they never overlap and kept inside [top, bottom]. */
function spread<T extends { ty: number }>(items: T[], top: number, bottom: number, gap = 14): T[] {
  const placed = [...items].sort((a, b) => a.ty - b.ty);
  for (let i = 1; i < placed.length; i++) placed[i].ty = Math.max(placed[i].ty, placed[i - 1].ty + gap);
  const over = placed.length ? placed[placed.length - 1].ty - bottom : 0;
  if (over > 0) for (const p of placed) p.ty -= over;
  for (let i = placed.length - 2; i >= 0; i--) placed[i].ty = Math.min(placed[i].ty, placed[i + 1].ty - gap);
  if (placed.length && placed[0].ty < top) {
    const by = top - placed[0].ty;
    for (const p of placed) p.ty += by;
  }
  return placed;
}

// ------------------------------------------------------------------ columns, lines, areas

/** Columns (ladders of rungs), lines and areas over one value axis. */
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
  const data = [...top.flat(), ...(stacked ? base.flat() : []), ...(d.goal !== undefined ? [d.goal] : [])];
  const groups = stacked || d.kind !== "bar" ? 1 : m;
  // Columns are ladders while they can be counted; past sixty a column is a thin solid bar.
  const ladder = d.kind === "bar" && n * groups <= 60;
  const u = ladder ? rungUnit(Math.max(...data.map(Math.abs)), whole) : 1;
  // A line that stays well above zero may start nearer its values; columns and areas stand on zero.
  const floatLine = d.kind === "line" && Math.min(...data) > 0 && Math.min(...data) > Math.max(...data) * 0.45;
  const all = floatLine ? [Math.min(...data) - (Math.max(...data) - Math.min(...data)) * 0.15, ...data] : [...data, 0];
  const sc = ladder
    ? { min: Math.min(0, Math.floor(Math.min(...all) / u) * u), max: Math.max(u, Math.ceil(Math.max(...all) / u) * u), ticks: [] as number[] }
    : niceScale(Math.min(...all), Math.max(...all), 3, whole);
  const { min, max, ticks } = sc;

  const valued = ladder && n * groups <= 16;
  const H = W < 480 ? 188 : 216;
  const T = 26, B = 24;
  const tickLabels = ticks.map(axisFormat(ticks));
  const L = ticks.length ? Math.ceil(Math.max(...tickLabels.map((t) => textW(t, 10, 1)))) + 12 : 4;

  // Lines are named where they end; when the names would take too much of a narrow chart, a legend does it.
  const ends = lineLike && !stacked ? d.series.map((ser, si) => ({ si, v: top[si][n - 1], text: compact(ser.values[n - 1]), name: single ? "" : ser.name })) : [];
  const endW = (e: { text: string; name: string }) => textW(e.text, 12) + (e.name ? textW(e.name, 10.5, 0.8) + 6 : 0);
  let named = ends.length > 0 && !single;
  let R = ends.length ? Math.ceil(Math.max(...ends.map(endW))) + 16 : 8;
  if (named && R > W * 0.3) {
    named = false;
    R = Math.ceil(Math.max(...ends.map((e) => textW(e.text, 12)))) + 16;
  }
  if (!named) ends.forEach((e) => (e.name = ""));
  // A stack names its parts beside the last column when every part is there and there is room.
  const lastParts = stacked && ladder ? d.series.map((ser, si) => ({ si, v: ser.values[n - 1], name: ser.name })) : [];
  const partW = lastParts.length ? Math.ceil(Math.max(...lastParts.map((p) => textW(p.name, 10.5, 0.8)))) + 14 : 0;
  const stackNamed = lastParts.length > 0 && lastParts.every((p) => p.v > 0) && partW < W * 0.24;
  if (stackNamed) R = Math.max(R, partW);
  const needLegend = m > 1 && !named && !stackNamed;

  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const band = (W - L - R) / n;
  const cx = (i: number) => L + band * (i + 0.5);
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": ariaSummary(d) });

  ticks.forEach((t, k) => {
    if (t === 0 && !floatLine) return;
    svg.append(s(doc, "text", { x: L - 10, y: y(t) + 3.5, "text-anchor": "end", class: "oc-axis" }, tickLabels[k]));
    svg.append(s(doc, "line", { x1: L - 6, x2: L - 2, y1: Math.round(y(t)) + 0.5, y2: Math.round(y(t)) + 0.5, class: "oc-tick" }));
  });

  // The floor: a baseline with one tick per label (a barcode of the days, Mondays longer), labels as many as fit.
  const y0 = Math.round(y(floatLine ? min : Math.max(0, min))) + 0.5;
  const days = weekdays(d.labels);
  const labelW = Math.max(...d.labels.map((l) => textW(shortLabel(l), 10, 1))) + 12;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((W - L - R) / Math.max(30, Math.min(120, labelW))))));
  const shown = new Set<number>();
  for (let i = 0; i < n; i += every) shown.add(i);
  const lastShown = Math.max(...shown);
  if (lastShown !== n - 1) {
    if (n - 1 - lastShown < every * 0.75 && lastShown !== 0) shown.delete(lastShown);
    shown.add(n - 1);
  }
  const floor = s(doc, "g");
  svg.append(floor);
  d.labels.forEach((l, i) => {
    if (n > 1 && (lineLike || n > 6)) {
      const major = days ? days[i] === 1 : false;
      floor.append(s(doc, "line", { x1: Math.round(cx(i)) + 0.5, x2: Math.round(cx(i)) + 0.5, y1: y0 + 2, y2: y0 + (major ? 7 : 5), class: `oc-tick${major ? " major" : ""}` }));
    }
    if (!shown.has(i)) return;
    const t = clip(shortLabel(l), Math.max(36, band * every - 6), 10);
    const half = textW(t, 10, 1) / 2;
    floor.append(s(doc, "text", { x: Math.max(half, Math.min(W - half, cx(i))), y: H - 4, "text-anchor": "middle", class: "oc-axis" }, t));
  });

  const marks = s(doc, "g");
  svg.append(marks);
  const keyPoints: { x: number; y: number; text: string; color: string; accent?: boolean; delay: number }[] = [];
  const DRAW = 900;
  const at = (x: number) => ((x - L) / Math.max(1, W - L - R)) * DRAW;
  /** Hover: the groups that stay, the rest fade. */
  const groupsBy: SVGElement[] = [];

  if (lineLike) {
    const dotsOn = d.kind === "line" && pointsOn(d, band);
    d.series.forEach((ser, si) => {
      const color = colorOf(d, si);
      const g = s(doc, "g", { class: "oc-series" });
      groupsBy.push(g);
      marks.append(g);
      const pts = top[si].map((v, i) => [cx(i), y(v)] as [number, number]);
      const peak = hl >= 0 ? hl : ser.values.indexOf(Math.max(...ser.values));
      if (d.kind === "area" && (single || stacked)) {
        // One hairline per label from the floor (or the part below) up to the line: the area is made of countable days.
        pts.forEach(([px, py], i) => {
          const from = stacked ? y(base[si][i]) : y(0);
          if (Math.abs(from - py) < 0.5) return;
          const key = !stacked && i === peak;
          const ln = s(doc, "line", { x1: px, x2: px, y1: from, y2: py, stroke: key ? ACCENT : color, "stroke-width": key ? 1.5 : 1, opacity: key ? 1 : stacked ? 0.75 : 0.5 });
          g.append(anim(ln, "grow", (i / n) * 700, 320));
        });
      } else if (d.kind === "area") {
        // Several areas on their own: the lines, each over the faintest wash of its colour.
        g.append(anim(s(doc, "path", { d: `${curve(pts)} L${cx(n - 1)},${y(0)} L${cx(0)},${y(0)} Z`, fill: color, "fill-opacity": 0.07, stroke: "none" }), "in", 300, 600));
      }
      if (!stacked || si === m - 1) {
        // A stack's outline is the total's.
        const path = s(doc, "path", { d: curve(pts), fill: "none", stroke: stacked ? "var(--ink-2)" : single && d.kind === "area" ? "var(--chart-seq-4)" : color, "stroke-width": single ? 1.5 : 1.75, "stroke-linejoin": "round", "stroke-linecap": "round", pathLength: 1, "stroke-dasharray": "1 2" });
        g.append(anim(path, "draw", 0, DRAW));
      }
      if (dotsOn) pts.forEach(([px, py], i) => {
        if (i === n - 1 || i === peak) return;
        const hollow = days && (days[i] === 0 || days[i] === 6);
        const dot = s(doc, "circle", { cx: px, cy: py, r: n <= 14 ? 2.6 : 2.1, fill: hollow ? undefined : color, stroke: hollow ? color : undefined, class: hollow ? "oc-hollow" : "" });
        g.append(anim(dot, "pop", at(px), 200));
      });
      if (!stacked) {
        if (peak !== n - 1 && (single || hl >= 0)) keyPoints.push({ x: pts[peak][0], y: pts[peak][1], text: compact(ser.values[peak]), color: single ? ACCENT : color, accent: single, delay: at(pts[peak][0]) });
        else if (!single && peak !== n - 1) g.append(anim(s(doc, "circle", { cx: pts[peak][0], cy: pts[peak][1], r: 2.5, fill: color, class: "oc-dot" }), "pop", at(pts[peak][0]), 200));
        g.append(anim(s(doc, "circle", { cx: pts[n - 1][0], cy: pts[n - 1][1], r: 3.75, fill: single ? "var(--chart-seq-4)" : color, class: "oc-dot" }), "pop", DRAW - 60, 240));
      }
    });
    if (stacked) {
      const k = hl >= 0 ? hl : totals.indexOf(Math.max(...totals));
      keyPoints.push({ x: cx(k), y: y(Math.max(...top.map((t) => t[k]))), text: compact(totals[k]), color: "var(--ink)", delay: at(cx(k)) });
    }
    for (const p of spread(ends.map((e) => ({ ...e, ty: y(e.v) })), T - 8, H - B - 2, 15)) {
      const x = cx(n - 1) + 9;
      marks.append(anim(s(doc, "text", { x, y: p.ty + 4, class: "oc-val key" }, p.text), "in", DRAW, 260));
      if (p.name) marks.append(anim(s(doc, "text", { x: x + textW(p.text, 12) + 5, y: p.ty + 4, class: "oc-name" }, p.name), "in", DRAW + 60, 260));
    }
  } else {
    // Columns.
    const gap = groups > 1 ? Math.max(2, Math.min(4, band * 0.06)) : 0;
    const w = Math.max(2, Math.min(single || stacked ? 30 : 16, (band * (single || stacked ? 0.6 : 0.74) - gap * (groups - 1)) / groups));
    const pitch = Math.abs(y(u) - y(0));
    const rungH = pitch >= 10 ? 2.5 : pitch >= 7 ? 2 : pitch >= 4.5 ? 1.5 : 1;
    const peakIdx = totals.indexOf(Math.max(...totals));
    const keyIdx = new Set<number>(hl >= 0 ? [hl] : valued ? [] : [peakIdx, n - 1]);
    // The accent goes on the highlighted column, else on a single series' highest (when there are several to compare).
    const accentCol = single ? (hl >= 0 ? hl : n >= 3 && totals.filter((t) => t === totals[peakIdx]).length === 1 ? peakIdx : -1) : -1;
    const rungsMost = Math.max(1, Math.round((max - Math.min(0, min)) / u));
    const colStagger = Math.min(45, 320 / n);
    const perRung = 560 / rungsMost;
    for (let i = 0; i < n; i++) {
      const col = s(doc, "g", { class: "oc-col" });
      groupsBy.push(col);
      marks.append(col);
      d.series.forEach((ser, si) => {
        const color = single ? (i === accentCol ? ACCENT : "var(--chart-seq-3)") : seriesColor(ser, si);
        const x = groups === 1 ? cx(i) - w / 2 : cx(i) - (groups * w + gap * (groups - 1)) / 2 + si * (w + gap);
        const v = ser.values[i];
        if (!v) return;
        if (!ladder) {
          const a = y(stacked ? base[si][i] : 0), b = y(top[si][i]);
          col.append(anim(s(doc, "rect", { x, y: Math.min(a, b), width: w, height: Math.max(0.5, Math.abs(a - b) - (stacked ? 1 : 0)), fill: color }), "grow", i * colStagger, 420));
          return;
        }
        // Rungs from the part below (zero, or the stack under it) to the value, counted from the floor so every fifth of the column is heavier.
        const sign = v >= 0 ? 1 : -1;
        const from = stacked ? Math.round(Math.abs(base[si][i]) / u) : 0;
        const exact = Math.abs(stacked ? top[si][i] : v) / u;
        const to = stacked ? Math.round(exact) : Math.floor(exact + 1e-9);
        const rest = stacked ? 0 : exact - to;
        const rung = (k: number, width: number) => {
          const ry = y(sign * (k + 0.5) * u);
          const heavy = (k + 1) % 5 === 0;
          const over = single && d.goal !== undefined && (k + 1) * u > d.goal + 1e-9;
          const line = s(doc, "line", { x1: x + (w - width) / 2, x2: x + (w + width) / 2, y1: ry, y2: ry, stroke: over ? ACCENT : color, "stroke-width": heavy ? rungH + 0.75 : rungH, opacity: heavy || width < w ? 1 : single ? 0.58 : 0.82, class: "oc-rung" });
          col.append(anim(line, "up", i * colStagger + k * perRung, 200));
        };
        for (let k = from; k < to; k++) rung(k, w);
        if (rest >= 0.12) rung(to, Math.max(2, w * rest));
      });
      if (!stacked && groups > 1 && (valued || keyIdx.has(i))) {
        d.series.forEach((ser, si) => {
          const v = ser.values[i];
          const x = cx(i) - (groups * w + gap * (groups - 1)) / 2 + si * (w + gap) + w / 2;
          col.append(anim(s(doc, "text", { x, y: v >= 0 ? y(v) - 6 : y(v) + 13, "text-anchor": "middle", class: `oc-val${keyIdx.has(i) ? " key" : ""}` }, compact(v)), "in", i * colStagger + 600, 260));
        });
      } else if (valued || keyIdx.has(i)) {
        const v = totals[i];
        const hi = stacked ? Math.min(...top.map((t) => y(t[i])), y(0)) : y(v);
        const cls = `oc-val${keyIdx.has(i) || valued ? " key" : ""}${i === accentCol ? " accent" : ""}`;
        col.append(anim(s(doc, "text", { x: cx(i), y: v >= 0 ? hi - 7 : y(v) + 14, "text-anchor": "middle", class: cls }, compact(v)), "in", i * colStagger + Math.min(560, Math.abs(v / u) * perRung) + 120, 260));
      }
    }
    if (stackNamed) {
      // Each part of the last column named beside it, at the middle of its rungs.
      const parts = spread(lastParts.map((p) => ({ ...p, ty: y((base[p.si][n - 1] + top[p.si][n - 1]) / 2) })), T, H - B - 4, 13);
      const x0 = cx(n - 1) + w / 2 + 8;
      for (const p of parts) marks.append(anim(s(doc, "text", { x: x0, y: p.ty + 3.5, class: "oc-name", fill: seriesColor(d.series[p.si], p.si) }, p.name), "in", 900, 260));
    }
  }
  // The written key points: a dot and its value above (below when it would leave the chart).
  for (const k of keyPoints) {
    marks.append(anim(s(doc, "circle", { cx: k.x, cy: k.y, r: 4, fill: k.color, class: "oc-dot" }), "pop", k.delay, 260));
    marks.append(anim(s(doc, "text", { x: k.x, y: k.y - 10 < T - 14 ? k.y + 18 : k.y - 10, "text-anchor": "middle", class: `oc-val key${k.accent ? " accent" : ""}` }, k.text), "in", k.delay + 80, 260));
  }
  svg.append(s(doc, "line", { x1: L, x2: W - R + (ends.length ? 4 : 0), y1: y0, y2: y0, class: "oc-base" }));
  if (d.goal !== undefined) {
    const gy = y(d.goal);
    svg.append(s(doc, "line", { x1: L, x2: W - R, y1: gy, y2: gy, class: "oc-goal" }));
    svg.append(s(doc, "text", { x: W - R, y: gy - 5, "text-anchor": "end", class: "oc-axis" }, `目标 ${compact(d.goal)}`));
  }
  const cross = s(doc, "line", { x1: 0, x2: 0, y1: T - 10, y2: y0, class: "oc-cross", visibility: "hidden" });
  const focusDot = s(doc, "circle", { r: 4.5, fill: "none", stroke: "var(--ink)", "stroke-width": 1.25, visibility: "hidden" });
  svg.append(cross, focusDot);
  const hit = s(doc, "rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
  svg.append(hit);

  const clickable = !!(d.links?.some(Boolean) || d.series.some((x) => x.links?.some(Boolean)));
  const plot = h(doc, "div", { class: `oc-plot${clickable ? " clickable" : ""}`, tabindex: 0, "aria-label": `${d.title ?? "图表"}：方向键逐个看数值${clickable ? "，回车打开明细" : ""}` });
  plot.append(svg);
  const tip = tooltip(doc, plot);
  const slotAt = (x: number) => (x < L || x > W - R ? -1 : Math.min(n - 1, Math.max(0, Math.floor((x - L) / band))));
  const scale = () => W / (svg.getBoundingClientRect().width || W);
  const nearestSeries = (i: number, py: number) => (py < 0 || m < 2 ? -1 : top.map((t, k) => [Math.abs(y(t[i]) - py * scale()), k]).sort((a, b) => a[0] - b[0])[0][1]);
  hover(
    plot,
    hit,
    n,
    (x) => slotAt(x * scale()),
    (i, py) => {
      svg.classList.add("oc-hovering");
      if (lineLike) {
        // The readout line follows; the line nearest the pointer stays, the others fade.
        cross.setAttribute("x1", String(cx(i)));
        cross.setAttribute("x2", String(cx(i)));
        cross.setAttribute("visibility", "visible");
        const near = stacked ? -1 : nearestSeries(i, py);
        groupsBy.forEach((g, k) => g.classList.toggle("on", near < 0 || k === near));
        const fs = near >= 0 ? near : single ? 0 : -1;
        if (fs >= 0) {
          focusDot.setAttribute("cx", String(cx(i)));
          focusDot.setAttribute("cy", String(y(top[fs][i])));
          focusDot.setAttribute("visibility", "visible");
        } else focusDot.setAttribute("visibility", "hidden");
      } else groupsBy.forEach((g, k) => g.classList.toggle("on", k === i));
      const out: TipRow[] = d.series.map((ser, si) => ({ key: colorOf(d, si), name: ser.name, value: `${full(ser.values[i])}${unit}` }));
      if (stacked) out.push({ key: "transparent", name: "合计", value: `${full(totals[i])}${unit}` });
      tip.show(cx(i) / scale(), Math.min(...top.map((t) => y(t[i]))) / scale(), d.labels[i], out);
    },
    () => {
      svg.classList.remove("oc-hovering");
      groupsBy.forEach((g) => g.classList.remove("on"));
      cross.setAttribute("visibility", "hidden");
      focusDot.setAttribute("visibility", "hidden");
      tip.hide();
    },
    clickable
      ? (i, px, py) => {
          // The series under the pointer (a stack's part, the nearest line), else the label's own records.
          let si = -1;
          if (py >= 0 && m > 1) {
            const v = min + (max - min) * (1 - (py * scale() - T) / (H - T - B));
            if (stacked) si = d.series.findIndex((_, k) => Math.min(base[k][i], top[k][i]) <= v && v <= Math.max(base[k][i], top[k][i]));
            else if (lineLike) si = nearestSeries(i, py);
            else si = Math.min(m - 1, Math.max(0, Math.floor(((px * scale() - (cx(i) - band * 0.37)) / (band * 0.74)) * m)));
          }
          follow(doc, (si >= 0 ? d.series[si].links?.[i] : undefined) ?? d.links?.[i] ?? d.series.map((x) => x.links?.[i]).find(Boolean));
        }
      : undefined,
  );
  // The reading rule under the chart: what one rung or one dot is.
  const rule = ladder
    ? [`一格 = ${fmtUnit(u, unit)}`, "每五格加粗", d.goal !== undefined && single ? "过目标的格标红" : ""]
    : d.kind === "line" && pointsOn(d, band)
      ? [days ? "一点一天 · 空心是周末" : "一点一个值", "标出最高和最后"]
      : d.kind === "area" && (single || stacked)
        ? [days ? "一根竖线一天" : "一根竖线一个值", single ? "最高的那根加深" : "按种类分段"]
        : [];
  const foot = rule.filter(Boolean).length ? h(doc, "p", { class: "oc-foot" }, rule.filter(Boolean).join(" · ")) : null;
  return [needLegend ? legend(doc, d, stacked) : null, plot, foot].filter((x): x is HTMLElement => !!x);
}
const pointsOn = (d: ChartSpec, band: number) => d.series.length === 1 && d.labels.length <= 45 && band >= 6;

/** What a screen reader hears for the picture: the title, the range of labels and each series' total or last value. */
function ariaSummary(d: ChartSpec) {
  const n = d.labels.length;
  const range = n > 1 ? `${d.labels[0]} 到 ${d.labels[n - 1]}` : d.labels[0] ?? "";
  const per = d.series.map((x) => `${x.name} ${d.kind === "line" ? `最后 ${full(x.values[n - 1])}` : `合计 ${full(x.values.reduce((a, b) => a + b, 0))}`}`).join("，");
  return `${d.title ?? "图表"}${d.unit ? `（${d.unit}）` : ""}：${range}；${per}`;
}

// ------------------------------------------------------------------ rows

/**
 * Rows in the given order (rankings, long names, several measures side by side): the name on the
 * left, a run of short upright ticks (one a unit, every fifth taller) and the value at its end, other
 * columns as text at the end of the row. Plain HTML with a stretched SVG per run, so names wrap to the
 * room there is, rows can be links and nothing needs redrawing. A table of one or two rows is a number
 * and a thin bar: a run of ticks would only look odd there.
 */
function rows(doc: Document, d: ChartSpec, W: number): HTMLElement[] {
  const n = d.labels.length;
  const m = d.series.length;
  const stacked = m > 1 && !!d.stack;
  const unit = d.unit ?? "";
  const hl = d.highlight ? d.labels.indexOf(d.highlight) : -1;
  const sums = d.labels.map((_, i) => d.series.reduce((a, x) => a + Math.max(0, x.values[i]), 0));
  const negs = d.labels.map((_, i) => d.series.reduce((a, x) => a + Math.min(0, x.values[i]), 0));
  const vals = stacked ? [...sums, ...negs] : d.series.flatMap((x) => x.values);
  const whole = vals.every(Number.isInteger);
  const plain = n <= 2 && m === 1;
  // About one tick every four or five pixels of the run at its longest.
  const runW = Math.max(100, W * 0.6 - (d.extras?.length ?? 0) * 70);
  const u = rungUnit(Math.max(...vals.map(Math.abs), ...(d.goal !== undefined ? [Math.abs(d.goal)] : [])), whole, Math.max(12, Math.min(110, Math.round(runW / 4.5))));
  const lo = Math.min(0, Math.floor(Math.min(...vals, ...(d.goal !== undefined ? [d.goal] : [])) / u) * u);
  const hi = Math.max(u, Math.ceil(Math.max(0, ...vals, ...(d.goal !== undefined ? [d.goal] : [])) / u) * u);
  const span = hi - lo;
  const pct = (v: number) => ((v - lo) / span) * 100;
  const valueText = (v: number) => withUnit(v, unit);
  const names = m > 1 && !stacked;
  const longest = Math.max(...(stacked ? d.labels.map((_, i) => valueText(d.series.reduce((a, x) => a + x.values[i], 0))) : d.series.flatMap((x) => x.values.map(valueText))).map((t) => t.length));
  const nameRoom = names ? Math.max(...d.series.map((x) => textW(x.name, 10.5, 0.8) / 12)) + 0.6 : 0;
  const room = `${Math.max(2.4, longest * 0.62 + 1.4 + nameRoom)}em`;
  const roomLeft = lo < 0 ? room : "0px";
  const extras = d.extras ?? [];
  const labelW = Math.min(16, Math.max(4, Math.max(...d.labels.map((l) => textW(l, 13) / 13)) + 0.6));
  const style = `--label-w:${labelW}em;${extras.length ? `--extras:auto;` : ""}`;
  const list = h(doc, "div", { class: "oc-rows", style, role: "list", "aria-label": ariaSummary(d) });
  if (extras.length) list.append(h(doc, "div", { class: "oc-row head", "aria-hidden": "true" }, h(doc, "span", {}, ""), h(doc, "span", {}, ""), h(doc, "span", { class: "oc-extras", style: `--n:${extras.length}` }, ...extras.map((x) => h(doc, "span", {}, x.name)))));
  const S = span / u;
  // Ticks no further apart than seven pixels: a short run stays short instead of stretching.
  const runMax = plain ? "" : `max-width:${Math.ceil(S * 7)}px`;
  if (d.goal !== undefined) {
    list.append(h(doc, "div", { class: "oc-row head", "aria-hidden": "true" }, h(doc, "span", {}, ""), h(doc, "span", {}, h(doc, "span", { class: "oc-goal-label", style: `display:block;margin-left:${roomLeft};margin-right:${room};${runMax}` }, h(doc, "span", { style: `left:${pct(d.goal)}%` }, `目标 ${compact(d.goal)}`))), extras.length ? h(doc, "span", {}, "") : null));
  }
  /** One run of ticks from `from` to `to` (in units, zero at `lo`), in a colour; ticks past the goal in the accent. */
  const run = (svg: SVGElement, from: number, to: number, color: string, accentFrom = Infinity, startK = 0) => {
    const dir = to >= from ? 1 : -1;
    const count = Math.abs(to - from);
    const fullN = Math.floor(count + 1e-9);
    const rest = count - fullN;
    const tick = (k: number, part: number) => {
      const x = from + dir * (k + 0.5);
      const heavy = (startK + k + 1) % 5 === 0;
      const c = (startK + k + 1) * u > accentFrom + 1e-9 ? ACCENT : color;
      svg.append(s(doc, "line", { x1: x, x2: x, y1: heavy ? 0 : 3.5 + (1 - part) * 9.5, y2: 14, stroke: c, "stroke-width": heavy ? 1.6 : 1.1, opacity: heavy || part < 1 ? 1 : 0.7 }));
    };
    for (let k = 0; k < fullN; k++) tick(k, 1);
    if (rest >= 0.12) tick(fullN, Math.max(0.25, rest));
  };
  const runSvg = () => s(doc, "svg", { class: "oc-ticks", viewBox: `0 0 ${S} 14`, preserveAspectRatio: "none", "aria-hidden": "true" });
  for (let i = 0; i < n; i++) {
    const rowLink = d.links?.[i];
    const seriesLinked = !rowLink && d.series.some((x) => x.links?.[i]);
    const label = d.labels[i];
    const said = stacked
      ? `${label}：合计 ${full(d.series.reduce((a, x) => a + x.values[i], 0))}${unit}（${d.series.map((x) => `${x.name} ${full(x.values[i])}`).join("，")}）`
      : `${label}：${d.series.map((x) => `${m > 1 ? `${x.name} ` : ""}${full(x.values[i])}${unit}`).join("，")}`;
    const row = linkOr(doc, rowLink, names ? "oc-row multi" : "oc-row", { role: "listitem", "aria-label": said, title: said });
    row.append(h(doc, "span", { class: `oc-row-label${hl === i ? " key" : ""}` }, label));
    const bars = h(doc, "span", { class: `oc-bars${names ? " multi" : ""}` });
    const delay = Math.min(i * 55, 360);
    // The goal is drawn through each run, at its place on the run's own scale.
    const track = (href?: string, aria?: string) => {
      const t = h(doc, href ? "a" : "span", { class: "oc-track", style: `--room:${room};--room-left:${roomLeft};${runMax}`, ...(href ? { href, "aria-label": aria } : {}) });
      if (d.goal !== undefined) t.append(h(doc, "span", { class: "oc-goal-v", style: `left:${pct(d.goal)}%` }));
      return t;
    };
    if (stacked) {
      const t = track();
      const svg = runSvg();
      let pos = 0;
      d.series.forEach((ser, si) => {
        const v = Math.max(0, ser.values[i]);
        if (!v) return;
        run(svg, (0 - lo) / u + pos / u, (0 - lo) / u + (pos + v) / u, seriesColor(ser, si), Infinity, Math.round(pos / u));
        pos += v;
      });
      t.append(anim(svg, "wipe", delay, 700));
      const total = d.series.reduce((a, x) => a + x.values[i], 0);
      t.append(anim(h(doc, "span", { class: "oc-bar-v key", style: `left:${pct(Math.max(0, sums[i]))}%` }, valueText(total)), "in", delay + 560, 260));
      bars.append(t);
    } else {
      d.series.forEach((ser, si) => {
        const v = ser.values[i];
        const href = seriesLinked ? ser.links?.[i] : undefined;
        const t = track(href, `${label} ${ser.name} ${full(v)}${unit}`);
        const color = m === 1 ? (hl === i ? ACCENT : "var(--chart-seq-3)") : seriesColor(ser, si);
        if (plain) {
          const a = pct(Math.min(0, v)), b = pct(Math.max(0, v));
          t.append(anim(h(doc, "span", { class: "oc-thin", style: `left:${a}%;width:${Math.max(b - a, v ? 0.6 : 0)}%;background:${color}` }), "wipe", delay, 600));
        } else {
          const svg = runSvg();
          run(svg, (0 - lo) / u, (v - lo) / u, color, m === 1 && d.goal !== undefined ? d.goal : Infinity);
          t.append(anim(svg, "wipe", delay + si * 40, 700));
        }
        const key = hl === i || (m === 1 && hl < 0 && n > 2 && v === Math.max(...ser.values) && v > 0);
        const valueEl = h(doc, "span", { class: `oc-bar-v${key ? " key" : ""}`, style: v < 0 ? `right:${100 - pct(v)}%` : `left:${pct(v)}%` }, valueText(v), names ? h(doc, "small", {}, ser.name) : null);
        t.append(anim(valueEl, "in", delay + si * 40 + 520, 260));
        bars.append(t);
      });
    }
    row.append(bars);
    if (extras.length) row.append(h(doc, "span", { class: "oc-extras", style: `--n:${extras.length}` }, ...extras.map((x) => {
      const t = x.values[i] ?? "";
      const href = x.links?.[i];
      return href && !rowLink ? h(doc, "a", { href }, t) : h(doc, "span", {}, t || "—");
    })));
    list.append(row);
  }
  const foot = plain ? null : h(doc, "p", { class: "oc-foot" }, [`一格 = ${fmtUnit(u, unit)}`, "每五格加长", stacked ? "颜色分种类" : "", hl >= 0 && m === 1 ? "红的是要看的那一行" : ""].filter(Boolean).join(" · "));
  return [stacked ? legend(doc, d, true) : null, list, foot].filter((x): x is HTMLElement => !!x);
}

// ------------------------------------------------------------------ shares

/**
 * Shares of a whole as a dial: a hundred ticks round a circle, one tick a percent, coloured by part
 * from twelve o'clock clockwise, each part named with its share at the rim, the total in the middle.
 */
function dial(doc: Document, d: ChartSpec, W: number): HTMLElement[] {
  const ser = d.series[0];
  const values = ser.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const unit = d.unit ?? "";
  const counts = dialTicks(values);
  const narrow = W < 420;
  const R = narrow ? 64 : 78, r = R - (narrow ? 15 : 18);
  const labelRoom = Math.min(150, Math.max(...d.labels.map((l, i) => textW(`${clip(l, 96, 10.5)} · ${Math.round((values[i] / total) * 100)}%`, 10.5, 0.8))) + 22);
  const VW = Math.min(W, Math.max(2 * (R + labelRoom), 2 * R + 40));
  const c0x = VW / 2, c0y = R + 28;
  const VH = 2 * R + 56;
  const share = (v: number) => `${Math.round((v / total) * 1000) / 10}%`;
  const svg = s(doc, "svg", { viewBox: `0 0 ${VW} ${VH}`, role: "img", "aria-label": `${d.title ?? "构成"}：${d.labels.map((l, i) => `${l} ${full(ser.values[i])}${unit}（${share(values[i])}）`).join("，")}`, style: `max-width:${VW}px;margin:0 auto` });
  const parts: SVGElement[] = [];
  const pos = (rad: number, a: number) => [c0x + rad * Math.cos(a), c0y + rad * Math.sin(a)] as const;
  const angle = (t: number) => -Math.PI / 2 + ((t + 0.5) / 100) * Math.PI * 2;
  let t = 0;
  const mids: { i: number; a: number }[] = [];
  counts.forEach((c, i) => {
    const g = s(doc, "g", { class: "oc-part" });
    parts.push(g);
    svg.append(g);
    const color = seriesColor({ slot: i }, i);
    for (let k = 0; k < c; k++, t++) {
      const a = angle(t);
      const tenth = (t + 1) % 10 === 0;
      const [x1, y1] = pos(r, a), [x2, y2] = pos(tenth ? R + 3 : R, a);
      g.append(anim(s(doc, "line", { x1, y1, x2, y2, stroke: color, "stroke-width": narrow ? 1.6 : 1.9, "stroke-linecap": "butt" }), "in", t * 7, 160));
    }
    if (c) mids.push({ i, a: angle(t - c / 2 - 0.5) });
  });
  // Every tenth tick has a dot just outside the rim, to read the dial like a clock.
  for (let k = 9; k < 100; k += 10) {
    const [x, y] = pos(R + 7, angle(k));
    svg.append(anim(s(doc, "circle", { cx: x, cy: y, r: 0.9, fill: "var(--chart-axis)" }), "in", k * 7, 160));
  }
  // Names at the rim, each side pushed apart.
  const placed = mids.map((p) => {
    const right = Math.cos(p.a) >= 0;
    const [ax, ay] = pos(R + 10, p.a);
    return { ...p, right, ax, ay, ty: ay };
  });
  for (const side of [true, false]) {
    const list = spread(placed.filter((p) => p.right === side), 8, VH - 6, 14);
    for (const p of list) {
      const tx = c0x + (side ? 1 : -1) * (R + 18);
      const [lx, ly] = pos(R + 4, p.a);
      const color = seriesColor({ slot: p.i }, p.i);
      svg.append(anim(s(doc, "path", { d: `M${lx},${ly} L${p.ax},${p.ay} L${tx + (side ? -4 : 4)},${p.ty}`, fill: "none", stroke: color, "stroke-width": 1, opacity: 0.7 }), "in", 700, 300));
      const text = s(doc, "text", { x: tx, y: p.ty + 3.5, "text-anchor": side ? "start" : "end", class: "oc-name" });
      const name = clip(d.labels[p.i], Math.max(40, labelRoom - 60), 10.5);
      const n1 = s(doc, "tspan", {}, `${name} · `);
      const n2 = s(doc, "tspan", { fill: "var(--ink)", "font-weight": 650 }, values[p.i] / total < 0.01 ? "<1%" : `${Math.round((values[p.i] / total) * 100)}%`);
      text.append(n1, n2);
      svg.append(anim(text, "in", 760, 300));
    }
  }
  // The total, unless the parts are already shares of 100.
  if (unit !== "%") svg.append(s(doc, "text", { x: c0x, y: c0y + 6, "text-anchor": "middle", class: "oc-total oc-count" }, compact(total)));
  svg.append(s(doc, "text", { x: c0x, y: c0y + (unit !== "%" ? 22 : 4), "text-anchor": "middle", class: "oc-axis" }, unit !== "%" ? (unit ? `合计 · ${unit}` : "合计") : "一格 1%"));
  const plot = h(doc, "div", { class: "oc-plot", tabindex: 0, "aria-label": `${d.title ?? "构成"}：方向键逐个看数值` });
  plot.append(svg);
  const tip = tooltip(doc, plot);
  const focus = (i: number) => {
    svg.classList.toggle("oc-hovering", i >= 0);
    parts.forEach((p, j) => p.classList.toggle("on", j === i));
  };
  hover(
    plot,
    svg,
    d.labels.length,
    (x, yy) => {
      const k = VW / (svg.getBoundingClientRect().width || VW);
      const px = x * k - c0x, py = yy * k - c0y;
      const dist = Math.hypot(px, py);
      if (dist < r - 6 || dist > R + 10) return -1;
      let a = Math.atan2(py, px) + Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      const tick = Math.floor((a / (Math.PI * 2)) * 100);
      let acc = 0;
      for (let i = 0; i < counts.length; i++) {
        acc += counts[i];
        if (tick < acc) return i;
      }
      return counts.length - 1;
    },
    (i) => {
      focus(i);
      const k = VW / (svg.getBoundingClientRect().width || VW);
      tip.show((c0x + R * 0.6) / k, c0y / k, d.labels[i], [{ key: seriesColor({ slot: i }, i), name: share(values[i]), value: `${full(ser.values[i])}${unit}` }]);
    },
    () => {
      focus(-1);
      tip.hide();
    },
  );
  return [plot, h(doc, "p", { class: "oc-foot" }, "一格 = 1% · 从十二点起顺时针 · 每十格一个点")];
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

/** A recent course drawn like an area: a hairline per value up to a thin line, a dot on the last value. */
export function sparkline(doc: Document, values: number[], label?: string) {
  ensureChartStyle(doc);
  const W = 150, H = 30, P = 3;
  // A small wobble stays small: the line spans at least a fifth of the level it moves around.
  const mid = (Math.min(...values) + Math.max(...values)) / 2;
  const span = Math.max(Math.max(...values) - Math.min(...values), Math.abs(mid) * 0.2) || 1;
  const lo = Math.min(mid - span / 2, Math.min(...values) >= 0 ? Math.max(0, mid - span) : mid - span / 2), hi = mid + span / 2;
  const x = (i: number) => P + ((W - 2 * P) * i) / Math.max(1, values.length - 1);
  const y = (v: number) => P + (H - 2 * P) * (1 - (v - lo) / (hi - lo));
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const svg = s(doc, "svg", { viewBox: `0 0 ${W} ${H}`, class: "oc-spark", ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }) });
  if (values.length <= 60) pts.forEach(([px, py], i) => svg.append(anim(s(doc, "line", { x1: px, x2: px, y1: H, y2: py, class: "oc-spark-hair" }), "grow", (i / values.length) * 600, 260)));
  svg.append(anim(s(doc, "path", { d: curve(pts), class: "oc-spark-line", pathLength: 1, "stroke-dasharray": "1 2" }), "draw", 0, 800));
  const [ex, ey] = pts[pts.length - 1];
  svg.append(anim(s(doc, "circle", { cx: ex, cy: ey, r: 2.5, class: "oc-spark-dot" }), "pop", 760, 220));
  return svg;
}

/** One figure: its small spaced label, the number, the change (arrow, and green or red by whether that way is good) with its basis, and its recent course. */
function metricEl(doc: Document, m: MetricItem, select?: () => void) {
  const t = trendOf(m);
  const tone = !t ? "" : t === "flat" || m.good === "none" ? "neutral" : t === (m.good ?? "up") ? "good" : "bad";
  const change = m.change?.trim();
  const arrow = change && t && !/^[↑↓→▲▼]/.test(change) ? `${{ up: "↑", down: "↓", flat: "→" }[t]} ` : "";
  const el = select ? h(doc, "button", { type: "button", class: "oc-metric", title: m.hint, "aria-expanded": "false" }) : linkOr(doc, m.link, "oc-metric", { title: m.hint });
  if (select) el.addEventListener("click", select);
  const value = String(m.value);
  el.append(
    h(doc, "span", { class: "oc-mlabel", title: m.hint ? undefined : m.label }, m.label, m.tag ? h(doc, "span", { class: "oc-mtag" }, m.tag) : null),
    m.pending
      ? h(doc, "span", { class: "oc-mpending" }, m.pending)
      : h(doc, "span", { class: "oc-mvalue", "aria-label": `${value}${m.unit?.trim() ?? ""}` }, h(doc, "b", { class: "oc-count", "aria-hidden": "true" }, value), m.unit?.trim() ? h(doc, "span", { "aria-hidden": "true" }, m.unit.trim()) : null),
  );
  if (change || m.note) el.append(h(doc, "span", { class: "oc-mfoot" }, change ? h(doc, "span", { class: "oc-delta", "data-tone": tone || "neutral" }, `${arrow}${change}`) : null, m.note ? h(doc, "span", {}, m.note) : null));
  if (m.spark && m.spark.length > 1) el.append(sparkline(doc, m.spark, `${m.label}最近的走势：${m.spark.map(full).join("、")}`));
  return el;
}

/** A row of figures divided by hairlines: as even as the count allows (up to four in a row), two to a row when narrow. Numbers count up when first seen. */
export function metricsElement(doc: Document, g: MetricGroup, opts: MetricsOptions = {}) {
  ensureChartStyle(doc);
  const n = g.items.length;
  const cols = n <= 4 ? n : n <= 6 ? 3 : 4;
  const select = opts.select;
  const row = h(doc, "div", { class: "oc-metrics", style: `--cols:${cols};--cols-narrow:${Math.min(2, n)}` }, ...g.items.map((m, i) => metricEl(doc, m, select ? () => select(i) : undefined)));
  const el = h(doc, "div", { class: g.even ? "oc-mgroup oc-even" : "oc-mgroup" },
    g.title ? h(doc, "span", { class: "oc-mtitle" }, g.title) : null,
    row,
    g.note ? h(doc, "p", { class: "oc-note" }, g.note) : null);
  // The observer starts once the element is in a page; a figure never seen stays as written.
  queueMicrotask(() => playWhenSeen(row, () => row.querySelectorAll(".oc-count").forEach((c) => countUp(c))));
  return el;
}
