import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { indexText } from "../search/tokenize.ts";

export type MemoryKind = "fact" | "agreement" | "preference" | "experience" | "person" | "decision";
export type Memory = {
  id: string;
  spaceId: string;
  kind: MemoryKind;
  subject: string;
  content: string;
  status: "active" | "superseded" | "retracted";
  validFrom: string | null;
  validTo: string | null;
  supersededBy: string | null;
  supersedes: string | null;
  sourceRefs: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Backend/model/effort that produced the memory, and the run (quality tracing). */
  agentProfile?: string | null;
  model?: string | null;
  effort?: string | null;
  runId?: string | null;
};
type Row = {
  id: string;
  space_id: string;
  kind: string;
  subject: string;
  content: string;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  supersedes: string | null;
  source_refs: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  agent_profile: string | null;
  model: string | null;
  effort: string | null;
  run_id: string | null;
};
const toMemory = (r: Row): Memory => ({
  id: r.id,
  spaceId: r.space_id,
  kind: r.kind as MemoryKind,
  subject: r.subject,
  content: r.content,
  status: r.status as Memory["status"],
  validFrom: r.valid_from,
  validTo: r.valid_to,
  supersededBy: r.superseded_by,
  supersedes: r.supersedes,
  sourceRefs: json(r.source_refs, []),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  agentProfile: r.agent_profile,
  model: r.model,
  effort: r.effort,
  runId: r.run_id,
});

function index(app: App, id: string, subject: string, content: string) {
  const existing = one<{ rowid: number }>(app.db, "select rowid from memory_rowids where memory_id = ?", id);
  if (existing) run(app.db, "delete from memories_fts where rowid = ?", existing.rowid);
  const rowid = existing?.rowid ?? Number(run(app.db, "insert into memory_rowids(memory_id) values(?)", id).lastInsertRowid);
  run(app.db, "insert into memories_fts(rowid, subject, content) values(?,?,?)", rowid, indexText(subject), indexText(content));
}

/** Rebuild one stored memory's full-text row (merging libraries). */
export function reindexMemory(app: App, id: string) {
  const m = one<{ subject: string; content: string }>(app.db, "select subject, content from memories where id = ?", id);
  if (m) index(app, id, m.subject, m.content);
}

export function getMemory(app: App, id: string): Memory {
  const r = one<Row>(app.db, "select * from memories where id = ?", id);
  if (!r) throw new HttpError(404, `记忆不存在：${id}`);
  return toMemory(r);
}

export type RememberInput = {
  spaceId: string;
  kind: MemoryKind;
  subject?: string;
  content: string;
  sourceRefs?: string[];
  validFrom?: string | null;
  createdBy?: "agent" | "user";
  /** Set for memories about or for one person (their preferences); null = shared knowledge of the space. */
  userId?: string | null;
  agentProfile?: string | null;
  model?: string | null;
  effort?: string | null;
  runId?: string | null;
};

export function remember(app: App, input: RememberInput): Memory {
  const id = newId("m");
  const at = now();
  tx(app.db, () => {
    run(
      app.db,
      "insert into memories(id,space_id,kind,subject,content,status,valid_from,source_refs,created_by,created_at,updated_at,user_id,agent_profile,model,effort,run_id) values(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?)",
      id,
      input.spaceId,
      input.kind,
      input.subject ?? "",
      input.content,
      input.validFrom ?? at,
      JSON.stringify(input.sourceRefs ?? []),
      input.createdBy ?? "agent",
      at,
      at,
      input.userId ?? null,
      input.agentProfile ?? null,
      input.model ?? null,
      input.effort ?? null,
      input.runId ?? null,
    );
    index(app, id, input.subject ?? "", input.content);
  });
  app.emit({ type: "changed", entity: "memory", id, spaceId: input.spaceId });
  return getMemory(app, id);
}

/**
 * A correction never overwrites: the old memory stays readable, marked
 * superseded and linked to its replacement, so "what did we agree before"
 * and "what holds now" are both answerable.
 */
