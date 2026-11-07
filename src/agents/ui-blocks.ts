import { z } from "zod";
import { HttpError, truncate } from "../core/util.ts";

/**
 * Component blocks (docs/v2/interactive-ui.md): what an agent puts in front of a person besides
 * text. Display components go under a reply (`show`) or above a question; input fields make a
 * question a form (`ask_user` with `fields`). The host validates them here, renders them on the web
 * (packages/plugin-sdk/blocks.ts, web/src/components/UiFields.vue) and falls back to text elsewhere.
 * Answers are normalized and checked here too, so an agent gets clean values whatever the client.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, "id 只能用字母、数字、_ 和 -，最多 40 个字符");

// ------------------------------------------------------------------ display

const markdown = z.object({ type: z.literal("markdown"), text: text(6000).describe("Markdown，可带 src:/mem: 引用") });
const heading = z.object({ type: z.literal("heading"), text: text(120) });
const table = z.object({
  type: z.literal("table"),
  title: z.string().max(120).optional(),
  columns: z.array(text(60)).min(1).max(12),
  rows: z.array(z.array(z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))).max(200),
  note: z.string().max(500).optional(),
});
const chart = z.object({
  type: z.literal("chart"),
  title: text(80),
  kind: z.enum(["bar", "line", "pie"]).default("bar"),
  labels: z.array(z.string().max(40)).min(1).max(60).describe("横轴标签（饼图是各块的名字）"),
  series: z.array(z.object({ name: z.string().max(40), values: z.array(z.number()) })).min(1).max(4).describe("饼图只用第一组"),
  unit: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
});
const metric = z.object({
  type: z.literal("metric"),
  items: z.array(z.object({ label: text(40), value: z.union([z.string().max(40), z.number()]), unit: z.string().max(10).optional(), change: z.string().max(40).optional().describe("变化，如 +12% / 比上周少 3") })).min(1).max(8),
});
const card = z.object({
  id,
  title: text(80),
  summary: z.string().max(1000).optional(),
  pros: z.array(z.string().max(200)).max(8).default([]),
  cons: z.array(z.string().max(200)).max(8).default([]),
});
const compare = z.object({ type: z.literal("compare"), title: z.string().max(120).optional(), items: z.array(card).min(2).max(6) });
const timeline = z.object({ type: z.literal("timeline"), items: z.array(z.object({ time: text(40), title: text(120), text: z.string().max(1000).optional() })).min(1).max(50) });

const page = z.object({
  type: z.literal("page"),
  id: z.string().min(1).max(40).describe("ui_page 返回的 page_id"),
  version: z.number().int().min(1).optional().describe("固定显示某一版（默认最新）"),
  height: z.number().int().min(120).max(1200).optional().describe("页面里的初始高度（像素），之后按内容自动调整"),
  title: z.string().max(80).optional().describe("（宿主填）"),
});

export const viewComponent = z.discriminatedUnion("type", [markdown, heading, table, chart, metric, compare, timeline, page]);
export type ViewComponent = z.infer<typeof viewComponent>;
export const viewSchema = z.array(viewComponent).min(1).max(40);

// ------------------------------------------------------------------ fields

const showIf = z
  .object({ field: id, equals: z.union([z.string(), z.number(), z.boolean()]).optional(), in: z.array(z.string()).max(20).optional() })
  .describe("满足条件才显示：另一个字段等于 equals，或在 in 里（多选字段含有其中之一）");
const base = { id, label: text(200), help: z.string().max(500).optional(), required: z.boolean().default(false), show_if: showIf.optional() };
const fieldSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), placeholder: z.string().max(200).optional(), default: z.string().max(4000).optional() }),
  z.object({ ...base, type: z.literal("textarea"), placeholder: z.string().max(200).optional(), default: z.string().max(4000).optional() }),
  z.object({ ...base, type: z.literal("number"), min: z.number().optional(), max: z.number().optional(), default: z.number().optional() }),
  z.object({ ...base, type: z.literal("choice"), options: z.array(text(200)).min(2).max(12), default: z.string().optional() }),
  z.object({ ...base, type: z.literal("multi"), options: z.array(text(200)).min(2).max(12), default: z.array(z.string()).optional() }),
  z.object({ ...base, type: z.literal("scale") }),
  z.object({ ...base, type: z.literal("date") }),
  z.object({ ...base, type: z.literal("datetime") }),
  z.object({ ...base, type: z.literal("toggle"), default: z.boolean().optional() }),
  z.object({ ...base, type: z.literal("pick"), items: z.array(card).min(2).max(6).describe("并排的方案卡片，选一个") }),
  z.object({
    ...base,
    type: z.literal("checklist"),
    items: z.array(z.object({ id, title: text(200), detail: z.string().max(1000).optional() })).min(1).max(50),
    choices: z.array(text(20)).min(2).max(4).default(["通过", "不通过"]).describe("每条可选的处理"),
    note: z.boolean().default(true).describe("每条能不能写备注"),
  }),
]);
export type UiField = z.infer<typeof fieldSchema>;
export const fieldsSchema = z.array(fieldSchema).min(1).max(30);

/** What a question carries besides its text: a form, and what to look at while answering. */
export type AskUi = { fields?: UiField[]; view?: ViewComponent[]; submitLabel?: string };

