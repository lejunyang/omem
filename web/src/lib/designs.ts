/**
 * Designs as the web page shows them (docs/v2/coding-plan.md §2, §5, §6.4). The types and labels follow
 * src/designs/types.ts (the web cannot import src/): keep the two in step.
 */
export type DecisionKind = "add" | "change" | "remove" | "refactor";
export type Table = { head: string[]; rows: string[][] };
export type Field = { brief: string; text?: string; code?: string; lang?: string; table?: Table };
export type ConcernLevel = "problem" | "risk" | "improve" | "question";
export type ConcernState = "open" | "resolved" | "dropped";
export type Concern = { id: string; level: ConcernLevel; text: string; where?: string[]; refs?: string[]; state: ConcernState; note?: string; by?: string };
export type Decision = {
  id: string;
  kind: DecisionKind;
  title: string;
  reqs: string[];
  fields: Record<string, Field>;
  rejected?: { text: string; why: string }[];
  question?: { text: string; options: string[]; recommended?: number; answer?: string };
  stated?: boolean;
  concerns?: Concern[];
  files?: string[];
  tasks?: number[];
  after?: { deviation?: string; simpler?: string; done?: "yes" | "partly" | "no"; by?: string; at?: string };
};
export type DesignBody = {
  facts: { text: string; refs?: string[] }[];
  matrix?: Table & { title?: string };
  gaps?: string[];
  decisions: Decision[];
  concerns?: Concern[];
  outside?: string[];
};
export type DesignOrigin = "own" | "external" | "derived";
export type DesignStatus = "drafting" | "review" | "approved" | "assessed" | "recorded";
export type DesignCounts = { decisions: number; questions: number; concerns: Record<ConcernLevel, number> };

/** A row of `GET /api/designs`. */
export type DesignSummary = {
  id: string; title: string; origin: DesignOrigin; status: DesignStatus; revision: number; author: string | null;
  itemId: string | null; workId: string | null; spaceId: string; updatedAt: string; counts: DesignCounts;
};
export type ChangedFile = { space: string; path: string; add: number; del: number };
export type DecisionChange = { decision: string; tasks: { seq: number; title: string; state: string }[]; commits: number; files: ChangedFile[]; findings: { open: number; total: number } };
/** `GET /api/designs/:id` (with `?revision=`: body, counts and revision are that version's). */
export type DesignDetail = DesignSummary & {
  sources: string[];
  repos: string[];
  body: DesignBody;
  revisions: { revision: number; at: string; note: string; runId: string | null }[];
  item: { id: string; title: string } | null;
  reqs: { id: string; title: string; kind: string }[];
  /** The requirement points the decisions name that are not among `reqs`, with the requirement above them (not sent by every server yet). */
  reqNodes?: { id: string; title: string; kind: string; parentTitle: string | null }[];
  work: { rootId: string; title: string; branchReview: boolean } | null;
  changes: DecisionChange[];
  outside: ChangedFile[];
  /** The run writing the current version (not sent by every server yet). */
  runId?: string | null;
};

export const DECISION_KINDS: DecisionKind[] = ["add", "change", "remove", "refactor"];
export const CONCERN_LEVELS: ConcernLevel[] = ["problem", "risk", "improve", "question"];
export const KIND_LABELS: Record<DecisionKind, string> = { add: "新增", change: "修改", remove: "删除", refactor: "重构" };
/** Each kind's badge: different but quiet colours from styles.css. */
export const KIND_CLS: Record<DecisionKind, string> = { add: "ok", change: "accent", remove: "danger", refactor: "warn" };
export const LEVEL_LABELS: Record<ConcernLevel, string> = { problem: "问题", risk: "风险", improve: "改进", question: "要问" };
export const LEVEL_CLS: Record<ConcernLevel, string> = { problem: "danger", risk: "warn", improve: "accent", question: "" };
export const STATE_LABELS: Record<ConcernState, string> = { open: "未解决", resolved: "已解决", dropped: "不采纳" };
export const ORIGIN_LABELS: Record<DesignOrigin, string> = { own: "自己的方案", external: "别人的方案", derived: "变更说明" };
export const STATUS_LABELS: Record<DesignStatus, string> = { drafting: "在写", review: "等你确认", approved: "已通过", assessed: "已评估", recorded: "已记录" };
export const STATUS_CLS: Record<DesignStatus, string> = { drafting: "", review: "accent", approved: "ok", assessed: "ok", recorded: "" };
export const DONE_LABELS: Record<"yes" | "partly" | "no", { text: string; cls: string }> = { yes: { text: "做了", cls: "ok" }, partly: { text: "部分", cls: "warn" }, no: { text: "没做", cls: "danger" } };

