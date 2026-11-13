import type { App } from "../core/app.ts";
import { truncate } from "../core/util.ts";
import { changeText, metricTone, viewText, type ViewComponent } from "../agents/ui-blocks.ts";
import { resolveCitationsSync } from "./common.ts";
import { botOfChannel } from "../core/bot-context.ts";
import { cardText, type CardBlock, type Target } from "./lark-send.ts";
import { one } from "../core/db.ts";

/**
 * Display components in a Feishu card (docs/v2/interactive-ui.md, “卡片里直接画”), drawn with the
 * card's own elements in one quiet style (docs/v2/lark-cards.md): metrics as tiles on a light grey
 * surface, a conclusion or risk on the same grey with a coloured icon, options side by side, tables
 * with a grey header, charts (VChart) in the same series colours as the web. Colour only marks values and
 * states, always with an arrow, icon or word beside it. A card takes at most five tables and five
 * charts; any beyond that are written out as text.
 */
const MAX_PER_CARD = 5;

/**
 * Series colours, in this order, so a series has the same colour here as on the web
 * (packages/plugin-sdk/blocks.ts, light steps): clear mid-tones that also read on the dark card.
 */
export const SERIES = ["#5b5bf0", "#14b8c8", "#ff5d73", "#ee9e15", "#a855f7", "#17a673", "#f97316", "#3b9cf5"];
/** The reference line of a goal. */
const GOAL = "#898781";

/**
 * Callout tones: every callout sits on the same light grey, only its icon is coloured; the card header
 * takes colour from the first callout only when it asks for attention (warning, danger), grey otherwise.
 */
const TONE = {
  info: { icon: "info_filled", color: "blue", header: "grey" },
  success: { icon: "succeed_filled", color: "green", header: "grey" },
  warning: { icon: "warning_filled", color: "orange", header: "orange" },
  danger: { icon: "error_filled", color: "red", header: "red" },
  neutral: { icon: "info_filled", color: "grey", header: "grey" },
} as const;

const isNum = (v: unknown) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
const grey = (s: string) => `<font color='grey'>${s}</font>`;
const md = (content: string, more: Record<string, unknown> = {}) => ({ tag: "markdown", content, text_align: "left", ...more });

/** A short section title above a block (a table's, a chart's, a group of metrics'). */
function caption(title: string, unit?: string): CardBlock {
  return { element: md(`**${cardText(title)}**${unit ? ` ${grey(`（${cardText(unit)}）`)}` : ""}`, { margin: "8px 0px 0px 0px" }) };
}

function table(c: Extract<ViewComponent, { type: "table" }>): Record<string, unknown> {
  const numeric = c.columns.map((_, i) => c.rows.length > 0 && c.rows.every((r) => r[i] === null || r[i] === undefined || r[i] === "" || isNum(r[i])));
  // As many decimals as the column's values carry (up to 4), thousands separated.
  const decimals = c.columns.map((_, i) => (numeric[i] ? Math.min(4, Math.max(0, ...c.rows.map((r) => (r[i] === null || r[i] === undefined || r[i] === "" ? 0 : (String(Number(r[i])).split(".")[1] ?? "").length)))) : 0));
  return {
    tag: "table",
    page_size: Math.max(1, Math.min(10, c.rows.length)),
    row_height: "auto",
    ...(c.columns.length > 4 ? { freeze_first_column: true } : {}),
    header_style: { text_align: "left", background_style: "grey", bold: true },
    columns: c.columns.map((name, i) => ({
      name: `c${i}`,
      display_name: name,
      data_type: numeric[i] ? "number" : "text",
      ...(numeric[i] ? { horizontal_align: "right", format: { precision: decimals[i], separator: true } } : {}),
    })),
    rows: c.rows.map((r) => Object.fromEntries(c.columns.map((_, i) => [`c${i}`, r[i] === null || r[i] === undefined || r[i] === "" ? (numeric[i] ? null : "") : numeric[i] ? Number(r[i]) : String(r[i])]))),
    margin: "4px 0px 0px 0px",
  };
}

