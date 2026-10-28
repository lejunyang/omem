import { z } from "zod";
import { HttpError } from "../core/util.ts";
import type { PluginBlock } from "./types.ts";

/**
 * Blocks the host offers every plugin (docs/v2/plugins.md), so a plugin without code or a page of
 * its own can still ask for a form or show a chart. Their agents hand them in with plugin_form /
 * plugin_chart; plugins/sdk/blocks.ts renders them, on the shell's default page and in plugin pages.
 */
const field = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,30}$/).describe("字段 id"),
  label: z.string().min(1).max(200),
  type: z.enum(["text", "textarea", "number", "choice", "multi", "scale"]).describe("choice 单选、multi 多选、scale 1–5 打分"),
  options: z.array(z.string().min(1).max(200)).max(12).default([]).describe("choice / multi 的选项"),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
});
const form = z.object({
  title: z.string().min(1).max(80),
  intro: z.string().max(1000).optional(),
  fields: z.array(field).min(1).max(20),
  submit_label: z.string().max(20).optional(),
});
type Form = z.infer<typeof form>;

function shown(f: Form["fields"][number], v: unknown) {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "";
  if (f.type === "multi" && Array.isArray(v)) return v.filter((x) => typeof x === "string" && f.options.includes(x)).join("、");
  if (f.type === "choice") return typeof v === "string" && f.options.includes(v) ? v : "";
  if (f.type === "number" || f.type === "scale") {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    return f.type === "scale" ? String(Math.min(5, Math.max(1, Math.round(n)))) : String(n);
  }
  return String(v).slice(0, 4000);
}

export const FORM: PluginBlock<typeof form> = {
  kind: "form",
  description: "在页面上给本人一张表单（文字、多行、数字、单选、多选、1–5 打分），本人填完一次提交，答案作为下一条消息回来。用于一次要问好几项的时候；只问一句话直接在回复里问。",
  schema: form,
  prepare: (f) => {
    const ids = new Set<string>();
    for (const x of f.fields) {
      if (ids.has(x.id)) throw new Error(`字段 id 重复：${x.id}`);
      ids.add(x.id);
      if ((x.type === "choice" || x.type === "multi") && x.options.length < 2) throw new Error(`字段 ${x.id} 是 ${x.type}，至少要两个选项`);
    }
    return f;
  },
  grade: (_ctx, f, answers) => {
    const values = Object.fromEntries(f.fields.map((x) => [x.id, shown(x, answers[x.id])]));
    const missing = f.fields.filter((x) => x.required && !values[x.id]).map((x) => x.label);
    if (missing.length) throw new HttpError(400, `还没填：${missing.join("、")}`);
    const lines = f.fields.map((x) => `- ${x.label}：${values[x.id] || "（没填）"}`);
    return { result: { values }, message: [`【提交】${f.title}`, ...lines].join("\n") };
  },
  presented: (f, id) => `已在页面上展示表单“${f.title}”（${id}）。本人提交后，填的内容会作为下一条消息交给你。`,
};

const chart = z.object({
  title: z.string().min(1).max(80),
  kind: z.enum(["bar", "line"]).default("bar"),
  labels: z.array(z.string().max(40)).min(1).max(60).describe("横轴上的标签"),
  series: z.array(z.object({ name: z.string().max(40), values: z.array(z.number()) })).min(1).max(4),
  unit: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
});

export const CHART: PluginBlock<typeof chart> = {
  kind: "chart",
  description: "在页面上画一张柱状图或折线图给本人看（最多 4 组数据），只展示，不用提交。数据要来自工具查到的记录，不要估计。",
  schema: chart,
  display: true,
  prepare: (c) => {
    for (const s of c.series) if (s.values.length !== c.labels.length) throw new Error(`数据“${s.name}”有 ${s.values.length} 个值，横轴有 ${c.labels.length} 个标签，要一样多`);
    return c;
  },
  presented: (c, id) => `已在页面上展示图表“${c.title}”（${id}）。`,
};

export const GENERIC_BLOCKS = new Map<string, PluginBlock>([
  [FORM.kind, FORM as unknown as PluginBlock],
  [CHART.kind, CHART as unknown as PluginBlock],
]);
export const genericToolName = (kind: string) => `plugin_${kind}`;