/** The fields of each kind in display order (src/designs/types.ts DECISION_FIELDS). */
export const DECISION_FIELDS: Record<DecisionKind, { key: string; label: string }[]> = {
  add: [
    { key: "entry", label: "入口" },
    { key: "layer", label: "放在哪一层" },
    { key: "contract", label: "约定" },
    { key: "reuse", label: "复用" },
    { key: "behavior", label: "行为" },
    { key: "excludes", label: "不包含" },
  ],
  change: [
    { key: "behavior", label: "行为" },
    { key: "where", label: "改在" },
    { key: "callers", label: "影响" },
    { key: "migration", label: "过渡" },
  ],
  remove: [
    { key: "removes", label: "删掉" },
    { key: "users", label: "谁在用" },
    { key: "fallback", label: "删后" },
    { key: "cleanup", label: "一起清理" },
  ],
  refactor: [
    { key: "problem", label: "问题" },
    { key: "structure", label: "改成" },
    { key: "invariants", label: "不变的" },
    { key: "removes", label: "删掉" },
  ],
};

/** “drafting” in the words of where it comes from. */
export const draftingText = (origin: DesignOrigin) => (origin === "external" ? "正在评估" : origin === "derived" ? "正在整理变更说明" : "正在写方案");
export const statusText = (d: Pick<DesignSummary, "origin" | "status">) => (d.status === "drafting" ? draftingText(d.origin) : STATUS_LABELS[d.status]);

/** “3 个决定，1 个要你定” and the open concerns by level (only those with any). */
export function countParts(c: DesignCounts) {
  return {
    head: `${c.decisions} 个决定${c.questions ? `，${c.questions} 个要你定` : ""}`,
    levels: CONCERN_LEVELS.filter((l) => c.concerns[l]).map((l) => ({ level: l, label: LEVEL_LABELS[l], n: c.concerns[l], cls: LEVEL_CLS[l] })),
  };
}
export function countLine(c: DesignCounts) {
  const p = countParts(c);
  return p.levels.length ? `${p.head} · ${p.levels.map((l) => `${l.label} ${l.n}`).join(" ")}` : p.head;
}

/** A decision's open concerns by level, for the collapsed card. */
export function concernTally(d: Pick<Decision, "concerns">) {
  const open = (d.concerns ?? []).filter((c) => c.state === "open");
  return CONCERN_LEVELS.map((l) => ({ level: l, label: LEVEL_LABELS[l], cls: LEVEL_CLS[l], n: open.filter((c) => c.level === l).length })).filter((x) => x.n);
}

/** One line for a decision's changes: “T1 T2 · 3 次提交 · 4 个文件 +120 −40”; empty when there are none. */
export function changeLine(c: DecisionChange | undefined) {
  if (!c) return "";
  const parts: string[] = [];
  if (c.tasks.length) parts.push(c.tasks.map((t) => `T${t.seq}`).join(" "));
  if (c.commits) parts.push(`${c.commits} 次提交`);
  if (c.files.length) {
    const add = c.files.reduce((n, f) => n + f.add, 0), del = c.files.reduce((n, f) => n + f.del, 0);
    parts.push(`${c.files.length} 个文件${add || del ? ` +${add} −${del}` : ""}`);
  }
  return parts.join(" · ");
}
export const hasChange = (c: DecisionChange | undefined) => !!c && (c.tasks.length > 0 || c.commits > 0 || c.files.length > 0 || c.findings.total > 0);

/** An omem id (`q0mvv50jyh711f6bc1cc`): a prefix, nine base-36 characters of time, ten hex. */
export const looksLikeId = (s: string) => /^[a-z]{1,4}[0-9a-z]{9}[0-9a-f]{10}$/.test(s);