/** A VChart spec for one chart: the series colours, thin rounded marks, a goal line, values on the marks when there are few. */
export function chartSpec(c: Extract<ViewComponent, { type: "chart" }>): Record<string, unknown> {
  if (c.kind === "pie") {
    const s = c.series[0];
    const total = s.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    // The share rides in the name, so the legend and the labels both carry it.
    const values = c.labels.map((l, i) => ({ type: `${l} ${Math.round((Math.max(0, s.values[i]) / total) * 100)}%`, value: s.values[i] }));
    return { type: "pie", data: { values }, valueField: "value", categoryField: "type", color: SERIES, outerRadius: 0.8, label: { visible: true }, legends: { visible: true, orient: "right" } };
  }
  const several = c.series.length > 1;
  const stack = several && !!c.stack && c.kind !== "line";
  const horizontal = c.kind === "hbar";
  const values = c.series.flatMap((s) => c.labels.map((l, i) => ({ x: l, s: s.name, v: s.values[i] })));
  const points = c.labels.length * (stack ? 1 : c.series.length);
  const labelled = points <= 12;
  const base: Record<string, unknown> = { data: { values }, color: SERIES, legends: { visible: several, orient: "bottom" } };
  if (several) base.seriesField = "s";
  if (c.goal !== undefined) {
    base.markLine = [{ [horizontal ? "x" : "y"]: c.goal, line: { style: { stroke: GOAL, lineWidth: 1 } }, label: { visible: true, text: `目标 ${c.goal}`, position: "insideEndTop", labelBackground: { visible: false } } }];
  }
  if (c.kind === "line" || c.kind === "area") {
    const line = { style: { lineWidth: 2, curveType: "monotone" } };
    return {
      ...base,
      type: c.kind,
      xField: "x",
      yField: "v",
      ...(c.kind === "area" ? { stack, area: { style: { fillOpacity: several && !stack ? 0.08 : 0.14 } } } : {}),
      line,
      point: c.labels.length <= 12 && c.kind === "line" ? { style: { size: 6 } } : { visible: false },
      ...(labelled && !several ? { label: { visible: true } } : {}),
    };
  }
  const nonNegative = c.series.every((s) => s.values.every((v) => v >= 0));
  // Rounded at the data end, square at the baseline; stacked segments stay square.
  const radius = stack || !nonNegative ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  const grouped = several && !stack ? ["x", "s"] : "x";
  return {
    ...base,
    type: "bar",
    ...(horizontal ? { direction: "horizontal", xField: "v", yField: grouped } : { xField: grouped, yField: "v" }),
    ...(stack ? { stack: true } : {}),
    barMaxWidth: 24,
    bar: { style: { cornerRadius: radius } },
    ...(labelled ? { label: { visible: true, position: stack ? "inside" : horizontal ? "right" : "top" } } : {}),
  };
}

function chart(c: Extract<ViewComponent, { type: "chart" }>): Record<string, unknown> {
  // An hbar grows with its rows; the others keep the card's usual proportions.
  const tall = c.kind === "hbar" ? (c.labels.length * Math.max(1, c.stack ? 1 : c.series.length) > 8 ? "1:1" : "4:3") : c.kind === "pie" ? "4:3" : undefined;
  return { tag: "chart", chart_spec: chartSpec(c), ...(tall ? { aspect_ratio: tall } : {}), preview: true, margin: "0px 0px 0px 0px" };
}

/** Value size by length, so a long figure still fits a third of a phone. */
const valueSize = (s: string) => (s.length <= 6 ? "heading-1" : s.length <= 10 ? "heading-2" : "heading-3");

/** Metric tiles: label, the figure, its change (arrow and colour by whether that way is good) and basis. */
function metrics(c: Extract<ViewComponent, { type: "metric" }>): CardBlock[] {
  const out: CardBlock[] = [];
  if (c.title) out.push(caption(c.title));
  const n = c.items.length;
  const perRow = n <= 3 ? n : n === 4 ? 2 : 3;
  for (let i = 0; i < n; i += perRow) {
    const row = c.items.slice(i, i + perRow);
    out.push({
      element: {
        tag: "column_set",
        flex_mode: row.length === 2 ? "bisect" : "stretch",
        horizontal_spacing: "8px",
        margin: i ? "0px 0px 0px 0px" : "4px 0px 0px 0px",
        columns: row.map((m) => {
          const value = `${m.value}`;
          const tone = metricTone(m);
          const change = m.change ? `<font color='${tone === "good" ? "green" : tone === "bad" ? "red" : "grey"}'>${cardText(changeText(m))}</font>` : "";
          const foot = [change, m.note ? grey(cardText(m.note)) : ""].filter(Boolean).join(" ");
          return {
            tag: "column",
            width: "weighted",
            weight: 1,
            background_style: "grey-50",
            padding: "12px 12px 12px 12px",
            vertical_spacing: "2px",
            vertical_align: "top",
            elements: [
              md(grey(cardText(m.label)), { text_size: "notation" }),
              md(`**${cardText(value)}**${m.unit ? ` ${grey(cardText(m.unit.trim()))}` : ""}`, { text_size: valueSize(value + (m.unit ?? "")) }),
              ...(foot ? [md(foot, { text_size: "notation" })] : []),
            ],
          };
        }),
      },
    });
  }
  if (c.note) out.push({ note: cardText(c.note) });
  return out;
}

function callout(app: App, c: Extract<ViewComponent, { type: "callout" }>): CardBlock {
  const t = TONE[c.tone];
  const text = resolveCitationsSync(app, truncate(c.text, 2000));
  return {
    element: {
      tag: "interactive_container",
      behaviors: [],
      width: "fill",
      height: "auto",
      corner_radius: "8px",
      has_border: false,
      background_style: "grey-50",
      padding: "10px 12px 10px 12px",
      vertical_spacing: "4px",
      margin: "4px 0px 0px 0px",
      elements: c.title
        ? [md(`**${cardText(c.title)}**`, { icon: { tag: "standard_icon", token: t.icon, color: t.color } }), md(text)]
        : [md(text, { icon: { tag: "standard_icon", token: t.icon, color: t.color } })],
    },
  };
}

