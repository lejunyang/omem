import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import {
  CODE_LINES_MAX, CONCERN_LEVELS, DECISION_FIELDS, DERIVED_FIELD, designBodySchema, EXPANDED_FIELDS, KIND_LABELS, emptyBody,
  type Concern, type ConcernLevel, type ConcernState, type Decision, type DesignBody, type DesignOrigin, type DesignStatus,
} from "./types.ts";

/**
 * Designs and their versions (docs/v2/coding-plan.md §6.1). The host keeps decision ids (D<n>) and
 * concern ids (C<n>) stable from version to version, checks each version by where the design comes
 * from (§2.1), and moves the status; what the decisions say is the designer's.
 */

export type Design = {
  id: string;
  spaceId: string;
  itemId: string | null;
  title: string;
  origin: DesignOrigin;
  author: string | null;
  sources: string[];
  repos: string[];
  status: DesignStatus;
  revision: number;
  body: DesignBody;
  workId: string | null;
  runId: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DesignCounts = { decisions: number; questions: number; concerns: Record<ConcernLevel, number> };
export type DesignSummary = Pick<Design, "id" | "title" | "origin" | "status" | "revision" | "author" | "itemId" | "workId" | "spaceId" | "updatedAt"> & { counts: DesignCounts };
export type DesignRevision = { revision: number; at: string; note: string; runId: string | null };
export type DesignAction = "approve" | "comment" | "rethink";
/** What the owner (or, when allowed, the assistant) said about an own design: read by the run that rewrites it. */
export type DesignFeedback = { revision: number; action: DesignAction; text: string; answers: Record<string, string>; by: string; at: string };

type Row = {
  id: string; space_id: string; item_id: string | null; title: string; origin: string; author: string | null; sources: string; repos: string;
  status: string; revision: number; body: string; work_id: string | null; run_id: string | null; user_id: string | null; created_at: string; updated_at: string;
};
const toDesign = (r: Row): Design => ({
  id: r.id, spaceId: r.space_id, itemId: r.item_id, title: r.title, origin: r.origin as DesignOrigin, author: r.author,
  sources: json<string[]>(r.sources, []), repos: json<string[]>(r.repos, []), status: r.status as DesignStatus, revision: r.revision,
  body: { ...emptyBody(), ...json<Partial<DesignBody>>(r.body, {}) }, workId: r.work_id, runId: r.run_id, userId: r.user_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createDesign(app: App, input: { spaceId: string; title: string; origin: DesignOrigin; itemId?: string | null; author?: string | null; sources?: string[]; repos?: string[]; workId?: string | null; userId?: string | null }): Design {
  const id = newId("dsg");
  const at = now();
  run(app.db, "insert into designs(id,space_id,item_id,title,origin,author,sources,repos,status,revision,body,work_id,run_id,user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,0,'{}',?,null,?,?,?)",
    id, input.spaceId, input.itemId ?? null, input.title.trim(), input.origin, input.author?.trim() || null, JSON.stringify(input.sources ?? []), JSON.stringify(input.repos ?? []),
    "drafting", input.workId ?? null, input.userId ?? null, at, at);
  return getDesign(app, id);
}

export function findDesign(app: App, id: string): Design | null {
  const r = one<Row>(app.db, "select * from designs where id = ?", id);
  return r ? toDesign(r) : null;
}
export function getDesign(app: App, id: string): Design {
  const d = findDesign(app, id);
  if (!d) throw new HttpError(404, `没有方案 ${id}`);
  return d;
}

/** One version's body (the current one when `revision` is absent or equals it). */
export function designBodyAt(app: App, design: Design, revision?: number): DesignBody {
  if (revision === undefined || revision === design.revision) return design.body;
  const r = one<{ body: string }>(app.db, "select body from design_revisions where design_id = ? and revision = ?", design.id, revision);
  if (!r) throw new HttpError(404, `方案 ${design.id} 没有第 ${revision} 版`);
  return { ...emptyBody(), ...json<Partial<DesignBody>>(r.body, {}) };
}

export function designRevisions(app: App, id: string): DesignRevision[] {
  return all<{ revision: number; at: string; note: string; run_id: string | null }>(app.db, "select revision, at, note, run_id from design_revisions where design_id = ? order by revision", id)
    .map((r) => ({ revision: r.revision, at: r.at, note: r.note, runId: r.run_id }));
}

const allConcerns = (b: DesignBody): Concern[] => [...(b.concerns ?? []), ...b.decisions.flatMap((d) => d.concerns ?? [])];

/** Decisions, questions still waiting on the owner, and open concerns by level. */
export function designCounts(body: DesignBody): DesignCounts {
  const concerns = Object.fromEntries(CONCERN_LEVELS.map((l) => [l, 0])) as Record<ConcernLevel, number>;
  for (const c of allConcerns(body)) if (c.state === "open") concerns[c.level]++;
  return { decisions: body.decisions.length, questions: body.decisions.filter((d) => d.question && !d.question.answer?.trim()).length, concerns };
}

export const designSummary = (d: Design): DesignSummary => ({
  id: d.id, title: d.title, origin: d.origin, status: d.status, revision: d.revision, author: d.author, itemId: d.itemId, workId: d.workId, spaceId: d.spaceId, updatedAt: d.updatedAt, counts: designCounts(d.body),
});

/** Designs by item / space / work; `spaces`: only those in these spaces (null: all). Newest first. */
export function listDesigns(app: App, f: { item?: string; space?: string; work?: string; spaces?: string[] | null; limit?: number } = {}): DesignSummary[] {
  const where: string[] = [];
  const params: string[] = [];
  if (f.item) where.push("item_id = ?"), params.push(f.item);
  if (f.space) where.push("space_id = ?"), params.push(f.space);
  if (f.work) where.push("work_id = ?"), params.push(f.work);
  if (f.spaces) {
    if (!f.spaces.length) return [];
    where.push(`space_id in (${f.spaces.map(() => "?").join(",")})`), params.push(...f.spaces);
  }
  const rows = all<Row>(app.db, `select * from designs ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc, rowid desc limit ?`, ...params, Math.min(f.limit ?? 200, 500));
  return rows.map((r) => designSummary(toDesign(r)));
}

/** The design a delegation or branch review (its first run) is based on, if any: the latest. */
export function designOfWork(app: App, rootRunId: string): Design | null {
  const r = one<Row>(app.db, "select * from designs where work_id = ? order by updated_at desc, rowid desc limit 1", rootRunId);
  return r ? toDesign(r) : null;
}

/**
 * The design a delegation or branch review (its first run) goes by: the one bound to it, else the
 * one its first run names (`input.designId`: an earlier branch review of someone else's design that a
 * later review has since taken over).
 */
export function designForWork(app: App, rootRunId: string): Design | null {
  const bound = designOfWork(app, rootRunId);
  if (bound) return bound;
  const r = one<{ id: string | null }>(app.db, "select json_extract(input, '$.designId') id from runs where id = ?", rootRunId);
  return r?.id ? findDesign(app, r.id) : null;
}

/** An item's designs, newest first. */
export function designsOfItem(app: App, itemId: string): Design[] {
  return all<Row>(app.db, "select * from designs where item_id = ? order by updated_at desc, rowid desc", itemId).map(toDesign);
}

const num = (id: string) => Number(id.slice(1));

/** Every decision / concern id any version of the design used: a dropped id is never given to another one. */
function usedIds(app: App, d: Design) {
  const used = { decisions: new Set<string>(), concerns: new Set<string>() };
  const bodies = [d.body, ...all<{ body: string }>(app.db, "select body from design_revisions where design_id = ?", d.id).map((r) => json<DesignBody>(r.body, emptyBody()))];
  for (const b of bodies) {
    for (const x of b.decisions ?? []) used.decisions.add(x.id);
    for (const c of allConcerns({ ...emptyBody(), ...b })) used.concerns.add(c.id);
  }
  return used;
}

/**
 * The submitted version with the host's ids: an id from the previous version keeps it (in a first
 * version any unused id is taken as given), anything else is refused; the rest are numbered after
 * the highest one ever used. A question the owner answered stays answered while it is asked the same way.
 */
function normalize(app: App, d: Design, input: unknown): { body: DesignBody; problems: string[] } {
  const parsed = designBodySchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, `方案格式不对：${parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join("；")}`);
  const p = parsed.data;
  const problems: string[] = [];
  const used = usedIds(app, d);
  const prev = d.revision > 0 ? d.body : emptyBody();
  const prevDecisions = new Map(prev.decisions.map((x) => [x.id, x]));
  const prevConcerns = new Set(allConcerns(prev).map((c) => c.id));
  const claim = (given: string | undefined, prevIds: Set<string> | Map<string, unknown>, everUsed: Set<string>, taken: Set<string>, what: string) => {
    if (!given) return null;
    if (taken.has(given)) { problems.push(`${what} ${given} 出现了两次`); return null; }
    if (!prevIds.has(given) && everUsed.has(given)) { problems.push(`${what} ${given} 是之前删掉的，不能再用；新的不写 id`); return null; }
    if (!prevIds.has(given) && d.revision > 0) { problems.push(`上一版没有${what} ${given}；新的不写 id，由宿主编号`); return null; }
    taken.add(given);
    return given;
  };
  // Ids first (given ones are reserved before numbering the rest).
  const takenD = new Set<string>();
  const dIds = p.decisions.map((x) => claim(x.id, prevDecisions, used.decisions, takenD, "决定"));
  const takenC = new Set<string>();
  const decisionConcerns = p.decisions.map((x) => x.concerns ?? []);
  const cIds = [...(p.concerns ?? []), ...decisionConcerns.flat()].map((c) => claim(c.id, prevConcerns, used.concerns, takenC, "意见"));
  let maxD = Math.max(0, ...[...used.decisions, ...takenD].map(num));
  let maxC = Math.max(0, ...[...used.concerns, ...takenC].map(num));
  let ci = 0;
  const concern = (c: (typeof decisionConcerns)[number][number]): Concern => {
    const id = cIds[ci++] ?? `C${++maxC}`;
    return { id, level: c.level, text: c.text.trim(), ...(c.where?.length ? { where: c.where } : {}), ...(c.refs?.length ? { refs: c.refs } : {}), state: c.state ?? "open", ...(c.note?.trim() ? { note: c.note.trim() } : {}) };
  };
  const overall = (p.concerns ?? []).map(concern);
  const decisions: Decision[] = p.decisions.map((x, i) => {
    const id = dIds[i] ?? `D${++maxD}`;
    const before = prevDecisions.get(id);
    const answer = before?.question?.answer && x.question && before.question.text.trim() === x.question.text.trim() ? before.question.answer : undefined;
    const fields = Object.fromEntries(Object.entries(x.fields).map(([k, f]) => [k, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== ""))])) as Decision["fields"];
    return {
      id, kind: x.kind, title: x.title.trim(), reqs: x.reqs, fields,
      ...(x.rejected?.length ? { rejected: x.rejected } : {}),
      ...(x.question ? { question: { ...x.question, ...(answer ? { answer } : {}) } } : {}),
      ...(x.stated !== undefined ? { stated: x.stated } : {}),
      ...(x.concerns?.length ? { concerns: x.concerns.map(concern) } : {}),
      ...(x.files?.length ? { files: x.files } : {}),
      ...(x.tasks?.length ? { tasks: x.tasks } : {}),
      ...(x.after && Object.values(x.after).some((v) => v) ? { after: { ...(before?.after ?? {}), ...x.after } } : before?.after ? { after: before.after } : {}),
    };
  });
  const body: DesignBody = {
    facts: p.facts.map((f) => ({ text: f.text.trim(), ...(f.refs?.length ? { refs: f.refs } : {}) })),
    ...(p.matrix ? { matrix: p.matrix } : {}),
    ...(p.gaps?.length ? { gaps: p.gaps } : {}),
    decisions,
    ...(overall.length ? { concerns: overall } : {}),
    ...(p.outside?.length ? { outside: p.outside } : {}),
  };
  return { body, problems };
}

