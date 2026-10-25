import { z } from "zod";
import type { App } from "../core/app.ts";
import { defaultReviewTiers } from "../core/config.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { leafMatches } from "../rules/conditions.ts";
import { isBuiltinRole } from "./builtin-roles.ts";
import { findAgentSpec } from "./specs.ts";

/**
 * Code review after a delegation (docs/v2/review.md, phase 1): ordered tiers pick which review
 * checks run for a change; each check is a built-in review role or an agent spec, runs in its own
 * session with read-only tools, and reports structured findings with submit_review.
 */

/** What a check may use, whatever its profile allows elsewhere: reading, plus submit_review. */
export const REVIEW_TOOLS = ["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_pages", "read_page", "recall", "list_items", "read_item", "list_conversations", "read_conversation", "list_skills", "read_skill"];

/** Built-in checks: label and one line on what each looks at. */
export const BUILTIN_CHECKS: Record<string, { label: string; about: string }> = {
  reviewer: { label: "功能", about: "需求是否实现、边界与错误处理、测试覆盖、多余改动" },
  "review-business": { label: "业务", about: "对照需求逐条核对业务规则是否实现一致" },
  "review-arch": { label: "架构", about: "模块边界、依赖方向、抽象取舍、跨仓库接口" },
  "review-style": { label: "规范", about: "只报违反项目明确约定的地方" },
  "review-history": { label: "历史", about: "以前类似改动踩过的坑" },
};

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABEL: Record<Severity, string> = { blocker: "阻断", major: "严重", minor: "一般", nit: "提示" };

// ---- conditions ---------------------------------------------------------------------------

export const REVIEW_FIELDS = {
  "change.lines": "改动行数",
  "change.codeLines": "有效代码改动行数",
  "change.files": "改动文件数",
  "change.repos": "改动仓库数",
  "change.paths": "改动路径",
  "change.checksPassed": "检查全部通过",
  "task.text": "任务原文",
} as const;
export const REVIEW_FIELD_HELP: Record<keyof typeof REVIEW_FIELDS, string> = {
  "change.lines": "所有仓库新增加删除的行数之和。",
  "change.codeLines": "只算源代码文件（按扩展名：ts、vue、go、java、py…）的增删行数，不算文档、锁文件、JSON/YAML 配置、样式和压缩文件。",
  "change.files": "改动的文件数，几个仓库合计。",
  "change.repos": "有改动的仓库数。",
  "change.paths": "改动文件在仓库里的路径；“包含 auth”表示任一路径带 auth。",
  "change.checksPassed": "配置了检查命令的仓库是否全部通过；没有检查命令算通过。",
  "task.text": "交办时的任务原文，可按关键词判断。",
};
const NUMERIC = new Set(["change.lines", "change.codeLines", "change.files", "change.repos"]);
export const REVIEW_OPS = ["gte", "lte", "equals", "contains", "startsWith", "endsWith", "in", "is"] as const;
type Field = keyof typeof REVIEW_FIELDS;
export type ReviewCondition = { field: Field; op: (typeof REVIEW_OPS)[number]; value: string | number | boolean | string[] } | { all: ReviewCondition[] } | { any: ReviewCondition[] } | { not: ReviewCondition };
export const reviewCondition: z.ZodType<ReviewCondition> = z.lazy(() => z.union([
  z.object({ field: z.enum(Object.keys(REVIEW_FIELDS) as [Field, ...Field[]]), op: z.enum(REVIEW_OPS), value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]) }).superRefine((c, ctx) => {
    const numeric = NUMERIC.has(c.field);
    if (numeric && !["gte", "lte", "equals"].includes(c.op)) ctx.addIssue({ code: "custom", message: `${REVIEW_FIELDS[c.field]}只能比较大小` });
    if (numeric && !Number.isFinite(Number(c.value))) ctx.addIssue({ code: "custom", path: ["value"], message: `${REVIEW_FIELDS[c.field]}要填数字` });
    if (!numeric && ["gte", "lte"].includes(c.op)) ctx.addIssue({ code: "custom", message: `${REVIEW_FIELDS[c.field]}不能比较大小` });
  }),
  z.object({ all: z.array(reviewCondition).min(1).max(30) }),
  z.object({ any: z.array(reviewCondition).min(1).max(30) }),
  z.object({ not: reviewCondition }),
]));

