/**
 * The host's content blocks (src/plugins/generic.ts: form, chart), rendered without a framework so
 * the shell's default plugin page and any plugin page draw them the same way. Text goes in through
 * textContent only. Colors come from omem's tokens; the chart's series colors are the validated
 * categorical slots for light and dark surfaces.
 */
export type BlockView = { id: string; kind: string; status: "open" | "submitted" | "shown"; data: any; answers: Record<string, unknown> | null; result: any };
type Field = { id: string; label: string; type: "text" | "textarea" | "number" | "choice" | "multi" | "scale"; options: string[]; required: boolean; placeholder?: string };

export const GENERIC_KINDS = ["form", "chart"];

const CSS = `
.ob { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius, 10px); padding: 16px 18px; display: grid; gap: 12px; min-width: 0; color: var(--ink); font: inherit; }
.ob h3 { margin: 0; font: 600 16px/1.35 var(--serif); }
.ob p { margin: 0; }
.ob .ob-muted { color: var(--muted); font-size: 12.5px; }
.ob .ob-field { display: grid; gap: 6px; min-width: 0; }
.ob .ob-label { font-weight: 550; overflow-wrap: anywhere; }
.ob .ob-req { color: var(--danger); margin-left: 2px; }
.ob input, .ob textarea { font: inherit; color: inherit; width: 100%; min-width: 0; border: 1px solid var(--line-strong); background: var(--panel); border-radius: 8px; padding: 7px 10px; box-sizing: border-box; }
.ob textarea { resize: vertical; }
.ob input:focus, .ob textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.ob .ob-options { display: flex; flex-wrap: wrap; gap: 6px; }
.ob .ob-opt { font: inherit; color: inherit; border: 1px solid var(--line-strong); background: var(--panel); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.ob .ob-opt[aria-pressed="true"], .ob .ob-opt[aria-checked="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.ob .ob-opt:disabled { cursor: default; }
.ob button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ob .ob-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ob .ob-spacer { flex: 1; }
.ob .ob-submit { font: inherit; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
.ob .ob-submit:disabled { opacity: 0.6; cursor: default; }
.ob .ob-err { color: var(--danger); font-size: 12.5px; }
.ob .ob-value { color: var(--ink-2); overflow-wrap: anywhere; }
.ob svg { width: 100%; height: auto; display: block; overflow: visible; }
.ob .ob-axis { stroke: var(--line-strong); stroke-width: 1; }
.ob .ob-grid { stroke: var(--line); stroke-width: 1; }
.ob .ob-tick { fill: var(--muted); font-size: 11px; font-family: var(--sans); }
.ob .ob-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12.5px; color: var(--ink-2); }
.ob .ob-key { display: inline-flex; align-items: center; gap: 6px; }
.ob .ob-key i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.ob details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
.ob table { border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
.ob th, .ob td { border-bottom: 1px solid var(--line); padding: 3px 10px 3px 0; text-align: left; font-weight: 400; }
.ob td.num { text-align: right; font-variant-numeric: tabular-nums; }
.ob { --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ob { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; } }
:root[data-theme="dark"] .ob { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; }
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

/** Draw `block` into `el` (replacing what is there). False when the kind is not a host block. */
export function renderBlock(el: HTMLElement, block: BlockView, opts: { submit: (answers: Record<string, unknown>) => Promise<void> }) {
  if (!GENERIC_KINDS.includes(block.kind)) return false;
  const doc = el.ownerDocument;
  ensureStyle(doc);
  resizers.get(el)?.disconnect();
  if (block.kind === "form") {
    el.replaceChildren(form(doc, block, opts.submit));
    return true;
  }
  // The chart is drawn at the width it gets (redrawn when that changes), so its labels keep their real size.
  let drawnAt = 0;
  const draw = () => {
    const w = Math.max(280, Math.min(900, Math.round(el.clientWidth || 600) - 38));
    if (Math.abs(w - drawnAt) < 8) return;
    drawnAt = w;
    el.replaceChildren(chart(doc, block, w));
  };
  draw();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    resizers.set(el, ro);
  }
  return true;
}
const resizers = new WeakMap<HTMLElement, ResizeObserver>();

function form(doc: Document, block: BlockView, submit: (answers: Record<string, unknown>) => Promise<void>) {
  const d = block.data as { title: string; intro?: string; fields: Field[]; submit_label?: string };
  const open = block.status === "open";
  const values: Record<string, unknown> = { ...(block.answers ?? {}) };
  const shown = (block.result?.values ?? {}) as Record<string, string>;
  const fields = d.fields.map((f) => {
    const labelId = `ob-${block.id}-${f.id}`;
    const label = h(doc, "span", { class: "ob-label", id: labelId }, f.label, f.required ? h(doc, "span", { class: "ob-req", "aria-hidden": "true" }, "*") : null);
    if (!open) return h(doc, "div", { class: "ob-field" }, label, h(doc, "span", { class: "ob-value" }, shown[f.id] || "（没填）"));
    let control: HTMLElement;
    if (f.type === "textarea") control = h(doc, "textarea", { rows: 3, placeholder: f.placeholder, "aria-labelledby": labelId, oninput: (e) => (values[f.id] = (e.target as HTMLTextAreaElement).value) });
    else if (f.type === "text" || f.type === "number")
      control = h(doc, "input", { type: f.type === "number" ? "number" : "text", placeholder: f.placeholder, "aria-labelledby": labelId, oninput: (e) => (values[f.id] = (e.target as HTMLInputElement).value) });
    else {
      // Choices are buttons (single: radio group; several: toggles; scale: 1–5).
      const options = f.type === "scale" ? ["1", "2", "3", "4", "5"] : f.options;
      const multi = f.type === "multi";
      const group = h(doc, "div", { class: "ob-options", role: multi ? "group" : "radiogroup", "aria-labelledby": labelId });
      const sync = () =>
        group.querySelectorAll("button").forEach((b) => {
          const v = b.dataset.value!;
          const on = multi ? ((values[f.id] as string[] | undefined) ?? []).includes(v) : String(values[f.id] ?? "") === v;
          b.setAttribute(multi ? "aria-pressed" : "aria-checked", String(on));
        });
      for (const o of options) {
        const b = h(doc, "button", {
          type: "button",
          class: "ob-opt",
          ...(multi ? {} : { role: "radio" }),
          onclick: () => {
            if (multi) {
              const cur = new Set((values[f.id] as string[] | undefined) ?? []);
              cur.has(o) ? cur.delete(o) : cur.add(o);
              values[f.id] = [...cur];
            } else values[f.id] = f.type === "scale" ? Number(o) : o;
            sync();
          },
        }, o) as HTMLButtonElement;
        b.dataset.value = o;
        group.append(b);
      }
      sync();
      control = group;
    }
    return h(doc, "div", { class: "ob-field" }, label, control);
  });
  const err = h(doc, "span", { class: "ob-err", role: "alert" });
  const button = h(doc, "button", { type: "button", class: "ob-submit" }, d.submit_label || "提交") as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    err.textContent = "";
    try {
      await submit(values);
    } catch (e) {
      err.textContent = (e as Error).message;
      button.disabled = false;
    }
  });
  return h(
    doc,
    "section",
    { class: "ob", "aria-label": d.title },
    h(doc, "h3", {}, d.title),
    d.intro ? h(doc, "p", { class: "ob-muted" }, d.intro) : null,
    ...fields,
    open ? h(doc, "div", { class: "ob-foot" }, err, h(doc, "span", { class: "ob-spacer" }), button) : h(doc, "p", { class: "ob-muted" }, "已提交"),
  );
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString() : String(Math.round(n * 100) / 100));

/** One value axis from zero, recessive grid, thin marks with rounded data ends; native tooltips per mark. */
function chart(doc: Document, block: BlockView, W: number) {
  const d = block.data as { title: string; kind: "bar" | "line"; labels: string[]; series: { name: string; values: number[] }[]; unit?: string; note?: string };
  const H = 200, L = 36, R = 8, T = 10, B = 26;
  const all = d.series.flatMap((x) => x.values);
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
  const color = (i: number) => `var(--s${i + 1})`;
  if (d.kind === "line") {
    d.series.forEach((ser, si) => {
      const pts = ser.values.map((v, i) => [L + band * (i + 0.5), y(v)] as const);
      svg.append(s(doc, "polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: color(si), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      pts.forEach(([px, py], i) => {
        const dot = s(doc, "circle", { cx: px, cy: py, r: 4, fill: color(si), stroke: "var(--panel)", "stroke-width": 2 });
        dot.append(s(doc, "title", {}, `${d.labels[i]} · ${ser.name}：${fmt(ser.values[i])}${d.unit ?? ""}`));
        svg.append(dot);
      });
    });
  } else {
    const n = d.series.length;
    const gap = 2;
    const w = Math.max(2, Math.min(28, (band * 0.7 - gap * (n - 1)) / n));
    d.series.forEach((ser, si) => {
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
  const legend = d.series.length > 1 ? h(doc, "div", { class: "ob-legend" }, ...d.series.map((ser, si) => h(doc, "span", { class: "ob-key" }, h(doc, "i", { style: `background:${color(si)}` }), ser.name))) : null;
  const table = h(
    doc,
    "details",
    {},
    h(doc, "summary", {}, "看数据"),
    h(doc, "table", {}, h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", {}, ""), ...d.series.map((ser) => h(doc, "th", {}, ser.name)))), h(doc, "tbody", {}, ...d.labels.map((l, i) => h(doc, "tr", {}, h(doc, "th", {}, l), ...d.series.map((ser) => h(doc, "td", { class: "num" }, `${fmt(ser.values[i])}${d.unit ?? ""}`)))))),
  );
  return h(doc, "section", { class: "ob", "aria-label": d.title }, h(doc, "h3", {}, d.title), legend, svg, d.note ? h(doc, "p", { class: "ob-muted" }, d.note) : null, table);
}