/** What each origin needs of a decision (§2.1). */
function check(d: Design, body: DesignBody, problems: string[]) {
  for (const x of body.decisions) {
    const label = `${x.id}（${KIND_LABELS[x.kind]}）`;
    const keys = DECISION_FIELDS[x.kind].map((f) => f.key);
    const unknown = Object.keys(x.fields).filter((k) => !keys.includes(k));
    if (unknown.length) problems.push(`${label} 没有栏目 ${unknown.join("、")}；${KIND_LABELS[x.kind]}的栏目是 ${keys.join("、")}`);
    if (x.question && x.question.recommended !== undefined && x.question.recommended >= x.question.options.length) problems.push(`${label} 的问题建议了第 ${x.question.recommended} 个选项，但只有 ${x.question.options.length} 个`);
    if (d.origin === "own") {
      const missing = keys.filter((k) => !x.fields[k]?.brief?.trim());
      if (missing.length) problems.push(`${label} 缺栏目 ${missing.join("、")}（自己的方案每个栏目都要有 brief；确实不涉及的写一句“不涉及：…”）`);
      const bare = keys.filter((k) => EXPANDED_FIELDS.has(k) && x.fields[k]?.brief && !x.fields[k].text && !x.fields[k].code && !x.fields[k].table);
      if (bare.length) problems.push(`${label} 的 ${bare.join("、")} 只有一句话：约定给出签名和字段（code），行为给出按情况的表（table）`);
      const lines = Object.values(x.fields).reduce((n, f) => n + (f.code ? f.code.split("\n").length : 0), 0);
      if (lines > CODE_LINES_MAX) problems.push(`${label} 的约定片段有 ${lines} 行（不超过 ${CODE_LINES_MAX} 行）：只写签名和字段，不写实现；写不下说明这个决定该拆开`);
    } else if (d.origin === "derived") {
      const key = DERIVED_FIELD[x.kind];
      if (!x.fields[key]?.brief?.trim()) problems.push(`${label} 要写 ${key}（${DECISION_FIELDS[x.kind].find((f) => f.key === key)!.label}）的 brief：这次改动在行为上的变化`);
    }
  }
}