export type ReviewMetrics = { "change.lines": number; "change.codeLines": number; "change.files": number; "change.repos": number; "change.paths": string[]; "change.checksPassed": boolean; "task.text": string };

export function matchesReview(c: ReviewCondition | null | undefined, m: ReviewMetrics): boolean {
  if (!c) return true;
  if ("all" in c) return c.all.every((x) => matchesReview(x, m));
  if ("any" in c) return c.any.some((x) => matchesReview(x, m));
  if ("not" in c) return !matchesReview(c.not, m);
  const raw = m[c.field];
  if (c.op === "gte") return Number(raw) >= Number(c.value);
  if (c.op === "lte") return Number(raw) <= Number(c.value);
  if (NUMERIC.has(c.field) && c.op === "equals") return Number(raw) === Number(c.value);
  return leafMatches({ op: c.op, value: typeof c.value === "number" ? String(c.value) : c.value }, raw);
}

// ---- settings ----------------------------------------------------------------------------------

export type Tier = { id: string; name: string; when: ReviewCondition | null; guide?: string; checks: string[]; maxRounds: number; lead?: boolean; confirmPlan?: boolean };
export type CheckSetting = { label: string; blocks: "blocker" | "major" | "minor"; when: ReviewCondition | null; guide?: string };
export type CheckInfo = CheckSetting & { name: string; builtin: boolean; about: string; missing: boolean };

export function reviewTiers(app: App): Tier[] {
  return app.config.review.tiers as Tier[];
}

/** Built-in checks always exist; an agent spec is a check once it has review settings. */
export function reviewChecks(app: App): CheckInfo[] {
  const own = app.config.review.checks as Record<string, CheckSetting>;
  const builtin = Object.entries(BUILTIN_CHECKS).map(([name, b]): CheckInfo => ({ name, builtin: true, about: b.about, missing: false, ...({ label: b.label, blocks: "major", when: null } as CheckSetting), ...own[name] }));
  const custom = Object.entries(own).filter(([name]) => !BUILTIN_CHECKS[name]).map(([name, s]) => {
    const spec = findAgentSpec(app, name);
    return { name, builtin: false, about: spec?.description ?? "", missing: !spec || spec.status !== "active", ...s };
  });
  return [...builtin, ...custom];
}

export const tierSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/, "档位 id 只能用小写字母、数字和连字符"),
  name: z.string().trim().min(1).max(20),
  when: reviewCondition.nullable(),
  guide: z.string().trim().max(2000).default(""),
  checks: z.array(z.string()).min(1, "每个档位至少要有一项评审").max(12),
  maxRounds: z.number().int().min(1).max(10),
  lead: z.boolean().default(false),
  confirmPlan: z.boolean().default(false),
});
export const checkSettingSchema = z.object({ label: z.string().trim().min(1).max(12), blocks: z.enum(["blocker", "major", "minor"]), when: reviewCondition.nullable(), guide: z.string().trim().max(2000).default("") });
export const reviewSettingsSchema = z.object({ tiers: z.array(tierSchema).min(1).max(12), checks: z.record(z.string(), checkSettingSchema), rereviewAllEvery: z.number().int().min(1).max(10).default(2) });