/** Check a question's fields once, when the agent hands them in. */
export function checkFields(fields: UiField[]) {
  const ids = new Set<string>();
  for (const f of fields) {
    if (ids.has(f.id)) throw new HttpError(400, `字段 id 重复：${f.id}`);
    ids.add(f.id);
    if (f.type === "number" && f.min !== undefined && f.max !== undefined && f.min > f.max) throw new HttpError(400, `字段 ${f.id} 的 min 大于 max`);
    if (f.type === "pick" || f.type === "checklist") {
      const seen = new Set<string>();
      for (const it of f.items) {
        if (seen.has(it.id)) throw new HttpError(400, `字段 ${f.id} 里有重复的 id：${it.id}`);
        seen.add(it.id);
      }
    }
  }
  for (const f of fields) if (f.show_if && !ids.has(f.show_if.field)) throw new HttpError(400, `字段 ${f.id} 的 show_if 指向不存在的字段 ${f.show_if.field}`);
}

/** Check a view's components (bar and line charts need one value per label). */
export function checkView(view: ViewComponent[]) {
  for (const c of view) {
    if (c.type === "chart" && c.kind !== "pie") for (const s of c.series) if (s.values.length !== c.labels.length) throw new HttpError(400, `图表“${c.title}”的“${s.name}”有 ${s.values.length} 个值，横轴有 ${c.labels.length} 个标签，要一样多`);
    if (c.type === "chart" && c.kind === "pie" && c.series[0].values.length !== c.labels.length) throw new HttpError(400, `饼图“${c.title}”的值和名字要一样多`);
    if (c.type === "compare") {
      const ids = new Set(c.items.map((i) => i.id));
      if (ids.size !== c.items.length) throw new HttpError(400, "方案对比里有重复的 id");
    }
  }
}

// ------------------------------------------------------------------ answers

type Value = string | number | boolean | string[] | Record<string, { choice: string; note?: string }>;
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);

export function visible(f: UiField, values: Record<string, unknown>) {
  if (!f.show_if) return true;
  const v = values[f.show_if.field];
  const list = Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)];
  if (f.show_if.in) return f.show_if.in.some((x) => list.includes(x));
  if (f.show_if.equals !== undefined) return list.includes(String(f.show_if.equals));
  return !empty(v);
}

function normalize(f: UiField, v: unknown): { value?: Value; error?: string } {
  if (empty(v)) return {};
  switch (f.type) {
    case "text":
    case "textarea": {
      const s = String(v).trim();
      return s ? { value: s.slice(0, f.type === "text" ? 1000 : 8000) } : {};
    }
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) return { error: "要填数字" };
      if (f.min !== undefined && n < f.min) return { error: `不能小于 ${f.min}` };
      if (f.max !== undefined && n > f.max) return { error: `不能大于 ${f.max}` };
      return { value: n };
    }
    case "choice":
      return typeof v === "string" && f.options.includes(v) ? { value: v } : { error: "不在选项里" };
    case "multi": {
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const bad = list.filter((x) => !f.options.includes(x));
      return bad.length ? { error: `不在选项里：${bad.join("、")}` } : list.length ? { value: f.options.filter((o) => list.includes(o)) } : {};
    }
    case "scale": {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? { value: n } : { error: "要选 1–5" };
    }
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? { value: v } : { error: "日期格式是 2026-01-31" };
    case "datetime": {
      const t = typeof v === "string" ? Date.parse(v) : NaN;
      return Number.isNaN(t) ? { error: "不是有效的时间" } : { value: new Date(t).toISOString() };
    }
    case "toggle":
      return typeof v === "boolean" ? { value: v } : v === "true" || v === "false" ? { value: v === "true" } : { error: "要选是或否" };
    case "pick":
      return typeof v === "string" && f.items.some((i) => i.id === v) ? { value: v } : { error: "没有这个方案" };
    case "checklist": {
      if (typeof v !== "object" || Array.isArray(v)) return { error: "格式不对" };
      const out: Record<string, { choice: string; note?: string }> = {};
      for (const it of f.items) {
        const e = (v as Record<string, unknown>)[it.id] as { choice?: unknown; note?: unknown } | undefined;
        if (!e || typeof e !== "object" || e.choice === undefined || e.choice === null || e.choice === "") continue;
        if (typeof e.choice !== "string" || !f.choices.includes(e.choice)) return { error: `“${it.title}”的处理不在选项里` };
        const note = f.note && typeof e.note === "string" && e.note.trim() ? e.note.trim().slice(0, 2000) : undefined;
        out[it.id] = note ? { choice: e.choice, note } : { choice: e.choice };
      }
      return Object.keys(out).length ? { value: out } : {};
    }
  }
}

/**
 * The person's answers, checked: hidden fields drop out, every value is in range, required ones
 * are there (a checklist needs every item). Throws a 400 that lists what is wrong.
 */
