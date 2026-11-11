import { z } from "zod";

/**
 * A design (docs/v2/coding-plan.md §2, §6.2): a set of decisions, each of one of four kinds with its
 * own fields, plus the facts that shape it, a cross-decision behaviour table, where it departs from
 * what was asked, and concerns (an assessment). The same shape for the owner's own design (`own`),
 * someone else's technical design as extracted (`external`), and a description written after the
 * code (`derived`). Shared by the store, the tools, the Markdown and the web page.
 */

export type DecisionKind = "add" | "change" | "remove" | "refactor";
export type Table = { head: string[]; rows: string[][] };
export type Field = { brief: string; text?: string; code?: string; lang?: string; table?: Table };
export type ConcernLevel = "problem" | "risk" | "improve" | "question";
export type ConcernState = "open" | "resolved" | "dropped";
export type Concern = { id: string; level: ConcernLevel; text: string; where?: string[]; refs?: string[]; state: ConcernState; note?: string; by?: string };
export type Decision = {
  /** D1, D2…: the same in every version of one design. */
  id: string;
  kind: DecisionKind;
  title: string;
  reqs: string[];
  /** Keyed by the kind's fields (DECISION_FIELDS). */
  fields: Record<string, Field>;
  rejected?: { text: string; why: string }[];
  question?: { text: string; options: string[]; recommended?: number; answer?: string };
  /** external: false = the document does not say it, it was inferred from the code. */
  stated?: boolean;
  concerns?: Concern[];
  /** Files put under this decision (a branch review's split, derived): `<repo id>/<path>`. */
  files?: string[];
  /** derived: the coder's task numbers. */
  tasks?: number[];
  after?: { deviation?: string; simpler?: string; done?: "yes" | "partly" | "no"; by?: string; at?: string };
};
export type DesignBody = {
  facts: { text: string; refs?: string[] }[];
  matrix?: Table & { title?: string };
  gaps?: string[];
  decisions: Decision[];
  /** Concerns about the design as a whole. */
  concerns?: Concern[];
  /** Changes not under any decision (files). */
  outside?: string[];
};
export type DesignOrigin = "own" | "external" | "derived";
export type DesignStatus = "drafting" | "review" | "approved" | "assessed" | "recorded";

export const DECISION_KINDS = ["add", "change", "remove", "refactor"] as const;
export const CONCERN_LEVELS = ["problem", "risk", "improve", "question"] as const;
export const CONCERN_STATES = ["open", "resolved", "dropped"] as const;
export const DESIGN_ORIGINS = ["own", "external", "derived"] as const;
export const DESIGN_STATUSES = ["drafting", "review", "approved", "assessed", "recorded"] as const;

export const KIND_LABELS: Record<DecisionKind, string> = { add: "新增", change: "修改", remove: "删除", refactor: "重构" };
export const LEVEL_LABELS: Record<ConcernLevel, string> = { problem: "问题", risk: "风险", improve: "改进", question: "要问" };
export const STATE_LABELS: Record<ConcernState, string> = { open: "未解决", resolved: "已解决", dropped: "不再成立" };
export const ORIGIN_LABELS: Record<DesignOrigin, string> = { own: "自己的方案", external: "别人的方案", derived: "变更说明" };
export const STATUS_LABELS: Record<DesignStatus, string> = { drafting: "在写", review: "等确认", approved: "已通过", assessed: "已评估", recorded: "已记录" };