/** settings → agents.design: whether delegations write a design first, and who confirms an own one. */
export const designSettings = (app: App) => app.config.agents.design ?? { mode: "auto" as const, confirm: "owner" as const };

const NEXT_STATUS: Record<DesignOrigin, DesignStatus> = { own: "review", external: "assessed", derived: "recorded" };

/**
 * Hand in a version: checked by origin, ids made stable, the version kept, the status moved on
 * (own → review, external → assessed, derived → recorded). Reassessing someone else's design, every
 * concern of the previous version must come back with its state now.
 */
export function submitRevision(app: App, id: string, input: unknown, opts: { runId?: string | null; note?: string } = {}): Design {
  return tx(app.db, () => {
    const d = getDesign(app, id);
    const { body, problems } = normalize(app, d, input);
    check(d, body, problems);
    if (d.origin === "external" && d.revision > 0) {
      const now_ = new Set(allConcerns(body).map((c) => c.id));
      const missing = allConcerns(d.body).filter((c) => !now_.has(c.id));
      if (missing.length) problems.push(`重新评估要给出上一版每条意见现在的状态（resolved / dropped / 仍是 open，写 note），缺了：${missing.map((c) => `${c.id}「${c.text.slice(0, 30)}」`).join("、")}`);
    }
    if (problems.length) throw new HttpError(400, `这一版没有收下：\n- ${problems.join("\n- ")}`);
    const revision = d.revision + 1;
    const at = now();
    run(app.db, "insert into design_revisions(design_id,revision,body,run_id,note,at) values(?,?,?,?,?,?)", id, revision, JSON.stringify(body), opts.runId ?? null, opts.note?.trim() ?? "", at);
    run(app.db, "update designs set body = ?, revision = ?, status = ?, run_id = ?, updated_at = ? where id = ?", JSON.stringify(body), revision, NEXT_STATUS[d.origin], opts.runId ?? null, at, id);
    return getDesign(app, id);
  });
}

