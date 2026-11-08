import type { App } from "../core/app.ts";
import { truncate } from "../core/util.ts";
import { viewText, type ViewComponent } from "../agents/ui-blocks.ts";
import { resolveCitationsSync } from "./common.ts";
import { botOfChannel } from "../core/bot-context.ts";
import type { CardBlock, Target } from "./lark-send.ts";
import { one } from "../core/db.ts";

/**
 * Display components in a Feishu card (docs/v2/interactive-ui.md, “卡片里直接画”): tables and charts
 * become the card's own `table` and `chart` (VChart) elements, the rest Markdown. A card takes at most
 * five of each; any beyond that are written out as text.
 */
const MAX_PER_CARD = 5;

const isNum = (v: unknown) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

function table(c: Extract<ViewComponent, { type: "table" }>): Record<string, unknown> {
  const numeric = c.columns.map((_, i) => c.rows.length > 0 && c.rows.every((r) => r[i] === null || r[i] === undefined || r[i] === "" || isNum(r[i])));
  return {
    tag: "table",
    page_size: Math.max(1, Math.min(10, c.rows.length)),
    row_height: "auto",
    columns: c.columns.map((name, i) => ({ name: `c${i}`, display_name: name, data_type: numeric[i] ? "number" : "text", ...(numeric[i] ? { horizontal_align: "right" } : {}) })),
    rows: c.rows.map((r) => Object.fromEntries(c.columns.map((_, i) => [`c${i}`, r[i] === null || r[i] === undefined || r[i] === "" ? (numeric[i] ? null : "") : numeric[i] ? Number(r[i]) : String(r[i])]))),
  };
}

function chart(c: Extract<ViewComponent, { type: "chart" }>): Record<string, unknown> {
  const title = { text: `${c.title}${c.unit ? `（${c.unit}）` : ""}` };
  if (c.kind === "pie") {
    const s = c.series[0];
    return {
      tag: "chart",
      aspect_ratio: "4:3",
      chart_spec: { type: "pie", title, data: { values: c.labels.map((l, i) => ({ type: l, value: s.values[i] })) }, valueField: "value", categoryField: "type", outerRadius: 0.9, legends: { visible: true, orient: "right" }, label: { visible: true } },
    };
  }
  const values = c.series.flatMap((s) => c.labels.map((l, i) => ({ x: l, s: s.name, v: s.values[i] })));
  const several = c.series.length > 1;
  return {
    tag: "chart",
    chart_spec: {
      type: c.kind,
      title,
      data: { values },
      xField: c.kind === "bar" && several ? ["x", "s"] : "x",
      yField: "v",
      ...(several || c.kind === "line" ? { seriesField: "s" } : {}),
      legends: { visible: several, orient: "bottom" },
    },
  };
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
      if (c.title) out.push({ markdown: `**${c.title}**` });
      out.push({ element: table(c) });
      if (c.note) out.push({ note: c.note });
    } else if (c.type === "page" && opts.linked) {
      continue;
    } else if (c.type === "chart" && charts < MAX_PER_CARD) {
      charts++;
      out.push({ element: chart(c) });
      if (c.note) out.push({ note: c.note });
    } else out.push({ markdown: resolveCitationsSync(app, truncate(viewText([c]), 3000)) });
  }
  return out;
}

/** Where a view shown in a Feishu conversation goes: its chat, or the topic it was asked in. */
export function viewTarget(app: App, conversationId: string): Target | null {
  const t = one<{ channel: string; external_id: string | null; last: string | null; topic: string | null }>(app.db, "select channel, external_id, json_extract(settings, '$.lastTopicId') topic, json_extract(settings, '$.lastMessageId') last from conversations where id = ?", conversationId);
  if (!t?.external_id || !(t.channel === "lark" || t.channel.startsWith("lark:"))) return null;
  const bot = botOfChannel(t.channel);
  const [chatId, topic] = t.external_id.split("#");
  return (t.topic ?? topic) && t.last ? { replyTo: t.last, inThread: true, bot } : { chatId, bot };
}