/** Options side by side (two or three to a row), each on a light surface: what it is, what speaks for it, what it costs. */
function compare(c: Extract<ViewComponent, { type: "compare" }>): CardBlock[] {
  const out: CardBlock[] = [];
  if (c.title) out.push(caption(c.title));
  const perRow = c.items.length === 4 ? 2 : Math.min(3, c.items.length);
  for (let i = 0; i < c.items.length; i += perRow) {
    out.push({
      element: {
        tag: "column_set",
        flex_mode: "stretch",
        horizontal_spacing: "8px",
        margin: "4px 0px 0px 0px",
        columns: c.items.slice(i, i + perRow).map((it) => ({
          tag: "column",
          width: "weighted",
          weight: 1,
          background_style: "grey-50",
          padding: "12px 12px 12px 12px",
          vertical_spacing: "4px",
          vertical_align: "top",
          elements: [
            md(`**${cardText(it.title)}**`),
            ...(it.summary ? [md(cardText(it.summary), { text_size: "notation" })] : []),
            ...(it.pros.length ? [md(it.pros.map((p) => `<font color='green'>＋</font> ${cardText(p)}`).join("\n"), { text_size: "notation" })] : []),
            ...(it.cons.length ? [md(it.cons.map((p) => `<font color='red'>－</font> ${cardText(p)}`).join("\n"), { text_size: "notation" })] : []),
          ],
        })),
      },
    });
  }
  return out;
}

/**
 * A view's components as card blocks. A card cannot run an interactive page: with a link to open
 * (`linked`, the caller adds the button) the page is left out, otherwise it is named in a line.
 */
export function viewCardBlocks(app: App, view: ViewComponent[], opts: { linked?: boolean } = {}): CardBlock[] {
  const out: CardBlock[] = [];
  let tables = 0, charts = 0;
  for (const c of view) {
    if (c.type === "table" && tables < MAX_PER_CARD) {
      tables++;
      if (c.title) out.push(caption(c.title));
      out.push({ element: table(c) });
      if (c.note) out.push({ note: cardText(c.note) });
    } else if (c.type === "page" && opts.linked) {
      continue;
    } else if (c.type === "chart" && charts < MAX_PER_CARD) {
      charts++;
      out.push(caption(c.title, c.unit));
      out.push({ element: chart(c) });
      if (c.note) out.push({ note: cardText(c.note) });
    } else if (c.type === "metric") out.push(...metrics(c));
    else if (c.type === "callout") out.push(callout(app, c));
    else if (c.type === "compare") out.push(...compare(c));
    else if (c.type === "heading") out.push({ element: md(`**${cardText(c.text)}**`, { text_size: "heading", margin: "8px 0px 0px 0px" }) });
    else if (c.type === "timeline")
      out.push({ markdown: c.items.map((i) => `${grey(cardText(i.time))}　**${cardText(i.title)}**${i.text ? `\n${cardText(i.text)}` : ""}`).join("\n") });
    else out.push({ markdown: resolveCitationsSync(app, truncate(viewText([c]), 3000)) });
  }
  return out;
}

/** The header colour of a view's card: orange or red when its first callout asks for attention, grey otherwise. */
export function viewColor(view: ViewComponent[]): string {
  const first = view.find((c) => c.type === "callout");
  return first?.type === "callout" ? TONE[first.tone].header : "grey";
}

/** What the chat list shows for a view's card: its title and the first conclusion or figure. */
export function viewSummary(title: string, view: ViewComponent[]): string | undefined {
  const first = view.find((c) => c.type === "callout" || c.type === "metric");
  const lead = first?.type === "callout" ? (first.title ?? first.text) : first?.type === "metric" ? `${first.items[0].label} ${first.items[0].value}${first.items[0].unit?.trim() ?? ""}` : "";
  const s = [title, lead.replace(/\s+/g, " ").trim()].filter(Boolean).join("：");
  return s ? truncate(s, 60) : undefined;
}

/** Where a view shown in a Feishu conversation goes: its chat, or the topic it was asked in. */
export function viewTarget(app: App, conversationId: string): Target | null {
  const t = one<{ channel: string; external_id: string | null; last: string | null; topic: string | null }>(app.db, "select channel, external_id, json_extract(settings, '$.lastTopicId') topic, json_extract(settings, '$.lastMessageId') last from conversations where id = ?", conversationId);
  if (!t?.external_id || !(t.channel === "lark" || t.channel.startsWith("lark:"))) return null;
  const bot = botOfChannel(t.channel);
  const [chatId, topic] = t.external_id.split("#");
  return (t.topic ?? topic) && t.last ? { replyTo: t.last, inThread: true, bot } : { chatId, bot };
}