/** Check names must exist; the last tier is the catch-all (no condition), so every change has one. */
export function validateReviewSettings(app: App, input: unknown) {
  const s = reviewSettingsSchema.parse(input);
  for (const name of Object.keys(s.checks)) {
    if (BUILTIN_CHECKS[name]) continue;
    if (isBuiltinRole(name)) throw new HttpError(400, `${name} 是内置角色，不能用作评审项`);
    if (!findAgentSpec(app, name)) throw new HttpError(400, `没有 Agent 档案 ${name}`);
  }
  const known = new Set([...Object.keys(BUILTIN_CHECKS), ...Object.keys(s.checks)]);
  const ids = new Set<string>();
  for (const t of s.tiers) {
    if (ids.has(t.id)) throw new HttpError(400, `档位 id 重复：${t.id}`);
    ids.add(t.id);
    const unknown = t.checks.filter((c) => !known.has(c));
    if (unknown.length) throw new HttpError(400, `档位「${t.name}」引用了不存在的评审项：${unknown.join("、")}`);
  }
  if (s.tiers.at(-1)!.when || s.tiers.at(-1)!.guide) throw new HttpError(400, "最后一个档位是兜底档，不能设条件或说明");
  return s;
}

export function defaultReviewSettings() {
  return { tiers: defaultReviewTiers(), checks: {}, rereviewAllEvery: 2 };
}

// ---- planning ----------------------------------------------------------------------------------

export type ReviewPlan = { tier: string; tierName: string; checks: string[]; maxRounds: number; reasons: string[]; metrics: ReviewMetrics; lead?: boolean; confirmPlan?: boolean };
/** review-lead's guess before any code is written: which tier the task will likely need. */
export type ReviewEstimate = { tier: string; tierName: string; reason: string };

/**
 * First tier whose condition matches, unless the task named one; checks whose own condition
 * matches are added. A later round never goes to a lighter tier than an earlier one chose.
 */
export function planReview(app: App, metrics: ReviewMetrics, opts: { tier?: string; extraChecks?: string[]; previous?: ReviewPlan } = {}): ReviewPlan {
  const tiers = reviewTiers(app);
  const reasons: string[] = [];
  let index = tiers.findIndex((t) => matchesReview(t.when, metrics));
  if (index < 0) index = tiers.length - 1;
  reasons.push(`按改动指标落在「${tiers[index].name}」档（${metrics["change.lines"]} 行（有效代码 ${metrics["change.codeLines"]} 行）、${metrics["change.files"]} 个文件、${metrics["change.repos"]} 个仓库）`);
  if (opts.tier) {
    const named = tiers.findIndex((t) => t.id === opts.tier || t.name === opts.tier);
    if (named < 0) throw new HttpError(400, `没有评审档位 ${opts.tier}`);
    reasons.push(named === index ? `任务指定用「${tiers[named].name}」档，改动指标也落在这一档` : `任务指定用「${tiers[named].name}」档`);
    index = named;
  }
  const before = opts.previous ? tiers.findIndex((t) => t.id === opts.previous!.tier) : -1;
  if (before >= 0 && before < index) {
    reasons.push(`上一轮已是「${tiers[before].name}」档，不降档`);
    index = before;
  }
  const tier = tiers[index];
  const checks = [...tier.checks];
  const usable = new Map(reviewChecks(app).map((c) => [c.name, c]));
  for (const c of usable.values()) {
    if (c.when && !checks.includes(c.name) && matchesReview(c.when, metrics)) {
      checks.push(c.name);
      reasons.push(`改动满足「${c.label}」评审的加入条件`);
    }
  }
  for (const name of opts.extraChecks ?? []) {
    if (!usable.has(name)) throw new HttpError(400, `没有评审项 ${name}`);
    if (!checks.includes(name)) { checks.push(name); reasons.push(`任务要求加上「${usable.get(name)!.label}」评审`); }
  }
  for (const name of opts.previous?.checks ?? []) if (!checks.includes(name) && usable.has(name)) checks.push(name);
  const runnable = checks.filter((n) => usable.has(n) && !usable.get(n)!.missing);
  const dropped = checks.filter((n) => !runnable.includes(n));
  if (dropped.length) reasons.push(`缺少评审项：${dropped.join("、")}（档案不存在或是草稿），已跳过`);
  if (!runnable.length) runnable.push("reviewer");
  return { tier: tier.id, tierName: tier.name, checks: runnable, maxRounds: tier.maxRounds, reasons, metrics, lead: !!tier.lead, confirmPlan: !!tier.confirmPlan };
}