export function normalizeAnswers(fields: UiField[], raw: Record<string, unknown>): Record<string, Value> {
  const values: Record<string, Value> = {};
  const problems: string[] = [];
  const missing: string[] = [];
  // Conditions read values in order, so a field may only depend on what is above it (or anywhere, with the raw value).
  for (const f of fields) {
    if (!visible(f, { ...raw, ...values })) continue;
    const r = normalize(f, raw[f.id]);
    if (r.error) problems.push(`${f.label}：${r.error}`);
    else if (r.value !== undefined) values[f.id] = r.value;
    const v = values[f.id];
    if (f.required && (v === undefined || (f.type === "checklist" && Object.keys(v as object).length < f.items.length))) missing.push(f.label);
  }
  if (problems.length) throw new HttpError(400, problems.join("；"));
  if (missing.length) throw new HttpError(400, `还没填：${missing.join("、")}`);
  return values;
}

function shown(f: UiField, v: Value | undefined): string {
  if (v === undefined) return "（没填）";
  switch (f.type) {
    case "multi":
      return (v as string[]).join("、");
    case "toggle":
      return v ? "是" : "否";
    case "scale":
      return `${v} / 5`;
    case "datetime":
      return new Date(v as string).toLocaleString("zh-CN", { hour12: false });
    case "pick": {
      const it = f.items.find((i) => i.id === v);
      return it ? `${it.title}（${it.id}）` : String(v);
    }
    case "checklist": {
      const m = v as Record<string, { choice: string; note?: string }>;
      return f.items.map((it) => `\n  - ${it.title}：${m[it.id] ? `${m[it.id].choice}${m[it.id].note ? `（${m[it.id].note}）` : ""}` : "（没处理）"}`).join("");
    }
    default:
      return String(v);
  }
}

/** The answers as lines an agent (or a chat) reads. */
export function summarizeAnswers(fields: UiField[], values: Record<string, Value>) {
  return fields.filter((f) => visible(f, values)).map((f) => `- ${f.label}：${shown(f, values[f.id])}`).join("\n");
}

// ------------------------------------------------------------------ text fallback

const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));

/** A view as Markdown, for channels that cannot draw it (Feishu text, notifications). */
export function viewText(view: ViewComponent[]): string {
  const out: string[] = [];
  for (const c of view) {
    switch (c.type) {
      case "markdown":
        out.push(c.text);
        break;
      case "heading":
        out.push(`**${c.text}**`);
        break;
      case "table":
        out.push([c.title ? `**${c.title}**` : "", `| ${c.columns.map(cell).join(" | ")} |`, `| ${c.columns.map(() => "---").join(" | ")} |`, ...c.rows.slice(0, 30).map((r) => `| ${c.columns.map((_, i) => cell(r[i])).join(" | ")} |`), c.rows.length > 30 ? `（共 ${c.rows.length} 行，只列前 30 行）` : "", c.note ?? ""].filter(Boolean).join("\n"));
        break;
      case "chart": {
        const series = c.kind === "pie" ? c.series.slice(0, 1) : c.series;
        out.push([`**${c.title}**${c.unit ? `（${c.unit}）` : ""}`, ...c.labels.map((l, i) => `- ${l}：${series.map((s) => `${series.length > 1 ? `${s.name} ` : ""}${s.values[i]}`).join("，")}`), c.note ?? ""].filter(Boolean).join("\n"));
        break;
      }
      case "metric":
        out.push(c.items.map((m) => `- ${m.label}：${m.value}${m.unit ?? ""}${m.change ? `（${m.change}）` : ""}`).join("\n"));
        break;
      case "compare":
        out.push([c.title ? `**${c.title}**` : "", ...c.items.map(cardText)].filter(Boolean).join("\n"));
        break;
      case "timeline":
        out.push(c.items.map((i) => `- ${i.time} ${i.title}${i.text ? `：${i.text}` : ""}`).join("\n"));
        break;
      case "page":
        out.push(`交互页“${c.title || c.id}”：在网页上打开才能操作`);
        break;
    }
  }
  return truncate(out.join("\n\n"), 6000);
}

const cardText = (i: z.infer<typeof card>) => [`- **${i.title}**（${i.id}）${i.summary ? `：${i.summary}` : ""}`, ...i.pros.map((p) => `  - 优点：${p}`), ...i.cons.map((p) => `  - 代价：${p}`)].join("\n");

/** A question's form as text, for channels that cannot draw it. */
export function fieldsText(fields: UiField[]) {
  return fields
    .map((f) => {
      const req = f.required ? "（必填）" : "";
      if (f.type === "choice" || f.type === "multi") return `- ${f.label}${req}：${f.options.join(" / ")}`;
      if (f.type === "pick") return [`- ${f.label}${req}：`, ...f.items.map(cardText).map((l) => `  ${l}`)].join("\n");
      if (f.type === "checklist") return [`- ${f.label}${req}：逐条选 ${f.choices.join(" / ")}`, ...f.items.map((i) => `  - ${i.title}`)].join("\n");
      return `- ${f.label}${req}`;
    })
    .join("\n");
}
