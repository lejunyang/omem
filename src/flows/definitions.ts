import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { commitLibrary } from "../core/git.ts";
import { HttpError } from "../core/util.ts";
import type { Item } from "../items/store.ts";

const slug = z.string({ error: "id 必须是文字" }).regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "id 只能用小写字母、数字和连字符，最长 48 字符");
const text = (max: number) => z.string({ error: "必须填写文字" }).trim().min(1, "文字不能为空").max(max, `文字不能超过 ${max} 字符`);
export const tierSchema = z.enum(["strong", "standard", "cheap"]);
const aiChoice = z.object({ profile: text(200), model: text(200).optional(), effort: text(100).optional() }).strict();
export const budgetSchema = z.object({ minutes: z.number().positive("分钟预算必须大于 0").max(525600).optional(), trials: z.number().int().nonnegative("试验预算不能小于 0").max(100000).optional() }).strict();
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "时刻必须写成 HH:mm（00:00–23:59）");
const weekdays = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const carrier = z.union([
  z.object({ run: z.object({ agent: slug.optional(), skill: slug.optional() }).strict() }).strict(),
  z.object({ object: z.enum(["code-work", "design"], { error: "第一期对象只支持 code-work 和 design；插件对象在后续阶段实现" }) }).strict(),
  z.enum(["owner", "wait"]),
], { error: "承担者只能是 run、object、owner 或 wait；person 和插件对象在后续阶段实现" });
const stageSchema = z.object({
  id: slug, name: text(200), note: text(1000).optional(), needs: z.array(slug).optional(), when: text(300).optional(), by: carrier,
  done: z.union([text(300), z.object({ signal: z.enum(["git.pushed", "git.merged"]) }).strict(), z.object({ object: z.enum(["code-work", "design"], { error: "插件对象在后续阶段实现" }), status: z.union([text(100), z.array(text(100)).min(1, "至少写一个状态")]) }).strict()], { error: "完成规则只能是 confirm、Git 信号、对象状态或一句话；插件对象在后续阶段实现" }).optional(),
  gate: z.enum(["auto", "confirm"], { error: "关卡只能是 auto 或 confirm；指定 person 在后续阶段实现" }).default("auto"), fixed: z.boolean().default(false),
  ai: z.union([tierSchema, aiChoice]).optional(), at: clock.optional(),
  window: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/, "时间段必须写成 HH:mm-HH:mm").refine((s) => s.slice(0, 5) !== s.slice(6), "时间段的开始和结束不能相同").optional(),
  budget: budgetSchema.optional(), escalate: z.object({ to: tierSchema, max: z.number().int().min(0).max(100) }).strict().optional(),
}).strict().refine((s) => !(typeof s.done === "object" && "signal" in s.done) || s.by === "owner" || s.by === "wait", { path: ["done"], message: "Git 信号只允许用于 owner 或 wait 承担的阶段" });
export const flowSchema = z.object({
  id: slug, name: text(200), description: text(2000).optional(),
  for: z.object({ kinds: z.array(z.enum(["todo", "waiting", "watch", "decision"], { error: "事项类型只能是 todo / waiting / watch / decision" })).optional(), spaces: z.array(text(100)).optional() }).strict().optional(),
  repeat: z.object({ from: slug, every: z.union([z.enum(["manual", "done", "day"]), z.array(weekdays).min(1, "至少选一个星期").refine((v) => new Set(v).size === v.length, "星期不能重复")]).default("manual") }).strict().optional(),
  stages: z.array(stageSchema).min(1, "流程至少需要一个阶段").max(20, "流程最多 20 个阶段"),
}).strict().superRefine((f, ctx) => {
  const seen = new Set<string>();
  f.stages.forEach((s, i) => {
    if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["stages", i, "id"], message: "阶段 id 不能重复" });
    for (const n of s.needs ?? []) if (!seen.has(n)) ctx.addIssue({ code: "custom", path: ["stages", i, "needs"], message: `前提 ${n} 必须是列表中更早的阶段` });
    seen.add(s.id);
    const isRun = typeof s.by === "object" && "run" in s.by;
    if (s.ai && !isRun) ctx.addIssue({ code: "custom", path: ["stages", i, "ai"], message: "指定 AI 只适用于由运行承担的阶段" });
    if (s.budget?.minutes !== undefined && !isRun) ctx.addIssue({ code: "custom", path: ["stages", i, "budget"], message: "时间预算只适用于由运行承担的阶段" });
    if (s.escalate && (!isRun || !s.ai)) ctx.addIssue({ code: "custom", path: ["stages", i, "escalate"], message: "升档只适用于写了 ai 的运行阶段" });
  });
  if (f.repeat && !seen.has(f.repeat.from)) ctx.addIssue({ code: "custom", path: ["repeat", "from"], message: "下一轮的起点必须是清单里的阶段 id" });
}).transform((f) => ({ ...f, stages: f.stages.map((s, i) => ({ ...s, needs: s.needs ?? (i ? [f.stages[i - 1].id] : []) })) }));
export type FlowDefinition = z.infer<typeof flowSchema>;
export type FlowStage = FlowDefinition["stages"][number];