/**
 * What conditions cannot say: tiers above the matched one and checks not yet in the plan whose
 * owner wrote "when to use" in words. One model call weighs them against the change; it may only
 * move to a heavier tier and add checks, never drop what the conditions chose. Without an answer
 * the plan stays as it is.
 */
export async function refineReviewPlan(app: App, plan: ReviewPlan, change: { task: string; diff: string; tierNamed?: boolean; estimate?: ReviewEstimate }, ask: (prompt: string) => Promise<string | null>): Promise<ReviewPlan> {
  const tiers = reviewTiers(app);
  const at = tiers.findIndex((t) => t.id === plan.tier);
  // Heavier: tiers with words that may fit, and what review-lead guessed before coding.
  const tierCandidates = change.tierNamed ? [] : tiers.slice(0, Math.max(0, at)).filter((t) => t.guide?.trim() || t.id === change.estimate?.tier);
  // A tier with a lead may also be judged one step too heavy for what was actually written.
  const lighter = !change.tierNamed && tiers[at]?.lead && at < tiers.length - 1 ? tiers[at + 1] : null;
  const checkCandidates = reviewChecks(app).filter((c) => c.guide?.trim() && !c.missing && !plan.checks.includes(c.name));
  if (!tierCandidates.length && !checkCandidates.length && !lighter) return plan;
  const m = plan.metrics;
  const prompt = [
    `你是评审负责人，给一次已经写好的代码改动定评审方式。按改动本身和本人写的说明判断，拿不准就维持现在的选择。只输出一个 JSON：{"tier": 档位 id 或 null（维持）, "checks": [额外加上的评审项名], "reason": "一句话理由"}`,
    `## 改动\n\n任务：${change.task.slice(0, 3000)}\n\n${m["change.lines"]} 行（有效代码 ${m["change.codeLines"]} 行）、${m["change.files"]} 个文件、${m["change.repos"]} 个仓库；检查${m["change.checksPassed"] ? "通过" : "没通过"}。\n文件：${m["change.paths"].slice(0, 80).join("、")}\n\n${change.diff.slice(0, 12000)}`,
    `## 现在的选择\n\n按条件落在「${plan.tierName}」档，评审项：${plan.checks.join("、")}。${change.estimate ? `编码前预估是「${change.estimate.tierName}」档：${change.estimate.reason}` : ""}`,
    tierCandidates.length ? `## 可以换成的更重档位（符合说明或预估确实成立才选）\n\n${tierCandidates.map((t) => `- ${t.id}（${t.name}）：${t.guide || "编码前预估的档位"}`).join("\n")}` : "",
    lighter ? `## 可以降一档\n\n- ${lighter.id}（${lighter.name}）：只有改动明显比条件估计的小而简单（例如大多是生成文件、重命名、测试数据）时才选，并写清理由。` : "",
    checkCandidates.length ? `## 可以额外加上的评审项（符合说明才加）\n\n${checkCandidates.map((c) => `- ${c.name}（${c.label}）：${c.guide}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  let answer: { tier?: string | null; checks?: string[]; reason?: string } | null = null;
  try {
    const { jsonIn } = await import("./oneshot.ts");
    answer = jsonIn(await ask(prompt));
  } catch {
    answer = null;
  }
  if (!answer) return { ...plan, reasons: [...plan.reasons, "没能请模型按说明判断，只按条件选择"] };
  const next = { ...plan, checks: [...plan.checks], reasons: [...plan.reasons] };
  const tier = tierCandidates.find((t) => t.id === answer!.tier);
  const usable = (c: string) => reviewChecks(app).some((x) => x.name === c && !x.missing);
  if (tier) {
    Object.assign(next, { tier: tier.id, tierName: tier.name, maxRounds: tier.maxRounds, lead: !!tier.lead, confirmPlan: !!tier.confirmPlan });
    for (const c of tier.checks) if (!next.checks.includes(c) && usable(c)) next.checks.push(c);
    next.reasons.push(`评审负责人改用「${tier.name}」档${answer.reason ? `：${answer.reason}` : ""}`);
  } else if (lighter && answer.tier === lighter.id) {
    // Keep what conditions or the owner added on top of the tier.
    const extra = next.checks.filter((c) => !tiers[at].checks.includes(c));
    Object.assign(next, { tier: lighter.id, tierName: lighter.name, maxRounds: lighter.maxRounds, lead: !!lighter.lead, confirmPlan: !!lighter.confirmPlan, checks: [...lighter.checks.filter(usable), ...extra.filter((c) => !lighter.checks.includes(c))] });
    next.reasons.push(`评审负责人降到「${lighter.name}」档${answer.reason ? `：${answer.reason}` : ""}`);
  }
  const added = checkCandidates.filter((c) => answer!.checks?.includes(c.name));
  for (const c of added) next.checks.push(c.name);
  if (added.length) next.reasons.push(`按说明加上${added.map((c) => `「${c.label}」`).join("")}评审${!tier && answer.reason ? `：${answer.reason}` : ""}`);
  return next;
}

/**
 * Before any code is written, review-lead guesses the tier from the task alone (shown with the
 * progress, and offered to the post-coding triage as a heavier option). Null without an answer.
 */
export async function estimateReview(app: App, task: string, ask: (prompt: string) => Promise<string | null>): Promise<ReviewEstimate | null> {
  const tiers = reviewTiers(app);
  if (tiers.length < 2) return null;
  const prompt = [
    `你是评审负责人。下面的编码任务还没开始写，先按任务本身估计它大概需要哪一档评审（改动会有多大、碰不碰关键逻辑）。只输出一个 JSON：{"tier": 档位 id, "reason": "一句话理由"}`,
    `## 任务\n\n${task.slice(0, 6000)}`,
    `## 档位（从重到轻）\n\n${tiers.map((t) => `- ${t.id}（${t.name}）：${t.checks.length} 项评审${t.guide ? `；本人说明：${t.guide}` : ""}${t.when ? "；有按改动大小的条件" : "；兜底档"}`).join("\n")}`,
  ].join("\n\n");
  try {
    const { jsonIn } = await import("./oneshot.ts");
    const a = jsonIn<{ tier?: string; reason?: string }>(await ask(prompt));
    const t = tiers.find((x) => x.id === a?.tier);
    return t ? { tier: t.id, tierName: t.name, reason: (a?.reason ?? "").slice(0, 300) } : null;
  } catch {
    return null;
  }
}

/** Written into each check's task: how to report, what blocks. */
export function checkBrief(check: CheckInfo, plan: ReviewPlan) {
  const others = plan.checks.filter((c) => c !== check.name);
  return [
    `## 你负责的评审项：${check.label}`,
    others.length ? `这次是「${plan.tierName}」档，另有 ${others.length} 个评审项各自独立评审，你只看自己负责的角度，不必重复别的角度。` : "",
    `${SEVERITY_LABEL[check.blocks]}及以上的问题会要求编码 Agent 再改一轮；低于这一级的只列出来。`,
    "评审完先调用一次 `submit_review` 提交结论和问题清单（每条写清文件和行、问题、建议），再用文字写结论：第一行 `结论：通过` 或 `结论：需要修改`。没有问题时 findings 传空数组，并在 summary 里说明你查了什么。",
  ].filter(Boolean).join("\n\n");
}

// ---- results -----------------------------------------------------------------------------------

export const findingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().max(500).optional(),
  line: z.number().int().min(1).optional(),
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).default(""),
  suggestion: z.string().max(4000).default(""),
  evidence: z.array(z.string().max(300)).max(20).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});