export function supersede(app: App, oldId: string, input: Omit<RememberInput, "spaceId" | "kind"> & { kind?: MemoryKind; reason?: string }): Memory {
  const old = getMemory(app, oldId);
  if (old.status !== "active") throw new HttpError(409, `记忆 ${oldId} 已不是当前有效状态（${old.status}），请先读取最新版本：${old.supersededBy ?? ""}`);
  const id = newId("m");
  const at = now();
  tx(app.db, () => {
    run(
      app.db,
      "insert into memories(id,space_id,kind,subject,content,status,valid_from,supersedes,source_refs,created_by,created_at,updated_at,agent_profile,model,effort,run_id) values(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?)",
      id,
      old.spaceId,
      input.kind ?? old.kind,
      input.subject ?? old.subject,
      input.content,
      input.validFrom ?? at,
      oldId,
      JSON.stringify(input.sourceRefs ?? []),
      input.createdBy ?? "agent",
      at,
      at,
      input.agentProfile ?? null,
      input.model ?? null,
      input.effort ?? null,
      input.runId ?? null,
    );
    // A correction keeps whose memory it was.
    run(app.db, "update memories set user_id = (select user_id from memories where id = ?) where id = ?", oldId, id);
    run(app.db, "update memories set status='superseded', valid_to=?, superseded_by=?, updated_at=? where id=?", input.validFrom ?? at, id, at, oldId);
    index(app, id, input.subject ?? old.subject, input.content);
  });
  app.emit({ type: "changed", entity: "memory", id, spaceId: old.spaceId });
  return getMemory(app, id);
}

export function retract(app: App, id: string, reason = "") {
  const m = getMemory(app, id);
  run(app.db, "update memories set status='retracted', valid_to=?, updated_at=?, content = content || ? where id=?", now(), now(), reason ? `\n（撤回原因：${reason}）` : "", id);
  app.emit({ type: "changed", entity: "memory", id, spaceId: m.spaceId });
  return getMemory(app, id);
}

export function updateMemoryText(app: App, id: string, patch: { content?: string; subject?: string; kind?: MemoryKind }) {
  const m = getMemory(app, id);
  run(app.db, "update memories set content=?, subject=?, kind=?, updated_at=?, created_by='user' where id=?", patch.content ?? m.content, patch.subject ?? m.subject, patch.kind ?? m.kind, now(), id);
  index(app, id, patch.subject ?? m.subject, patch.content ?? m.content);
  app.emit({ type: "changed", entity: "memory", id, spaceId: m.spaceId });
  return getMemory(app, id);
}

export function listMemories(app: App, opts: { spaceId?: string; status?: string; kind?: string; subject?: string; limit?: number }) {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.spaceId) where.push("space_id = ?"), params.push(opts.spaceId);
  if (opts.status && opts.status !== "all") where.push("status = ?"), params.push(opts.status);
  if (opts.kind) where.push("kind = ?"), params.push(opts.kind);
  if (opts.subject) where.push("subject like ?"), params.push(`%${opts.subject}%`);
  return all<Row>(app.db, `select * from memories ${where.length ? "where " + where.join(" and ") : ""} order by updated_at desc limit ?`, ...params, opts.limit ?? 200).map(toMemory);
}

/** The full chain of versions that a memory belongs to, oldest first. */
export function memoryHistory(app: App, id: string): Memory[] {
  let first = getMemory(app, id);
  const guard = new Set<string>();
  while (first.supersedes && !guard.has(first.supersedes)) {
    guard.add(first.id);
    first = getMemory(app, first.supersedes);
  }
  const chain = [first];
  while (chain[chain.length - 1].supersededBy) chain.push(getMemory(app, chain[chain.length - 1].supersededBy!));
  return chain;
}

export function memorySubjects(app: App, spaceId?: string) {
  return all<{ subject: string; n: number }>(
    app.db,
    `select subject, count(*) n from memories where status = 'active' ${spaceId ? "and space_id = ?" : ""} and subject != '' group by subject order by n desc limit 200`,
    ...(spaceId ? [spaceId] : []),
  );
}
