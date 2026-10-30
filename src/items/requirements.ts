import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { getSpace } from "../core/spaces.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { indexText } from "../search/tokenize.ts";

/**
 * Requirement trees (docs/v2/requirements.md): what a business space is supposed to do, kept for good
 * and searchable, so a delegation codes against it, a review checks against it and a later question
 * ("why does refund work this way?") finds it with its history.
 *
 * - One tree per space: system → module → page → feature; test points under a feature (or under
 *   another test point). Not every level is needed; a feature can sit right under a system.
 * - A node keeps its id for life. Every change is a version: `correct` (it was written wrong; no
 *   business meaning) or `change` (the business changed; the reason and where it was decided are
 *   kept for later decisions). Deleting is either too (`delete` a wrong node, `remove` a feature the
 *   business dropped).
 * - Links between nodes, across spaces too: a requirement that spans businesses points at the other
 *   side instead of being copied.
 * - What an Agent writes waits for the owner's confirmation (`confirmed`); briefs say so.
 * - Requirement nodes are in search (reqs_fts); test points are not.
 * - A delegation or review that maps its change points to nodes records each node's state per round
 *   (req_status), which the tree and the item show.
 */

export const REQ_KINDS = ["system", "module", "page", "feature", "test"] as const;
export type ReqKind = (typeof REQ_KINDS)[number];
export const REQ_KIND_LABEL: Record<ReqKind, string> = { system: "系统", module: "模块", page: "页面", feature: "功能", test: "测试点" };
export type ReqChange = "create" | "correct" | "change" | "delete" | "remove" | "confirm" | "restore";
export const REQ_CHANGE_LABEL: Record<ReqChange, string> = { create: "新建", correct: "更正", change: "业务变更", delete: "删除（写错了）", remove: "移除（业务不要了）", confirm: "本人确认", restore: "恢复" };
export type ReqTest = { file?: string; name?: string };
export type ReqNode = {
  id: string;
  spaceId: string;
  parentId: string | null;
  kind: ReqKind;
  seq: number;
  title: string;
  body: string;
  acceptance: string;
  refs: string[];
  tests: ReqTest[];
  confirmed: boolean;
  status: "active" | "deleted" | "removed";
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type ReqVersion = { id: string; nodeId: string; version: number; change: ReqChange; title: string; body: string; acceptance: string; refs: string[]; tests: ReqTest[]; parentId: string | null; reason: string; sourceRefs: string[]; by: string; runId: string | null; at: string };
export type ReqLink = { id: string; fromId: string; toId: string; kind: string; note: string; createdAt: string };
export type ReqStatus = { nodeId: string; runId: string; round: number; status: string; locations: { file: string; start?: number; end?: number }[]; note: string; at: string };

type NodeRow = { id: string; space_id: string; parent_id: string | null; kind: string; seq: number; title: string; body: string; acceptance: string; refs: string; tests: string; confirmed: number; status: string; version: number; created_by: string; created_at: string; updated_at: string };
const toNode = (r: NodeRow): ReqNode => ({
  id: r.id, spaceId: r.space_id, parentId: r.parent_id, kind: r.kind as ReqKind, seq: r.seq, title: r.title, body: r.body, acceptance: r.acceptance,
  refs: json(r.refs, []), tests: json(r.tests, []), confirmed: !!r.confirmed, status: r.status as ReqNode["status"], version: r.version,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
type VersionRow = { id: string; node_id: string; version: number; change: string; title: string; body: string; acceptance: string; refs: string; tests: string; parent_id: string | null; reason: string; source_refs: string; by: string; run_id: string | null; at: string };
const toVersion = (r: VersionRow): ReqVersion => ({
  id: r.id, nodeId: r.node_id, version: r.version, change: r.change as ReqChange, title: r.title, body: r.body, acceptance: r.acceptance, refs: json(r.refs, []),
  tests: json(r.tests, []), parentId: r.parent_id, reason: r.reason, sourceRefs: json(r.source_refs, []), by: r.by, runId: r.run_id, at: r.at,
});

export function findReq(app: App, id: string): ReqNode | null {
  const r = one<NodeRow>(app.db, "select * from req_nodes where id = ?", id.replace(/^req:/, ""));
  return r ? toNode(r) : null;
}
export function getReq(app: App, id: string): ReqNode {
  const n = findReq(app, id);
  if (!n) throw new HttpError(404, `需求点不存在：${id}`);
  return n;
}

/** The node's ancestors from the root, then the node. */
export function reqPath(app: App, node: ReqNode): ReqNode[] {
  const path = [node];
  let at = node.parentId;
  for (let i = 0; at && i < 20; i++) {
    const p = findReq(app, at);
    if (!p) break;
    path.unshift(p);
    at = p.parentId;
  }
  return path;
}
export const pathText = (path: ReqNode[]) => path.map((n) => n.title).join(" / ");

/** A space's tree (or the part below `under`), in order, as a flat list with depth. */
export function reqTree(app: App, spaceId: string, opts: { under?: string; depth?: number; tests?: boolean; removed?: boolean } = {}) {
  const rows = all<NodeRow>(app.db, `select * from req_nodes where space_id = ? ${opts.removed ? "" : "and status = 'active'"} order by seq, created_at`, spaceId).map(toNode);
  const children = new Map<string | null, ReqNode[]>();
  for (const n of rows) {
    if (n.kind === "test" && opts.tests === false) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const out: (ReqNode & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    if (opts.depth !== undefined && depth >= opts.depth) return;
    for (const n of children.get(parent) ?? []) {
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  if (opts.under) {
    const root = getReq(app, opts.under);
    out.push({ ...root, depth: 0 });
    walk(root.id, 1);
  } else walk(null, 0);
  return out;
}

export function reqVersions(app: App, id: string) {
  return all<VersionRow>(app.db, "select * from req_versions where node_id = ? order by version, at", id).map(toVersion);
}
export function reqLinks(app: App, id: string) {
  const rows = all<{ id: string; from_id: string; to_id: string; kind: string; note: string; created_at: string }>(app.db, "select * from req_links where from_id = ? or to_id = ? order by created_at", id, id);
  return rows.map((r) => ({ id: r.id, fromId: r.from_id, toId: r.to_id, kind: r.kind, note: r.note, createdAt: r.created_at }) as ReqLink);
}
export function reqStatuses(app: App, ids: string[]): Map<string, ReqStatus> {
  const out = new Map<string, ReqStatus>();
  if (!ids.length) return out;
  const rows = all<{ node_id: string; run_id: string; round: number; status: string; locations: string; note: string; at: string }>(
    app.db, `select * from req_status where node_id in (${ids.map(() => "?").join(",")}) order by at`, ...ids,
  );
  for (const r of rows) out.set(r.node_id, { nodeId: r.node_id, runId: r.run_id, round: r.round, status: r.status, locations: json(r.locations, []), note: r.note, at: r.at });
  return out;
}

/** Everything the node page shows: the path, children, history, links (with the other side), latest state. */
export function reqDetail(app: App, id: string) {
  const node = getReq(app, id);
  const children = all<NodeRow>(app.db, "select * from req_nodes where parent_id = ? and status = 'active' order by seq, created_at", node.id).map(toNode);
  const links = reqLinks(app, node.id).map((l) => {
    const other = findReq(app, l.fromId === node.id ? l.toId : l.fromId);
    return { ...l, direction: l.fromId === node.id ? "out" : "in", other: other ? { id: other.id, spaceId: other.spaceId, kind: other.kind, title: pathText(reqPath(app, other)), status: other.status } : null };
  });
  return { node, path: reqPath(app, node).map((n) => ({ id: n.id, kind: n.kind, title: n.title })), children, versions: reqVersions(app, node.id), links, state: reqStatuses(app, [node.id]).get(node.id) ?? null };
}

// ---- search -------------------------------------------------------------------------------------

function indexReq(app: App, node: ReqNode) {
  const existing = one<{ rowid: number }>(app.db, "select rowid from req_rowids where node_id = ?", node.id);
  if (existing) run(app.db, "delete from reqs_fts where rowid = ?", existing.rowid);
  if (node.status !== "active" || node.kind === "test") {
    if (existing) run(app.db, "delete from req_rowids where rowid = ?", existing.rowid);
    return;
  }
  const rowid = existing?.rowid ?? Number(run(app.db, "insert into req_rowids(node_id) values(?)", node.id).lastInsertRowid);
  run(app.db, "insert into reqs_fts(rowid, title, body) values(?,?,?)", rowid, indexText(pathText(reqPath(app, node))), indexText(`${node.body}\n${node.acceptance}`));
}
/** Rebuild one node's search row (after a pull, or when an ancestor was renamed). */
export function reindexReq(app: App, id: string) {
  const n = findReq(app, id);
  if (n) indexReq(app, n);
}

// ---- writes -------------------------------------------------------------------------------------

export type ReqFields = { title?: string; body?: string; acceptance?: string; refs?: string[]; tests?: ReqTest[]; kind?: ReqKind };
export type ReqOp =
  | ({ op: "add"; key?: string; parent?: string; space?: string; after?: string; title: string } & ReqFields)
  | ({ op: "edit"; id: string; change: "correct" | "change"; reason?: string; source_refs?: string[]; parent?: string | null } & ReqFields)
  | { op: "delete"; id: string; change: "correct" | "change"; reason?: string; source_refs?: string[] }
  | { op: "restore"; id: string; reason?: string }
  | { op: "confirm"; id: string }
  | { op: "link"; id: string; to: string; kind?: string; note?: string }
  | { op: "unlink"; id: string; to: string };
const fieldsSchema = {
  title: z.string().max(200).optional(),
  body: z.string().max(8000).optional(),
  acceptance: z.string().max(4000).optional(),
  refs: z.array(z.string().max(300)).max(30).optional(),
  tests: z.array(z.object({ file: z.string().max(300).optional(), name: z.string().max(300).optional() })).max(20).optional(),
  kind: z.enum(REQ_KINDS).optional(),
};
/** The operations the HTTP API takes (the page sends these; tools build theirs from their own schema). */
export const reqOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), key: z.string().max(40).optional(), parent: z.string().optional(), space: z.string().optional(), after: z.string().optional(), ...fieldsSchema, title: z.string().min(1).max(200) }),
  z.object({ op: z.literal("edit"), id: z.string(), change: z.enum(["correct", "change"]), reason: z.string().max(1000).optional(), source_refs: z.array(z.string().max(300)).max(20).optional(), parent: z.string().nullable().optional(), ...fieldsSchema }),
  z.object({ op: z.literal("delete"), id: z.string(), change: z.enum(["correct", "change"]), reason: z.string().max(1000).optional(), source_refs: z.array(z.string().max(300)).max(20).optional() }),
  z.object({ op: z.literal("restore"), id: z.string(), reason: z.string().max(1000).optional() }),
  z.object({ op: z.literal("confirm"), id: z.string() }),
  z.object({ op: z.literal("link"), id: z.string(), to: z.string(), kind: z.string().max(20).optional(), note: z.string().max(500).optional() }),
  z.object({ op: z.literal("unlink"), id: z.string(), to: z.string() }),
]);
export type ReqWriter = { by: "user" | "agent"; label?: string; runId?: string | null };

const PARENTS: Record<ReqKind, (ReqKind | null)[]> = {
  system: [null],
  module: [null, "system", "module"],
  page: [null, "system", "module"],
  feature: [null, "system", "module", "page", "feature"],
  test: ["feature", "test"],
};

function checkParent(kind: ReqKind, parent: ReqNode | null) {
  if (!PARENTS[kind].includes(parent?.kind ?? null))
    throw new HttpError(400, `${REQ_KIND_LABEL[kind]}不能放在${parent ? `${REQ_KIND_LABEL[parent.kind]}「${parent.title}」` : "最上层"}下面（${REQ_KIND_LABEL[kind]}可以在：${PARENTS[kind].map((k) => (k ? REQ_KIND_LABEL[k] : "最上层")).join("、")}）`);
  if (parent && parent.status !== "active") throw new HttpError(400, `上级「${parent.title}」已删除或移除`);
}

function snapshot(app: App, node: ReqNode, change: ReqChange, w: ReqWriter, extra: { reason?: string; sourceRefs?: string[] } = {}) {
  run(app.db, `insert into req_versions(id, node_id, version, change, title, body, acceptance, refs, tests, parent_id, reason, source_refs, by, run_id, at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("qv"), node.id, node.version, change, node.title, node.body, node.acceptance, JSON.stringify(node.refs), JSON.stringify(node.tests), node.parentId,
    extra.reason?.trim() ?? "", JSON.stringify(extra.sourceRefs ?? []), w.label ?? w.by, w.runId ?? null, now());
}

function writeNode(app: App, n: ReqNode) {
  run(app.db, `update req_nodes set parent_id=?, kind=?, seq=?, title=?, body=?, acceptance=?, refs=?, tests=?, confirmed=?, status=?, version=?, updated_at=? where id=?`,
    n.parentId, n.kind, n.seq, n.title, n.body, n.acceptance, JSON.stringify(n.refs), JSON.stringify(n.tests), n.confirmed ? 1 : 0, n.status, n.version, n.updatedAt, n.id);
}

const clean = (s: string | undefined, max: number) => (s ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const cleanRefs = (refs: string[] | undefined) => [...new Set((refs ?? []).map((r) => r.trim()).filter(Boolean))].slice(0, 30);
const cleanTests = (tests: ReqTest[] | undefined) => (tests ?? []).map((t) => ({ ...(t.file?.trim() ? { file: t.file.trim().slice(0, 300) } : {}), ...(t.name?.trim() ? { name: t.name.trim().slice(0, 300) } : {}) })).filter((t) => t.file || t.name).slice(0, 20);

function descendants(app: App, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const kids = all<{ id: string }>(app.db, "select id from req_nodes where parent_id = ?", queue.shift()!).map((r) => r.id);
    out.push(...kids);
    queue.push(...kids);
  }
  return out;
}

/**
 * Apply a batch of operations in one transaction. `add` can name a `key` that later ops in the batch
 * use as `parent` / `id` (`$key`). `canWrite` / `canRead` are the caller's space checks (tools and the
 * HTTP API pass the user's). Returns the ids touched, in order, with what happened.
 */
export function saveReqs(app: App, ops: ReqOp[], w: ReqWriter, check: { canWrite: (spaceId: string) => void; canRead: (spaceId: string) => void; defaultSpace: string }) {
  if (!ops.length) throw new HttpError(400, "没有要做的修改");
  if (ops.length > 200) throw new HttpError(400, "一次最多 200 项修改");
  const keys = new Map<string, string>();
  const ref = (id: string) => (id.startsWith("$") ? (keys.get(id.slice(1)) ?? id) : id.replace(/^req:/, ""));
  const done: { id: string; what: string }[] = [];
  const touched = new Set<string>();
  const confirmed = w.by === "user";
  tx(app.db, () => {
    for (const op of ops) {
      if (op.op === "add") {
        const parent = op.parent ? getReq(app, ref(op.parent)) : null;
        const spaceId = parent?.spaceId ?? getSpace(app, op.space ?? check.defaultSpace).id;
        if (op.space && parent && getSpace(app, op.space).id !== parent.spaceId) throw new HttpError(400, `上级「${parent.title}」在空间 ${parent.spaceId}，不能在 ${op.space} 里建它的下级；跨业务的关系用 link`);
        check.canWrite(spaceId);
        const kind = op.kind ?? (parent?.kind === "test" || parent?.kind === "feature" ? "test" : "feature");
        checkParent(kind, parent);
        const title = clean(op.title, 200);
        if (!title) throw new HttpError(400, "需求点要有标题");
        const siblings = all<{ id: string; seq: number }>(app.db, `select id, seq from req_nodes where space_id = ? and parent_id ${parent ? "= ?" : "is null"} order by seq`, ...(parent ? [spaceId, parent.id] : [spaceId]));
        let seq = (siblings.at(-1)?.seq ?? 0) + 10;
        if (op.after) {
          const at = siblings.findIndex((s) => s.id === ref(op.after!));
          if (at < 0) throw new HttpError(400, `${op.after} 不是同一层的需求点`);
          seq = siblings[at].seq + 1;
          for (const s of siblings.slice(at + 1)) run(app.db, "update req_nodes set seq = seq + 10 where id = ?", s.id);
        }
        const t = now();
        const node: ReqNode = { id: newId("q"), spaceId, parentId: parent?.id ?? null, kind, seq, title, body: clean(op.body, 8000), acceptance: clean(op.acceptance, 4000), refs: cleanRefs(op.refs), tests: kind === "test" ? cleanTests(op.tests) : [], confirmed, status: "active", version: 1, createdBy: w.label ?? w.by, createdAt: t, updatedAt: t };
        run(app.db, `insert into req_nodes(id, space_id, parent_id, kind, seq, title, body, acceptance, refs, tests, confirmed, status, version, created_by, created_at, updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          node.id, node.spaceId, node.parentId, node.kind, node.seq, node.title, node.body, node.acceptance, JSON.stringify(node.refs), JSON.stringify(node.tests), confirmed ? 1 : 0, "active", 1, node.createdBy, t, t);
        snapshot(app, node, "create", w);
        if (op.key) keys.set(op.key, node.id);
        touched.add(node.id);
        done.push({ id: node.id, what: `新建${REQ_KIND_LABEL[kind]}「${title}」` });
        continue;
      }
      const node = getReq(app, ref(op.id));
      check.canWrite(node.spaceId);
      if (op.op === "edit") {
        if (op.change === "change" && !op.reason?.trim()) throw new HttpError(400, `「${node.title}」是业务变更：写清为什么变（reason），能找到依据就带上 source_refs`);
        if (node.status !== "active") throw new HttpError(400, `「${node.title}」已删除或移除，先 restore`);
        const next = { ...node };
        if (op.title !== undefined) next.title = clean(op.title, 200) || node.title;
        if (op.body !== undefined) next.body = clean(op.body, 8000);
        if (op.acceptance !== undefined) next.acceptance = clean(op.acceptance, 4000);
        if (op.refs !== undefined) next.refs = cleanRefs(op.refs);
        if (op.tests !== undefined) next.tests = cleanTests(op.tests);
        if (op.kind !== undefined) next.kind = op.kind;
        if (op.parent !== undefined) {
          const parent = op.parent ? getReq(app, ref(op.parent)) : null;
          if (parent && parent.spaceId !== node.spaceId) throw new HttpError(400, "不能挪到别的空间下面；跨业务的关系用 link");
          if (parent && (parent.id === node.id || descendants(app, node.id).includes(parent.id))) throw new HttpError(400, "不能挪到自己下面");
          next.parentId = parent?.id ?? null;
          if (next.parentId !== node.parentId) next.seq = (one<{ m: number | null }>(app.db, `select max(seq) m from req_nodes where space_id = ? and parent_id ${parent ? "= ?" : "is null"}`, ...(parent ? [node.spaceId, parent.id] : [node.spaceId]))?.m ?? 0) + 10;
        }
        checkParent(next.kind, next.parentId ? getReq(app, next.parentId) : null);
        if (next.kind !== "test") next.tests = [];
        next.version = node.version + 1;
        next.confirmed = confirmed;
        next.updatedAt = now();
        writeNode(app, next);
        snapshot(app, next, op.change, w, { reason: op.reason, sourceRefs: cleanRefs(op.source_refs) });
        touched.add(next.id);
        for (const d of descendants(app, next.id)) touched.add(d);
        done.push({ id: next.id, what: `${REQ_CHANGE_LABEL[op.change]}「${next.title}」` });
      } else if (op.op === "delete") {
        if (op.change === "change" && !op.reason?.trim()) throw new HttpError(400, `移除「${node.title}」是业务变更：写清为什么不要了（reason）`);
        const status = op.change === "change" ? "removed" : "deleted";
        for (const id of [node.id, ...descendants(app, node.id)]) {
          const n = getReq(app, id);
          if (n.status !== "active") continue;
          const next = { ...n, status: status as ReqNode["status"], version: n.version + 1, updatedAt: now() } satisfies ReqNode;
          writeNode(app, next);
          snapshot(app, next, op.change === "change" ? "remove" : "delete", w, { reason: id === node.id ? op.reason : `随上级「${node.title}」一起`, sourceRefs: id === node.id ? cleanRefs(op.source_refs) : [] });
          touched.add(id);
        }
        done.push({ id: node.id, what: `${op.change === "change" ? "移除" : "删除"}「${node.title}」及其下级` });
      } else if (op.op === "restore") {
        if (node.status === "active") continue;
        const parent = node.parentId ? getReq(app, node.parentId) : null;
        if (parent && parent.status !== "active") throw new HttpError(400, `先恢复上级「${parent.title}」`);
        const next = { ...node, status: "active" as const, version: node.version + 1, confirmed, updatedAt: now() };
        writeNode(app, next);
        snapshot(app, next, "restore", w, { reason: op.reason });
        touched.add(node.id);
        done.push({ id: node.id, what: `恢复「${node.title}」` });
      } else if (op.op === "confirm") {
        if (w.by !== "user") throw new HttpError(403, "需求点只能由本人确认");
        for (const id of [node.id, ...descendants(app, node.id)]) {
          const n = getReq(app, id);
          if (n.confirmed || n.status !== "active") continue;
          writeNode(app, { ...n, confirmed: true, updatedAt: now() });
          snapshot(app, { ...n, confirmed: true }, "confirm", w);
        }
        done.push({ id: node.id, what: `确认「${node.title}」及其下级` });
      } else if (op.op === "link" || op.op === "unlink") {
        const to = getReq(app, ref(op.to));
        check.canRead(to.spaceId);
        if (to.id === node.id) throw new HttpError(400, "不能关联自己");
        if (op.op === "link") {
          run(app.db, "insert into req_links(id, from_id, to_id, kind, note, created_at) values(?,?,?,?,?,?) on conflict(from_id, to_id) do update set kind = excluded.kind, note = excluded.note",
            newId("ql"), node.id, to.id, clean(op.kind, 20) || "relates", clean(op.note, 500), now());
          done.push({ id: node.id, what: `关联「${node.title}」→「${to.title}」${to.spaceId !== node.spaceId ? `（空间 ${to.spaceId}）` : ""}` });
        } else {
          run(app.db, "delete from req_links where (from_id = ? and to_id = ?) or (from_id = ? and to_id = ?)", node.id, to.id, to.id, node.id);
          done.push({ id: node.id, what: `取消关联「${node.title}」和「${to.title}」` });
        }
      }
    }
    for (const id of touched) reindexReq(app, id);
  });
  for (const id of new Set(done.map((d) => d.id))) {
    const n = findReq(app, id);
    if (n) app.emit({ type: "changed", entity: "requirement", id, spaceId: n.spaceId });
  }
  return { done, keys: Object.fromEntries(keys) };
}