export type Finding = z.infer<typeof findingSchema>;
/**
 * A requirement's change point and where the change implements it (docs/v2/review.md §6, “变更”):
 * what the requirement says, what the code does, and the line ranges, so the run page can go from
 * a change point to its code and back.
 */
export const changePointSchema = z.object({
  id: z.string().min(1).max(12),
  title: z.string().min(1).max(200),
  status: z.enum(["done", "partial", "missing", "extra"]),
  requirement: z.string().max(2000).default(""),
  implementation: z.string().max(2000).default(""),
  refs: z.array(z.string().max(300)).max(20).default([]),
  locations: z.array(z.object({ file: z.string().min(1).max(500), start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() })).max(30).default([]),
});
export type ChangePoint = z.infer<typeof changePointSchema>;

/**
 * References in a review that point at nothing: a source or memory id the model got wrong (one
 * character off is common). The check is told to look them up again rather than store a dead link.
 */
export function deadRefs(app: App, refs: string[]) {
  return [...new Set(refs)].filter((ref) => {
    const m = /^(src|mem):([A-Za-z0-9_-]+)/.exec(ref.trim());
    if (!m) return false;
    return m[1] === "src"
      ? !one(app.db, "select 1 from sources where id = ? and deleted_at is null", m[2])
      : !one(app.db, "select 1 from memories where id = ?", m[2]);
  });
}
export type ReviewRow = { id: string; code_run_id: string; round: number; check_name: string; tier: string | null; profile_id: string | null; model: string | null; effort: string | null; verdict: string; summary: string; status: string; created_at: string; change_points: string | null };
export type FindingRow = { id: number; review_id: string; severity: Severity; file_path: string | null; line: number | null; title: string; detail: string; suggestion: string; evidence: string; confidence: string; state: string; merged_into: number | null; triage_note: string; decision?: "fix" | "later" | "wontfix" | null; decision_note?: string };

