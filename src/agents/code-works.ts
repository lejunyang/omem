import { preCheckOf, type PreCheck } from "./pre-check.ts";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { json } from "../core/util.ts";
import { reqStatuses } from "../items/requirements.ts";

/**
 * Coding work as the owner follows it (docs/v2/coding-work.md): one entry per delegation or branch
 * review — its first run and every later round — with where it stands, who it waits on, what comes
 * next, its item and requirements, and its branches. The run page's “编码” view lists these and opens
 * one; the requirements page opens the same view. Read from projected columns only (never patches,
 * check output or the run log), so a list of hundreds stays cheap.
 */

/** Who the work waits on: `owner` (an answer, a confirmation), `active` (running), `assistant`, `idle` (stopped, or nothing for days), `ended`. */
export type WorkGroup = "owner" | "active" | "assistant" | "idle" | "ended";
export type WorkStage = { key: string; text: string; cls: "" | "ok" | "warn" | "danger" | "accent"; group: WorkGroup };
/** What the page offers next; the page maps each to a button. */
export type WorkAction = "stop" | "retry" | "discard" | "confirm" | "apply" | "move" | "code-here" | "clean" | "branch";
export type WorkRepo = { space: string; branch: string | null; base: string | null; cutFrom: string | null; newBranch: boolean; pushedAt: string | null };
export type WorkRound = { id: string; round: number; status: string; title: string; verdict: string | null; createdAt: string; finishedAt: string | null };
export type CodeWork = {
  rootId: string;
  latestId: string;
  title: string;
  spaceId: string | null;
  stage: WorkStage;
  /** One line under the badge: what is going on now. */
  now: string;
  next: { text: string; actions: WorkAction[] };
  branchReview: boolean;
  /** Commits on work branches, confirmed by pushing (code-branch.ts); otherwise an older delegation applied as a patch. */
  branchWork: boolean;
  taskMode: boolean;
  rounds: number;
  /** Task-driven: the requirement's own tasks and the review fixes (done / counted), and who answers what is held up. */
  progress: { build: [number, number]; fix: [number, number]; owner: number; assistant: number; later: number } | null;
  /** Findings of the latest round the owner has not decided on (round-driven delegations and branch reviews). */
  open: number;
  item: { id: string; title: string } | null;
  reqs: { id: string; title: string; kind: string }[];
  repos: WorkRepo[];
  /** The machine of an outside Agent that codes it (`omem tool --peer`). */
  peer: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CodeWorkDetail = CodeWork & {
  task: string;
  roundList: WorkRound[];
  /** Feature points under the item's requirements, with their latest state (from a review split, later from tasks). */
  points: { id: string; title: string; status: string | null; at: string | null }[];
  /** Screenshots, recordings, reports handed in (agents/artifacts.ts). */
  artifacts: number;
  /** The check before coding (agents/pre-check.ts). */
  preCheck: PreCheck | null;
};

/** A work not touched for this long is shown as left aside (“搁着”), whoever it waits on. */
export const STALE_MS = 2 * 86400_000;

type RootRow = {
  id: string; space_id: string | null; user_id: string | null; status: string; title: string; created_at: string;
  task: string | null; item_id: string | null; repos: string | null; branches: string | null; from_branches: string | null; task_mode: number | null; peer: string | null;
  worktrees: string | null; applied_at: string | null; discarded_at: string | null; pushed: string | null; paused: string | null; until: number | null;
};
type RoundRow = { id: string; root: string; status: string; title: string; round: number | null; verdict: string | null; applied_at: string | null; discarded_at: string | null; stopped: string | null; stage: string | null; created_at: string; finished_at: string | null };

const ROOT_COLS = `id, space_id, user_id, status, title, created_at,
  substr(json_extract(input, '$.task'), 1, 4000) task, json_extract(input, '$.itemId') item_id, json_extract(input, '$.repos') repos,
  json_extract(input, '$.branches') branches, json_extract(input, '$.fromBranches') from_branches, json_extract(input, '$.taskMode') task_mode,
  json_extract(input, '$.peerCoder.caller') peer, json_extract(output, '$.worktrees') worktrees, json_extract(output, '$.appliedAt') applied_at,
  json_extract(output, '$.discardedAt') discarded_at, json_extract(output, '$.pushed') pushed, json_extract(output, '$.work.paused') paused, json_extract(output, '$.work.until') until`;

export type WorkFilter = {
  /** Spaces the work belongs to: its own space or one of the repositories it changes. */
  spaces?: string[];
  /** Only these works (their first runs), e.g. the ones done for a requirement's items. */
  roots?: string[];
  q?: string;
  /** Ended work too (pushed, applied, discarded); otherwise only the latest few of them. */
  ended?: boolean;
  limit?: number;
  /** Someone other than the owner: their own work and the work in spaces they may read. */
  visibleTo?: { userId: string; spaces: string[] };
};

export function listCodeWorks(app: App, f: WorkFilter = {}): CodeWork[] {
  const where = ["kind = 'code'", "json_extract(input, '$.continueFrom') is null"];
  const params: (string | number)[] = [];
  if (f.spaces?.length) {
    const marks = f.spaces.map(() => "?").join(",");
    where.push(`(space_id in (${marks}) or exists (select 1 from json_each(coalesce(json_extract(input, '$.repos'), '[]')) j where j.value in (${marks})))`);
    params.push(...f.spaces, ...f.spaces);
  }
  if (f.roots) {
    if (!f.roots.length) return [];
    where.push(`id in (${f.roots.map(() => "?").join(",")})`), params.push(...f.roots);
  }
  if (f.visibleTo) {
    const v = f.visibleTo;
    where.push(`(coalesce(user_id, 'owner') = ?${v.spaces.length ? ` or space_id in (${v.spaces.map(() => "?").join(",")})` : ""})`);
    params.push(v.userId, ...v.spaces);
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    where.push(`(id = ? or title like ? escape '!' or json_extract(input, '$.task') like ? escape '!' or json_extract(output, '$.worktrees') like ? escape '!'
      or exists (select 1 from runs x where x.kind = 'code' and json_extract(x.input, '$.continueFrom') = runs.id and (x.id = ? or x.title like ? escape '!')))`);
    params.push(q, like, like, like, q, like);
  }
  const roots = all<RootRow>(app.db, `select ${ROOT_COLS} from runs where ${where.join(" and ")}`, ...params);
  const works = buildWorks(app, roots).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const ended = works.filter((w) => w.stage.group === "ended");
  const rest = works.filter((w) => w.stage.group !== "ended");
  return [...rest, ...(f.ended ? ended : ended.slice(0, 10))].slice(0, Math.min(f.limit ?? 300, 500));
}

/** The work a run belongs to (any of its rounds), with its rounds, task and requirement points. */
export function codeWork(app: App, runId: string, visibleTo?: WorkFilter["visibleTo"]): CodeWorkDetail | null {
  const r = all<{ root: string }>(app.db, "select coalesce(json_extract(input, '$.continueFrom'), id) root from runs where id = ? and kind = 'code'", runId)[0];
  if (!r) return null;
  const root = all<RootRow>(app.db, `select ${ROOT_COLS} from runs where id = ?`, r.root)[0];
  if (!root) return null;
  if (visibleTo && (root.user_id ?? "owner") !== visibleTo.userId && !visibleTo.spaces.includes(root.space_id ?? "")) return null;
  const [work] = buildWorks(app, [root]);
  const roundList = roundsOf(app, [root.id]).map((x, i) => ({ id: x.id, round: x.round ?? i + 1, status: x.status, title: x.title, verdict: x.verdict, createdAt: x.created_at, finishedAt: x.finished_at }));
  const artifacts = all<{ n: number }>(app.db, "select count(*) n from run_artifacts where work_id = ?", root.id)[0]?.n ?? 0;
  return { ...work, task: root.task ?? "", roundList, points: featurePoints(app, work.reqs.map((n) => n.id)), artifacts, preCheck: preCheckOf(app, root.id) };
}

function roundsOf(app: App, roots: string[]): RoundRow[] {
  if (!roots.length) return [];
  const marks = roots.map(() => "?").join(",");
  return all<RoundRow>(app.db, `select id, coalesce(json_extract(input, '$.continueFrom'), id) root, status, title, json_extract(input, '$.round') round,
      json_extract(output, '$.verdict') verdict, json_extract(output, '$.appliedAt') applied_at, json_extract(output, '$.discardedAt') discarded_at,
      json_extract(output, '$.stoppedByOwner') stopped, json_extract(output, '$.reviewStage') stage, created_at, finished_at
    from runs where kind = 'code' and (id in (${marks}) or json_extract(input, '$.continueFrom') in (${marks})) order by created_at`, ...roots, ...roots);
}

function buildWorks(app: App, roots: RootRow[]): CodeWork[] {
  if (!roots.length) return [];
  const ids = roots.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const rounds = new Map<string, RoundRow[]>(ids.map((id) => [id, []]));
  for (const x of roundsOf(app, ids)) rounds.get(x.root)?.push(x);
  const latest = [...rounds.values()].map((l) => l.at(-1)!.id);
  const lastMarks = latest.map(() => "?").join(",");
  const reviewing = new Set(all<{ parent_id: string }>(app.db, `select distinct parent_id from runs where kind = 'review' and status in ('queued', 'running') and parent_id in (${lastMarks})`, ...latest).map((x) => x.parent_id));
  const open = new Map(all<{ id: string; n: number }>(app.db, `select r.code_run_id id, count(*) n from review_findings f join reviews r on r.id = f.review_id
    where r.code_run_id in (${lastMarks}) and f.state in ('open', 'accepted') and f.severity != 'nit' and f.decision is null group by r.code_run_id`, ...latest).map((x) => [x.id, x.n]));
  const tasks = new Map<string, { kind: string; state: string; later: number; n: number }[]>();
  for (const t of all<{ work_id: string; kind: string; state: string; later: number | null; n: number }>(app.db, `select work_id, kind, state, coalesce(json_extract(origin, '$.later'), 0) later, count(*) n
    from code_tasks where work_id in (${marks}) group by work_id, kind, state, later`, ...ids)) {
    if (!tasks.has(t.work_id)) tasks.set(t.work_id, []);
    tasks.get(t.work_id)!.push({ kind: t.kind, state: t.state, later: Number(t.later) ? 1 : 0, n: t.n });
  }
  const itemIds = [...new Set(roots.map((r) => r.item_id).filter((x): x is string => !!x))];
  const items = new Map(itemIds.length ? all<{ id: string; title: string }>(app.db, `select id, title from items where id in (${itemIds.map(() => "?").join(",")})`, ...itemIds).map((x) => [x.id, x]) : []);
  const reqs = new Map<string, { id: string; title: string; kind: string }[]>();
  if (itemIds.length)
    for (const m of all<{ item_id: string; id: string; title: string; kind: string }>(app.db, `select m.item_id, n.id, n.title, n.kind from item_materials m join req_nodes n on n.id = m.ref
      where m.kind = 'req' and n.status = 'active' and m.item_id in (${itemIds.map(() => "?").join(",")}) order by m.id`, ...itemIds)) {
      if (!reqs.has(m.item_id)) reqs.set(m.item_id, []);
      reqs.get(m.item_id)!.push({ id: m.id, title: m.title, kind: m.kind });
    }
  const nowMs = Date.now();
  return roots.map((root) => {
    const list = rounds.get(root.id)!;
    const last = list.at(-1)!;
    const repos = reposOf(root);
    const progress = progressOf(tasks.get(root.id));
    const branchReview = !!root.branches;
    const branchWork = !branchReview && json<{ commits?: boolean }[]>(root.worktrees, []).some((w) => w.commits);
    const updatedAt = list.reduce((t, x) => [t, x.created_at, x.finished_at ?? ""].reduce((a, b) => (a > b ? a : b)), root.created_at);
    const work: CodeWork = {
      rootId: root.id, latestId: last.id, title: root.title, spaceId: root.space_id, stage: { key: "", text: "", cls: "", group: "idle" }, now: "", next: { text: "", actions: [] },
      branchReview, branchWork, taskMode: !!root.task_mode, rounds: list.length, progress, open: open.get(last.id) ?? 0,
      item: root.item_id ? items.get(root.item_id) ?? null : null, reqs: root.item_id ? reqs.get(root.item_id) ?? [] : [], repos, peer: root.peer, createdAt: root.created_at, updatedAt,
    };
    describe(work, root, list, reviewing.has(last.id), nowMs - Date.parse(updatedAt));
    return work;
  });
}

function reposOf(root: RootRow): WorkRepo[] {
  const pushed = json<{ space: string; at: string }[]>(root.pushed, []);
  const at = (space: string) => pushed.filter((p) => p.space === space).at(-1)?.at ?? null;
  if (root.branches) {
    return Object.entries(json<Record<string, { branch: string; base?: string }>>(root.branches, {})).map(([space, b]) => ({ space, branch: b.branch, base: b.base ?? null, cutFrom: null, newBranch: false, pushedAt: null }));
  }
  const wts = json<{ space: string; branch?: string; targetBranch?: string | null; cutFrom?: string; base?: string; newBranch?: boolean; commits?: boolean }[]>(root.worktrees, []);
  if (wts.length) return wts.map((w) => ({ space: w.space, branch: w.targetBranch ?? w.branch ?? null, base: w.base ?? null, cutFrom: w.cutFrom ?? null, newBranch: !!w.newBranch, pushedAt: at(w.space) }));
  // Not started yet: the repositories it is for, and the branch it was asked to continue.
  const from = json<Record<string, string>>(root.from_branches, {});
  return json<string[]>(root.repos, []).map((space) => ({ space, branch: from[space] ?? null, base: null, cutFrom: null, newBranch: false, pushedAt: null }));
}

function progressOf(rows?: { kind: string; state: string; later: number; n: number }[]): CodeWork["progress"] {
  if (!rows?.length) return null;
  const p = { build: [0, 0] as [number, number], fix: [0, 0] as [number, number], owner: 0, assistant: 0, later: 0 };
  for (const r of rows) {
    const side = r.kind === "fix" ? p.fix : p.build;
    if (r.state === "owner") p.owner += r.n;
    if (r.state === "assistant") p.assistant += r.n;
    if (r.state === "wontdo" && r.later) p.later += r.n;
    // Dropped and reverted tasks are not part of what is left to do.
    if (r.state === "wontdo" || r.state === "reverted") continue;
    side[1] += r.n;
    if (r.state === "done") side[0] += r.n;
  }
  return p;
}

const PAUSED: Record<string, string> = { budget: "暂停：自动推进的轮数用完了", owner: "你暂停了", paused: "已暂停", "not-converging": "暂停：修改没有收敛", polishing: "暂停：需求早已做完，评审还在一轮轮提问题" };

/** Stage, the line under it and the next step, from the latest round and the tasks. */
function describe(w: CodeWork, root: RootRow, list: RoundRow[], reviewing: boolean, idleMs: number) {
  const last = list.at(-1)!;
  const set = (key: string, text: string, cls: WorkStage["cls"], group: WorkGroup, now: string, next: string, actions: WorkAction[] = []) => {
    w.stage = { key, text, cls, group };
    w.now = now;
    w.next = { text: next, actions };
  };
  // “第 3 轮：修改项 T4、T6”; the first round carries the work's own title, said already.
  const what = last.title === root.title ? "" : last.title.replace(/^交办第 \d+ 轮：/, "");
  const round = `第 ${list.length} 轮`;
  const branches = w.repos.filter((r) => r.branch).map((r) => r.branch!);
  const branchText = [...new Set(branches)].join("、") || "工作分支";
  const p = w.progress;
  const applied = root.applied_at ?? list.find((x) => x.applied_at)?.applied_at;
  const discarded = root.discarded_at ?? list.find((x) => x.discarded_at)?.discarded_at;
  if (applied) {
    const text = w.branchReview ? "已清理" : w.branchWork ? "已推送" : "已应用";
    return set("ended", text, "ok", "ended", `${text}，共 ${list.length} 轮`, w.branchReview ? "评审结束。要按意见修改，在这条分支上交办。" : `已结束。要接着改，在同一分支（${branchText}）上新交办，之前留下的项会接上。`);
  }
  if (discarded) return set("ended", w.branchReview ? "已清理" : "已丢弃", "", "ended", `${round}后丢弃`, "已结束。");
  if (last.status === "queued" || last.status === "running") {
    const text = last.status === "queued" ? "排队中" : w.branchReview ? "评审中" : last.stage === "verify" ? "逐项验证中" : ["plan", "checks", "lead"].includes(last.stage ?? "") ? "阶段评审中" : "编码中";
    return set("running", text, "accent", "active", `${round}${what ? `：${what}` : ""}`, w.branchReview ? "评审完成后在这里看结论。" : "编码 Agent 在做这一轮；有补充可以直接写给它，或者停下这一轮。", w.branchReview ? [] : ["stop"]);
  }
  if (reviewing) return set("reviewing", "评审中", "accent", "active", `${round}的改动在评审`, "评审完成后自动接着做。");
  if (last.verdict === "awaiting-peer" || last.verdict === "awaiting-peer-code") {
    const who = w.peer ? `设备 ${w.peer} 的外部 Agent` : "外部 Agent";
    return set("peer", `等${last.verdict === "awaiting-peer" ? "外部评审" : "外部编码"}`, "accent", "active", `等${who}${last.verdict === "awaiting-peer" ? "评审" : "编码"}`, `等${who}做完；不想等可以改用这台机器的 AI。`, last.verdict === "awaiting-peer-code" ? ["code-here", "discard"] : ["discard"]);
  }
  // Waiting on someone: the owner first, then the assistant; nothing for days counts as left aside.
  const waiting = (key: string, text: string, cls: WorkStage["cls"], group: WorkGroup, now: string, next: string, actions: WorkAction[] = []) => {
    const days = Math.floor(idleMs / 86400_000);
    if (idleMs > STALE_MS) return set(key, `${text} · ${days} 天没动`, cls, "idle", now, next, actions);
    set(key, text, cls, group, now, next, actions);
  };
  if (p?.owner) return waiting("owner-tasks", `等你决定 ${p.owner} 项`, "warn", "owner", "其他项照常推进", "回答“概览”里等你决定的问题，回答后马上排下一轮。");
  if (last.verdict === "sync-conflict") return waiting("sync", "同步有冲突", "warn", "owner", "Git 同步停在冲突上", "在“分支”里继续或放弃这次同步。", ["branch"]);
  if (last.status === "failed") return waiting("failed", "这一轮失败了", "danger", "owner", `${round}失败`, "重试会接着上次的进度做；不要了就丢弃。", ["retry", "discard"]);
  if (last.status === "cancelled") {
    const by = last.stopped ? "你停下的" : "被停下了";
    return set("stopped", by, "", "idle", `${round}${last.stopped ? `：${last.stopped}` : "被停下"}`, "接着做就重试这一轮（接着上次的进度）；不要了就丢弃。", ["retry", "discard"]);
  }
  if (p?.assistant || last.verdict === "awaiting-assistant") return waiting("assistant", "助手在处理", "accent", "assistant", `${p?.assistant ?? 0} 项交给了发起交办的助手`, "助手处理完会接着做；你也可以直接在“概览”里回答。");
  if (root.paused) return waiting("paused", PAUSED[root.paused] ?? "已暂停", "warn", "owner", round, "在“概览”里点“继续”再推进一份预算；剩下的项不做了也可以在那里放下。");
  if (last.verdict === "approved") {
    if (w.branchReview) return w.open
      ? waiting("review-open", `${w.open} 个问题待定`, "warn", "owner", "评审完成", "在“概览”里挑要改的问题，“开始修改”会在这条分支上交办。", ["clean"])
      : waiting("review-ok", "评审通过", "ok", "owner", "评审完成，没有要改的", "不用改就清理评审工作区。", ["clean"]);
    return w.branchWork
      ? waiting("done", "完成，等你确认", "ok", "owner", "最近一次评审没有要改的问题", `确认后把 ${branchText} 推送到 origin，归还工作区；合进主干在代码平台上发合并请求。`, ["confirm", "discard"])
      : waiting("done", "完成，等你应用", "ok", "owner", "评审通过", "应用到原分支（写成未提交的修改），目标分支有新提交时先移到它的最新提交。", ["apply", "move", "discard"]);
  }
  if (last.verdict === "changes-requested") return waiting("findings", w.open ? `${w.open} 个问题待定` : "等你决定要改的问题", "warn", "owner", "评审要求修改", "在“概览”里决定要改的问题，开始修改后接着做。", w.branchReview ? ["clean"] : ["discard"]);
  if (last.verdict === "awaiting-plan") return waiting("plan", "确认评审计划", "warn", "owner", "编码完成，评审计划等你确认", "在“概览”里确认或调整评审计划。");
  if (last.verdict === "no-changes") return waiting("no-changes", "没有改动", "warn", "owner", `${round}没有产生改动`, "补充要求接着做，或者丢弃。", ["discard"]);
  set("stalled", "停住了", "", "idle", `${round}结束后没有接着排`, "重试最后一轮接着做，或者丢弃。", ["retry", "discard"]);
}

/** The feature points under the requirement nodes an item is about, with their latest state. */
function featurePoints(app: App, roots: string[]) {
  if (!roots.length) return [];
  const marks = roots.map(() => "?").join(",");
  const nodes = all<{ id: string; title: string; kind: string }>(app.db, `with recursive sub(id) as (select id from req_nodes where id in (${marks}) union select n.id from req_nodes n join sub on n.parent_id = sub.id where n.status = 'active')
    select n.id, n.title, n.kind from req_nodes n join sub on sub.id = n.id where n.kind = 'feature' and n.status = 'active' order by n.seq, n.created_at limit 80`, ...roots);
  const states = reqStatuses(app, nodes.map((n) => n.id));
  return nodes.map((n) => ({ id: n.id, title: n.title, status: states.get(n.id)?.status ?? null, at: states.get(n.id)?.at ?? null }));
}