/** In a transaction of its own, or in the caller's. */
const atomic = <T>(app: App, fn: () => T): T => (app.db.isTransaction ? fn() : tx(app.db, fn));

/** Changes to the current version in place (a concern's state, an answer): the version kept for it too. */
function rewriteCurrent(app: App, d: Design, body: DesignBody) {
  const at = now();
  run(app.db, "update designs set body = ?, updated_at = ? where id = ?", JSON.stringify(body), at, d.id);
  if (d.revision > 0) run(app.db, "update design_revisions set body = ? where design_id = ? and revision = ?", JSON.stringify(body), d.id, d.revision);
}

/** What the design is about, not what it decides: its title, documents, repositories, author, item. */
export function updateDesign(app: App, id: string, patch: { title?: string; sources?: string[]; repos?: string[]; author?: string | null; itemId?: string | null }) {
  const d = getDesign(app, id);
  run(app.db, "update designs set title = ?, sources = ?, repos = ?, author = ?, item_id = ?, updated_at = ? where id = ?",
    patch.title?.trim() || d.title, JSON.stringify(patch.sources ?? d.sources), JSON.stringify(patch.repos ?? d.repos),
    patch.author === undefined ? d.author : patch.author?.trim() || null, patch.itemId === undefined ? d.itemId : patch.itemId, now(), id);
  return getDesign(app, id);
}