const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
export const blocksAt = (severity: Severity, level: CheckSetting["blocks"]) => RANK[severity] <= RANK[level];

/** One check's result for one round; a resubmission in the same round replaces the earlier one. */
export function recordReview(app: App, r: { codeRunId: string; round: number; check: string; tier?: string; verdict: "approved" | "changes_requested" | "failed"; summary: string; findings: Finding[]; changePoints?: ChangePoint[]; ai?: { profile?: string; model?: string; effort?: string } }) {
  const id = newId("rv");
  tx(app.db, () => {
    run(app.db, "delete from reviews where code_run_id = ? and round = ? and check_name = ?", r.codeRunId, r.round, r.check);
    run(app.db, "insert into reviews(id, code_run_id, round, check_name, tier, profile_id, model, effort, verdict, summary, change_points, created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)",
      id, r.codeRunId, r.round, r.check, r.tier ?? null, r.ai?.profile ?? null, r.ai?.model ?? null, r.ai?.effort ?? null, r.verdict, r.summary, r.changePoints?.length ? JSON.stringify(r.changePoints) : null, now());
    for (const f of r.findings) {
      run(app.db, "insert into review_findings(review_id, severity, file_path, line, title, detail, suggestion, evidence, confidence) values(?,?,?,?,?,?,?,?,?)",
        id, f.severity, f.file ?? null, f.line ?? null, f.title, f.detail, f.suggestion, JSON.stringify(f.evidence), f.confidence);
    }
  });
  return id;
}

export function reviewFor(app: App, codeRunId: string, round: number, check: string) {
  return one<ReviewRow>(app.db, "select * from reviews where code_run_id = ? and round = ? and check_name = ?", codeRunId, round, check);
}

/** Every round of a delegation (its runs share the first round's id as continueFrom). */
export function reviewsOf(app: App, codeRunIds: string[]) {
  if (!codeRunIds.length) return [];
  const marks = codeRunIds.map(() => "?").join(",");
  const reviews = all<ReviewRow>(app.db, `select * from reviews where code_run_id in (${marks}) order by round, created_at`, ...codeRunIds);
  const findings = reviews.length ? all<FindingRow>(app.db, `select * from review_findings where review_id in (${reviews.map(() => "?").join(",")}) order by id`, ...reviews.map((r) => r.id)) : [];
  return reviews.map((r) => ({ ...r, change_points: r.change_points ? (JSON.parse(r.change_points) as ChangePoint[]) : [], findings: findings.filter((f) => f.review_id === r.id).map((f) => ({ ...f, evidence: JSON.parse(f.evidence) as string[] })) }));
}

// ---- review-lead: rulings and when to stop -------------------------------------------------------