/** The fields of each kind, in display order, with their labels (§2.1). */
export const DECISION_FIELDS: Record<DecisionKind, { key: string; label: string; hint: string }[]> = {
  add: [
    { key: "entry", label: "入口", hint: "用户或调用方从哪里用到它" },
    { key: "layer", label: "放在哪一层", hint: "放在哪一层、为什么是这一层" },
    { key: "contract", label: "约定", hint: "对外的约定：类型、接口字段、表结构、配置项，只写签名和字段" },
    { key: "reuse", label: "复用", hint: "复用哪些已有机制、有意不复用哪些" },
    { key: "behavior", label: "行为", hint: "按情况的行为表：行是情况，列是预期结果" },
    { key: "excludes", label: "不包含", hint: "这次不包含什么" },
  ],
  change: [
    { key: "behavior", label: "行为", hint: "现在和改后的行为，按情况列成对照表" },
    { key: "where", label: "改在", hint: "改在哪一处（一处），为什么不用改别处" },
    { key: "callers", label: "影响", hint: "受影响的调用方" },
    { key: "migration", label: "过渡", hint: "旧数据、旧版本怎么过渡" },
  ],
  remove: [
    { key: "removes", label: "删掉", hint: "删掉的清单" },
    { key: "users", label: "谁在用", hint: "谁还在用它和“已经没人用”的依据，或它们迁到哪里" },
    { key: "fallback", label: "删后", hint: "删掉以后原来的入口怎么表现" },
    { key: "cleanup", label: "一起清理", hint: "要一起清理的数据、配置和文档" },
  ],
  refactor: [
    { key: "problem", label: "问题", hint: "现在的结构问题（位置）" },
    { key: "structure", label: "改成", hint: "改成什么结构（谁拥有什么）" },
    { key: "invariants", label: "不变的", hint: "不变的行为、靠什么证明没变（已有的测试）" },
    { key: "removes", label: "删掉", hint: "删掉和合并掉的东西" },
  ],
};

/** What a `derived` decision must say at least: its change in behaviour, or the kind's equivalent. */
export const DERIVED_FIELD: Record<DecisionKind, string> = { add: "behavior", change: "behavior", remove: "removes", refactor: "structure" };
/** Fields an `own` decision gives in full (a code snippet, a table or text), not only the one-liner. */
export const EXPANDED_FIELDS = new Set(["contract", "behavior"]);
/** An own decision's contract snippets stay at the boundary: this many lines at most (§2.2). */
export const CODE_LINES_MAX = 30;