export function setDesignStatus(app: App, id: string, status: DesignStatus) {
  run(app.db, "update designs set status = ?, updated_at = ? where id = ?", status, now(), id);
}
/** The delegation or branch review (its first run) this design is the baseline of. */
export function setDesignWork(app: App, id: string, workId: string | null) {
  run(app.db, "update designs set work_id = ?, updated_at = ? where id = ?", workId, now(), id);
}

export function setConcernState(app: App, id: string, concernId: string, change: { state: ConcernState; note?: string; by?: string }): Design {
  const d = getDesign(app, id);
  const body = structuredClone(d.body);
  const c = allConcerns(body).find((x) => x.id === concernId);
  if (!c) throw new HttpError(404, `方案 ${id} 没有意见 ${concernId}`);
  c.state = change.state;
  if (change.note?.trim()) c.note = change.note.trim();
  if (change.by) c.by = change.by;
  rewriteCurrent(app, d, body);
  return getDesign(app, id);
}

/**
 * What came of a decision after the code (§2.4): the coder's deviation and simpler way per task, the
 * review lead's done / deviation on a branch. `append`: one decision with several tasks gets each
 * one's words as its own paragraph (`label`, e.g. T3), not the last one only. Written into the current
 * version in place.
 */
export function setDecisionAfter(app: App, id: string, decisionId: string, after: { deviation?: string; simpler?: string; done?: "yes" | "partly" | "no"; by: string; label?: string; append?: boolean }): Design {
  return atomic(app, () => {
    const d = getDesign(app, id);
    const body = structuredClone(d.body);
    const x = body.decisions.find((y) => y.id === decisionId);
    if (!x) throw new HttpError(404, `方案 ${id} 没有决定 ${decisionId}`);
    const prev = x.after ?? {};
    const join = (old: string | undefined, add: string | undefined) => {
      const text = add?.trim();
      if (!text) return old;
      const line = after.label ? `${after.label}：${text}` : text;
      if (!after.append || !old?.trim()) return line;
      // The same task saying it again replaces its own paragraph.
      const kept = after.label ? old.split("\n\n").filter((p) => !p.startsWith(`${after.label}：`)) : old.split("\n\n");
      return [...kept, line].join("\n\n");
    };
    x.after = {
      ...prev,
      ...(after.deviation?.trim() ? { deviation: join(prev.deviation, after.deviation) } : {}),
      ...(after.simpler?.trim() ? { simpler: join(prev.simpler, after.simpler) } : {}),
      ...(after.done ? { done: after.done } : {}),
      by: after.by,
      at: now(),
    };
    rewriteCurrent(app, d, body);
    return getDesign(app, id);
  });
}

/**
 * A branch review's split onto someone else's (or an own) design: which of the branch's files each
 * decision is about, and the files under none. Only where the code landed is written — the design's
 * text is its author's — into the current version, without a new version number.
 */
export function attributeFiles(app: App, id: string, split: { files: Record<string, string[]>; outside: string[] }): Design {
  return atomic(app, () => {
    const d = getDesign(app, id);
    if (!d.revision) throw new HttpError(409, `方案 ${id} 还没有内容，不能归属文件`);
    const body = structuredClone(d.body);
    const unknown = Object.keys(split.files).filter((k) => !body.decisions.some((x) => x.id === k));
    if (unknown.length) throw new HttpError(400, `方案 ${id} 没有决定 ${unknown.join("、")}`);
    for (const x of body.decisions) {
      const files = [...new Set(split.files[x.id] ?? [])];
      if (files.length) x.files = files;
      else delete x.files;
    }
    const outside = [...new Set(split.outside)];
    if (outside.length) body.outside = outside;
    else delete body.outside;
    rewriteCurrent(app, d, body);
    return getDesign(app, id);
  });
}