export type ReqPoint = { key: string; title: string; n: number; link: string | null; under: string | null };
/**
 * The requirement points beside the decisions: each with its own title and how many decisions it has.
 * A point with no title the page knows falls back to the requirement it belongs to and a number, never
 * the bare id; titles that repeat get the requirement above them or a number to tell them apart. The
 * item's requirements no decision names are only counted (`idle`).
 */
export function reqPoints(d: Pick<DesignDetail, "reqs" | "reqNodes"> & { body: Pick<DesignBody, "decisions"> }): { list: ReqPoint[]; idle: number } {
  const nodes = new Map<string, { title: string; under: string | null }>();
  for (const r of d.reqs) nodes.set(r.id, { title: r.title, under: null });
  for (const r of d.reqNodes ?? []) nodes.set(r.id, { title: r.title, under: r.parentTitle });
  const keys = [...new Set([...d.reqs.map((r) => r.id), ...d.body.decisions.flatMap((x) => x.reqs)])];
  const count = (k: string) => d.body.decisions.filter((x) => x.reqs.includes(k)).length;
  const owner = d.reqs.length === 1 || new Set(d.reqs.map((r) => r.title)).size === 1 ? d.reqs[0]?.title ?? null : null;
  let unnamed = 0;
  const list: ReqPoint[] = keys.map((k) => {
    const node = nodes.get(k);
    if (node) return { key: k, title: node.title.trim() || `需求点 ${++unnamed}`, n: count(k), link: `/code/reqs/${k}`, under: node.under };
    if (looksLikeId(k)) return { key: k, title: `${owner ? `${owner} · ` : ""}需求点 ${++unnamed}`, n: count(k), link: `/code/reqs/${k}`, under: null };
    // No requirement page: the decision quotes the task's own words.
    return { key: k, title: k, n: count(k), link: null, under: null };
  });
  const used = list.filter((r) => r.n > 0);
  // The same title twice: say which requirement each is under, else number them.
  const groups = new Map<string, ReqPoint[]>();
  for (const r of used) groups.set(r.title, [...(groups.get(r.title) ?? []), r]);
  for (const [title, same] of groups) {
    if (same.length < 2) continue;
    const unders = same.map((r) => r.under);
    const byUnder = unders.every((u) => u && u !== title) && new Set(unders).size === same.length;
    same.forEach((r, i) => (r.title = byUnder ? `${r.under} · ${title}` : `${title}（${i + 1}）`));
  }
  return { list: used, idle: list.length - used.length };
}

/** Files that are not code: images, data exports, logs (by extension). */
const NOT_CODE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "mp4", "webm", "mov", "ndjson", "jsonl", "csv", "tsv", "xlsx", "xls", "parquet", "sqlite", "db", "log", "out", "zip", "tar", "gz"]);
export const isCodeFile = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return !NOT_CODE.has(dot > 0 ? base.slice(dot + 1).toLowerCase() : "");
};
export type FileGroup = { dir: string; files: ChangedFile[]; add: number; del: number };
/**
 * Changed files by directory (the first `depth` levels), largest group first; files that are not code
 * go into one last group (`dir` empty) whatever directory they are in.
 */
export function fileGroups(files: ChangedFile[], depth = 2): { groups: FileGroup[]; other: FileGroup | null } {
  const by = new Map<string, FileGroup>();
  const other: FileGroup = { dir: "", files: [], add: 0, del: 0 };
  const multi = new Set(files.map((f) => f.space)).size > 1;
  for (const f of files) {
    const dir = [multi ? f.space : "", dirOf(f, depth)].filter(Boolean).join("/");
    if (isCodeFile(f.path) && !by.has(dir)) by.set(dir, { dir, files: [], add: 0, del: 0 });
    const g = isCodeFile(f.path) ? by.get(dir)! : other;
    g.files.push(f);
    g.add += f.add;
    g.del += f.del;
  }
  return { groups: [...by.values()].sort((a, b) => b.files.length - a.files.length || a.dir.localeCompare(b.dir)), other: other.files.length ? other : null };
}
function dirOf(f: ChangedFile, depth: number) {
  const parts = f.path.split("/").slice(0, -1);
  return parts.slice(0, depth).join("/");
}