export type Ruling = { id: number; decision: "accept" | "reject" | "merge"; into?: number; note?: string };
export type LeadResult = {
  round: number;
  verdict: "approve" | "revise" | "escalate";
  summary: string;
  changeRequest: string;
  rerun: string[];
  escalation?: { summary: string; options: string[] };
  stop?: StopReason;
  by: "lead" | "host";
};
export type StopReason = "auto-limit" | "not-converging" | "stalemate" | "escalated";
export const STOP_LABEL: Record<StopReason, string> = {
  "auto-limit": "到了这一档的自动修改轮数上限",
  "not-converging": "这一轮要改的问题不比上一轮少，修改没有收敛",
  stalemate: "同一个问题连续两轮修改后仍被报出，编码和评审僵持",
  escalated: "评审负责人判断是需求或方案上的分歧，需要你决定",
};

/** Findings of one round of a delegation, with the check that reported them. */
export function roundFindings(app: App, codeRunId: string, round: number) {
  return all<FindingRow & { check_name: string }>(app.db, "select f.*, r.check_name from review_findings f join reviews r on r.id = f.review_id where r.code_run_id = ? and r.round = ? order by f.id", codeRunId, round);
}

/** review-lead's decisions, checked against this round's findings; unknown ids are refused. */
export function applyRulings(app: App, codeRunId: string, round: number, rulings: Ruling[]) {
  const mine = new Set(roundFindings(app, codeRunId, round).map((f) => f.id));
  for (const r of rulings) {
    if (!mine.has(r.id)) throw new HttpError(400, `问题 ${r.id} 不是这一轮的`);
    if (r.decision === "merge" && (!r.into || !mine.has(r.into) || r.into === r.id)) throw new HttpError(400, `问题 ${r.id} 合并到的 ${r.into ?? "（空）"} 不是这一轮的另一条问题`);
  }
  tx(app.db, () => {
    for (const r of rulings) {
      const state = r.decision === "accept" ? "accepted" : r.decision === "reject" ? "rejected" : "merged";
      run(app.db, "update review_findings set state = ?, merged_into = ?, triage_note = ? where id = ?", state, r.decision === "merge" ? r.into! : null, (r.note ?? "").slice(0, 1000), r.id);
    }
  });
}

/** The same problem across rounds: same check, same file, same words once punctuation and case are gone. */
export const findingKey = (f: { check_name: string; file_path: string | null; title: string }) =>
  `${f.check_name}|${(f.file_path ?? "").replace(/:\d+$/, "")}|${f.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")}`;

/**
 * Accepted findings at or above the check's blocking level. Without a lead every blocking
 * finding counts as accepted (open).
 */
export function blockingAccepted(app: App, codeRunId: string, round: number) {
  const level = new Map(reviewChecks(app).map((c) => [c.name, c.blocks]));
  return roundFindings(app, codeRunId, round).filter((f) => ["accepted", "open"].includes(f.state) && blocksAt(f.severity, level.get(f.check_name) ?? "major"));
}

/**
 * Whether automatic rounds must stop here even though changes are asked for. `rounds` is the code
 * run of every round so far, in order, the current one last.
 */
export function stopReason(app: App, rounds: { runId: string; round: number }[], maxRounds: number, leadVerdict: LeadResult["verdict"]): StopReason | null {
  if (leadVerdict === "escalate") return "escalated";
  const cur = rounds.at(-1)!;
  if (cur.round >= maxRounds) return "auto-limit";
  const now = blockingAccepted(app, cur.runId, cur.round);
  const prev = rounds.at(-2);
  if (prev) {
    const before = blockingAccepted(app, prev.runId, prev.round);
    // The more specific reason first: one problem that two fixes did not remove.
    const older = rounds.at(-3);
    if (older) {
      const keys = (list: { check_name: string; file_path: string | null; title: string }[]) => new Set(list.map(findingKey));
      const a = keys(blockingAccepted(app, older.runId, older.round));
      const b = keys(before);
      if (now.some((f) => a.has(findingKey(f)) && b.has(findingKey(f)))) return "stalemate";
    }
    if (before.length && now.length >= before.length) return "not-converging";
  }
  return null;
}