export function answerQuestion(app: App, id: string, decisionId: string, text: string): Design {
  const d = getDesign(app, id);
  const body = structuredClone(d.body);
  applyAnswers(d.id, body, { [decisionId]: text });
  rewriteCurrent(app, d, body);
  return getDesign(app, id);
}

function applyAnswers(id: string, body: DesignBody, answers: Record<string, string>) {
  for (const [did, text] of Object.entries(answers)) {
    const x = body.decisions.find((y) => y.id === did);
    if (!x) throw new HttpError(404, `方案 ${id} 没有决定 ${did}`);
    if (!x.question) throw new HttpError(400, `${did} 没有要定的问题`);
    if (!text.trim()) throw new HttpError(400, `${did} 的回答是空的`);
    x.question.answer = text.trim();
  }
}

/** What was said about the design since its current version (for the run that writes the next one). */
export function designFeedback(app: App, id: string): DesignFeedback[] {
  const d = getDesign(app, id);
  const v = one<{ feedback: string }>(app.db, "select feedback from designs where id = ?", id)?.feedback;
  return json<DesignFeedback[]>(v ?? "[]", []).filter((f) => f.revision === d.revision);
}

type DecidedListener = (app: App, design: Design, decision: { action: DesignAction; text: string; by: string }) => unknown;
const listeners: DecidedListener[] = [];
/** Called after every decideDesign, in order (a delegation waiting for the design to be confirmed). */
export function onDesignDecided(listener: DecidedListener) {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * The owner on their own design while it waits for them: approve (questions all answered), comment
 * (rewrite with this said), rethink (another approach). Answers to the decisions' questions come
 * along. Comment and rethink put it back to drafting; what was said is kept for the rewrite.
 */
export function decideDesign(app: App, id: string, input: { action: DesignAction; text?: string; answers?: Record<string, string>; by: string }): Design {
  const d = getDesign(app, id);
  if (d.origin !== "own") throw new HttpError(400, "只有自己的方案要确认；别人的方案评估完就是结果，变更说明只用来看");
  if (d.status !== "review") throw new HttpError(409, `方案 ${id} 现在${d.status === "approved" ? "已经通过了" : d.status === "drafting" ? "在写，写好后再确认" : `是 ${d.status}`}`);
  const text = input.text?.trim() ?? "";
  const answers = input.answers ?? {};
  if (input.action === "comment" && !text && !Object.keys(answers).length) throw new HttpError(400, "提意见要写意见（text）");
  const body = structuredClone(d.body);
  applyAnswers(id, body, answers);
  if (input.action === "approve") {
    const open = body.decisions.filter((x) => x.question && !x.question.answer);
    if (open.length) throw new HttpError(400, `还有要定的问题没回答：${open.map((x) => `${x.id}「${x.question!.text.slice(0, 40)}」`).join("、")}；回答（answers）后再通过`);
  }
  tx(app.db, () => {
    rewriteCurrent(app, d, body);
    setDesignStatus(app, id, input.action === "approve" ? "approved" : "drafting");
    const prev = json<DesignFeedback[]>(one<{ feedback: string }>(app.db, "select feedback from designs where id = ?", id)?.feedback ?? "[]", []);
    const entry: DesignFeedback = { revision: d.revision, action: input.action, text, answers, by: input.by, at: now() };
    run(app.db, "update designs set feedback = ? where id = ?", JSON.stringify([...prev, entry].slice(-50)), id);
  });
  const after = getDesign(app, id);
  for (const l of [...listeners]) {
    try {
      const r = l(app, after, { action: input.action, text, by: input.by });
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((e) => console.warn(`[omem] 方案 ${id} 确认后的处理失败：${(e as Error).message}`));
    } catch (e) {
      console.warn(`[omem] 方案 ${id} 确认后的处理失败：${(e as Error).message}`);
    }
  }
  return after;
}