const ref = z.string().min(1).max(300);
export const tableSchema = z.object({
  head: z.array(z.string().max(200)).min(1).max(10).describe("列名：第一列是情况，其余是预期结果（修改类写“现在”“改后”）"),
  rows: z.array(z.array(z.string().max(600)).max(10)).min(1).max(40).describe("每行一种情况（哪种用户、哪种数据、哪个版本组合）"),
});
export const fieldSchema = z.object({
  brief: z.string().min(1).max(300).describe("一句话，卡片收起时显示"),
  text: z.string().max(4000).optional().describe("展开后的说明（Markdown）"),
  code: z.string().max(4000).optional().describe("约定片段：类型、接口参数和返回字段、表和列、配置项、路由 meta——只有签名和字段，不写函数体"),
  lang: z.string().max(20).optional().describe("code 的语言，如 ts、sql"),
  table: tableSchema.optional().describe("行为表"),
});
export const concernSchema = z.object({
  id: z.string().regex(/^C\d+$/).optional().describe("上一版已有的意见写它的 id（C1…），新意见不写，宿主编号"),
  level: z.enum(CONCERN_LEVELS).describe("problem 照这样做会出错；risk 可能出问题，要验证或要有回退；improve 有更简单或更统一的做法；question 文档没写清、要问作者的"),
  text: z.string().min(1).max(2000).describe("意见本身：哪里有问题、为什么、建议怎么办"),
  where: z.array(ref).max(10).optional().describe("位置：文件:行、文档里的哪一节"),
  refs: z.array(ref).max(10).optional().describe("依据：src:、mem:、提交号"),
  state: z.enum(CONCERN_STATES).optional().describe("open（默认）/ resolved / dropped；重新评估时上一版的每条意见都要给出现在的状态"),
  note: z.string().max(1000).optional().describe("状态的说明：怎么解决的、为什么不再成立"),
});
export const decisionSchema = z.object({
  id: z.string().regex(/^D\d+$/).optional().describe("上一版已有的决定写它的 id（D1…），新决定不写，宿主编号"),
  kind: z.enum(DECISION_KINDS).describe("add 新增一项能力；change 改变已有功能的行为；remove 去掉一项功能或一段代码；refactor 行为不变、改结构"),
  title: z.string().min(1).max(200).describe("一句话写做法，不写任务（“权限条件写在路由 meta 上，由一处守卫消费”）"),
  reqs: z.array(z.string().max(300)).max(20).default([]).describe("对应的需求点 id；没有需求页时写任务原话里的哪一句"),
  fields: z.record(z.string(), fieldSchema).default({}).describe(
    "栏目，键按种类：add = entry 入口、layer 放在哪一层、contract 对外的约定、reuse 复用、behavior 行为表、excludes 不包含；change = behavior 现在和改后的对照、where 改在哪一处、callers 受影响的调用方、migration 旧数据旧版本怎么过渡；remove = removes 删掉的清单、users 谁还在用和依据、fallback 删后入口怎么表现、cleanup 一起清理的；refactor = problem 现在的结构问题、structure 改成什么结构、invariants 不变的行为和证明、removes 删掉合并掉的。写边界上的东西（约定、行为表、归属、删什么），不写函数体、控制流、变量名、怎么拆文件",
  ),
  rejected: z.array(z.object({ text: z.string().min(1).max(500), why: z.string().min(1).max(500) })).max(10).optional().describe("考虑过但不选的做法，各一句理由；只有一种说得通的做法时不写"),
  question: z.object({
    text: z.string().min(1).max(1000),
    options: z.array(z.string().min(1).max(200)).min(2).max(5),
    recommended: z.number().int().min(0).max(4).optional().describe("建议的选项序号（从 0 开始）"),
  }).optional().describe("要本人定的：问题、两三个选项、建议"),
  stated: z.boolean().optional().describe("评估别人的方案：false = 文档没写、但实现时必须定（从代码推断出来的）"),
  concerns: z.array(concernSchema).max(20).optional().describe("对这个决定的意见（评估时写）"),
  files: z.array(z.string().max(400)).max(200).optional().describe("归到这个决定的文件，仓库id/路径"),
  tasks: z.array(z.number().int().min(1)).max(100).optional().describe("变更说明：编码 Agent 的修改项序号"),
  after: z.object({
    deviation: z.string().max(2000).optional().describe("实际做法和方案不一样的地方和原因，没有就不写"),
    simpler: z.string().max(2000).optional().describe("做完以后看，有没有更简单或可以统一的做法没做；没有就写为什么没有"),
    done: z.enum(["yes", "partly", "no"]).optional(),
  }).optional(),
});
/** What a version is handed in as (submit_design): ids and states may be left for the host to fill. */
export const designBodySchema = z.object({
  facts: z.array(z.object({ text: z.string().min(1).max(1000), refs: z.array(ref).max(10).optional() })).max(30).default([])
    .describe("影响方案的事实：调查中发现的、会改变做法的事实，每条带依据（src:、mem:、文件:行、提交）"),
  matrix: tableSchema.extend({ title: z.string().max(200).optional() }).optional().describe("整体的行为表：跨几个决定的情况（发布顺序、版本组合）"),
  gaps: z.array(z.string().min(1).max(1000)).max(20).optional().describe("和要求不一致的地方：做不到或建议换做法的，直接说"),
  decisions: z.array(decisionSchema).min(1).max(30).describe("决定：一个决定超过一屏说明拆得不对"),
  concerns: z.array(concernSchema).max(30).optional().describe("对整份方案的意见：漏掉的部分（没说旧数据怎么办、没说回滚）"),
  outside: z.array(z.string().max(400)).max(500).optional().describe("方案之外的改动（文件，仓库id/路径）"),
});
export type DesignBodyInput = z.input<typeof designBodySchema>;

export const emptyBody = (): DesignBody => ({ facts: [], decisions: [] });