/** A round's change points mapped to nodes (`req`): each node's state for that round. */
export function recordReqStatus(app: App, runId: string, round: number, points: { req?: string; status: string; locations?: { file: string; start?: number; end?: number }[]; implementation?: string }[]) {
  for (const p of points) {
    if (!p.req) continue;
    const node = findReq(app, p.req);
    if (!node) continue;
    run(app.db, `insert into req_status(id, node_id, run_id, round, status, locations, note, at) values(?,?,?,?,?,?,?,?)
      on conflict(node_id, run_id, round) do update set status = excluded.status, locations = excluded.locations, note = excluded.note, at = excluded.at`,
      newId("qs"), node.id, runId, round, p.status, JSON.stringify(p.locations ?? []), truncate(p.implementation ?? "", 500), now());
  }
}

// ---- briefs -------------------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = { done: "已实现", partial: "部分实现", missing: "没实现", extra: "需求外" };

/**
 * The nodes an item scopes (each with everything under it, and the path above it), as a section of a
 * delegation's or review's task: what to build and check, the test points, what is not confirmed yet,
 * business changes since a time, and the other side of cross-business links.
 */
export function reqBrief(app: App, ids: string[], opts: { since?: string } = {}) {
  const roots = ids.map((id) => findReq(app, id)).filter((n): n is ReqNode => !!n && n.status === "active");
  if (!roots.length) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  const changed: string[] = [];
  const crossLinks: string[] = [];
  const states = reqStatuses(app, roots.flatMap((r) => [r.id, ...descendants(app, r.id)]));
  for (const root of roots) {
    const above = reqPath(app, root).slice(0, -1);
    if (above.length) lines.push(`${pathText(above)} /`);
    for (const n of reqTree(app, root.spaceId, { under: root.id })) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const pad = "  ".repeat(n.depth);
      const state = states.get(n.id);
      const tags = [!n.confirmed ? "待本人确认" : "", state ? `上一次评审：${STATUS_LABEL[state.status] ?? state.status}` : ""].filter(Boolean).join("，");
      lines.push(`${pad}- [${REQ_KIND_LABEL[n.kind]} ${n.id}] ${n.title}${tags ? `（${tags}）` : ""}`);
      if (n.body) lines.push(n.body.split("\n").map((l) => `${pad}  ${l}`).join("\n"));
      if (n.acceptance) lines.push(`${pad}  验收：${n.acceptance.replace(/\n/g, `\n${pad}  `)}`);
      if (n.refs.length) lines.push(`${pad}  依据：${n.refs.join(" ")}`);
      if (n.tests.length) lines.push(`${pad}  对应测试：${n.tests.map((t) => [t.file, t.name].filter(Boolean).join(" › ")).join("；")}`);
      if (opts.since) {
        const recent = all<VersionRow>(app.db, "select * from req_versions where node_id = ? and change in ('change','remove') and at > ? order by version", n.id, opts.since).map(toVersion);
        for (const v of recent) changed.push(`- ${n.id}「${n.title}」${v.at.slice(0, 10)}：${v.reason}${v.sourceRefs.length ? `（${v.sourceRefs.join(" ")}）` : ""}`);
      }
      for (const l of reqLinks(app, n.id)) {
        const other = findReq(app, l.fromId === n.id ? l.toId : l.fromId);
        if (other && other.spaceId !== n.spaceId && other.status === "active") crossLinks.push(`- ${n.id}「${n.title}」${l.fromId === n.id ? "→" : "←"} 空间 ${other.spaceId} 的 ${other.id}「${pathText(reqPath(app, other))}」${l.note ? `：${l.note}` : ""}`);
      }
    }
  }
  return [
    "## 需求点（需求树里这个事项圈定的部分）",
    "编号是需求点的固定 id。按点实现和检查；“待本人确认”的是 Agent 拆出来、本人还没确认的，有疑问照实说明。测试点要有对应的测试。",
    lines.join("\n"),
    changed.length ? `### 业务变更（上一轮之后）\n\n${changed.join("\n")}` : "",
    crossLinks.length ? `### 关联的其他业务（用 req_read 看对方）\n\n${[...new Set(crossLinks)].join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