const OBJECT_NAMES: Record<string, string> = { design: "方案", "code-work": "编码交办" };
const bare = (s: string) => s.replace(/[。！？\s]+$/, "");
const aiWords = (ai: FlowStage["ai"]) => typeof ai === "object" ? `用 ${[ai.profile, ai.model, ai.effort].filter(Boolean).join(" · ")}` : ai === "strong" ? "用好的模型" : ai === "cheap" ? "用省的模型" : "用默认的模型";
export function describeFlow(f: FlowDefinition) {
  const r = f.repeat;
  if (!r) return "";
  const start = f.stages.find((s) => s.id === r.from)!.name;
  const names = { mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六", sun: "日" };
  return `${r.every === "manual" ? "做完以后停着，你点了才开始下一轮" : r.every === "done" ? "做完以后开始下一轮，连续自动开始到上限先问你" : r.every === "day" ? "每天开始新的一轮，上一轮没做完就不开新的" : `每周${r.every.map((d) => names[d]).join("、周")}开始新的一轮，上一轮没做完就不开新的`}，从「${start}」起`;
}
/** A stage in the owner's words: who does it, how it starts, what ends it and when it is needed. The definitions page and the confirm card say the same thing. */
export function describeStage(s: FlowStage) {
  const object = typeof s.by === "object" && "object" in s.by ? OBJECT_NAMES[s.by.object] : null;
  const run = typeof s.by === "object" && "run" in s.by ? s.by.run : null;
  return {
    carrier: s.by === "owner" ? "你来做" : s.by === "wait" ? "只等进展" : object ? `跟着${object}走` : `${!run?.agent || run.agent === "assistant" ? "助手来做" : `交给 ${run.agent}`}${run?.skill ? `，用技能 ${run.skill}` : ""}`,
    gate: s.gate === "confirm" ? "开始前先问你" : s.by === "owner" ? "轮到就来找你" : s.by === "wait" ? "轮到就开始等" : "轮到就自己开始",
    done: typeof s.done === "object" ? "signal" in s.done ? s.done.signal === "git.pushed" ? "改动推到远端就算做完（你也可以自己点做完）" : "改动合进目标分支就算做完" : `${OBJECT_NAMES[s.done.object]}到了 ${[s.done.status].flat().join(" / ")} 算做完` : s.done === "confirm" ? "做完要你点头" : s.done ? bare(s.done) : object ? `${object}完成就算做完` : s.by === "owner" ? "你说做完就算做完" : "交了结果就算做完",
    when: s.when ? `只在需要时做：${bare(s.when)}` : "",
    ai: `${aiWords(s.ai)}${s.escalate ? `；拿不准时最多请${aiWords(s.escalate.to).replace(/^用/, "")}看 ${s.escalate.max} 次` : ""}`,
    time: [s.at ? `这一轮 ${s.at} 以后开始` : "", s.window ? `只在 ${s.window.replace("-", "–")} 之间开始` : ""].filter(Boolean).join("；"),
    budget: s.budget?.minutes !== undefined ? `最多跑 ${s.budget.minutes} 分钟` : "",
  };
}

export function parseFlow(raw: string): FlowDefinition {
  let value: unknown;
  try { value = YAML.parse(raw); } catch (e) { throw new HttpError(400, `流程 YAML 格式不对：${(e as Error).message}`); }
  const parsed = flowSchema.safeParse(value, { error: () => "字段类型不对，或包含第一期不支持的字段" });
  if (!parsed.success) throw new HttpError(400, `流程定义不对：${parsed.error.issues.map((i) => `${i.path.join(".")}：${i.message}`).join("；")}`);
  return parsed.data;
}

function file(app: App, id: string) {
  if (!slug.safeParse(id).success) throw new HttpError(400, "流程 id 不合法");
  const dir = join(app.libraryDir, "_flows");
  const path = join(dir, `${id}.yaml`);
  for (const p of [dir, path]) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new HttpError(400, "流程不支持符号链接");
  return path;
}
export type FlowFile = { id: string; raw: string; definition: FlowDefinition | null; problem: string | null };
export function listFlows(app: App): FlowFile[] {
  const dir = join(app.libraryDir, "_flows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort().map((n) => {
    const id = n.slice(0, -5);
    let raw = "";
    try {
      raw = readFileSync(file(app, id), "utf8");
      const definition = parseFlow(raw);
      if (definition.id !== id) throw new HttpError(400, "定义 id 必须与文件名相同");
      return { id, raw, definition, problem: null };
    } catch (e) { return { id, raw, definition: null, problem: (e as Error).message }; }
  });
}
export function readFlow(app: App, id: string): FlowDefinition {
  const path = file(app, id);
  if (!existsSync(path)) throw new HttpError(404, `没有流程 ${id}`);
  const f = parseFlow(readFileSync(path, "utf8"));
  if (f.id !== id) throw new HttpError(400, "定义 id 必须与文件名相同");
  return f;
}
export function saveFlow(app: App, raw: string, by: string) {
  const f = parseFlow(raw);
  const path = file(app, f.id);
  mkdirSync(join(app.libraryDir, "_flows"), { recursive: true });
  writeFileSync(path, raw.endsWith("\n") ? raw : `${raw}\n`);
  commitLibrary(app.libraryDir, `${by}: 保存流程 ${f.id}`);
  return f;
}
export function removeFlow(app: App, id: string, by = "user") {
  const path = file(app, id);
  if (!existsSync(path)) throw new HttpError(404, `没有流程 ${id}`);
  unlinkSync(path);
  commitLibrary(app.libraryDir, `${by}: 删除流程 ${id}`);
}
export function flowsFor(app: App, item: Pick<Item, "kind" | "spaceId">) {
  return listFlows(app).flatMap((f) => f.definition && (!f.definition.for?.kinds || (f.definition.for.kinds as string[]).includes(item.kind)) && (!f.definition.for?.spaces || f.definition.for.spaces.includes(item.spaceId)) ? [f.definition] : []);
}
export function seedBuiltinFlows(app: App, packageRoot: string) {
  const dir = join(packageRoot, "flows", "library");
  if (!existsSync(dir)) return [];
  const added: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const raw = readFileSync(join(dir, entry.name), "utf8");
    const f = parseFlow(raw);
    if (entry.name !== `${f.id}.yaml`) throw new HttpError(400, "内置流程 id 必须与文件名相同");
    const target = file(app, f.id);
    if (existsSync(target)) continue;
    mkdirSync(join(app.libraryDir, "_flows"), { recursive: true });
    writeFileSync(target, raw, { flag: "wx" });
    added.push(f.id);
  }
  if (added.length) commitLibrary(app.libraryDir, `omem: 添加内置流程 ${added.join("、")}`);
  return added;
}
