import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { commitLibrary } from "./git.ts";
import { HttpError, json, now, slugify } from "./util.ts";

/**
 * `worktree` spaces are temporary: the files a delegated coding run changed, indexed while its
 * worktree exists (src/agents/worktree-index.ts). They are left out of listings, jobs and sync.
 */
export type SpaceKind = "personal" | "project" | "repo" | "learning" | "topic" | "worktree";
/** How kinds read to people and agents. `topic` is the general-purpose kind. */
export const SPACE_KIND_LABELS: Record<SpaceKind, string> = { personal: "个人", project: "项目", repo: "代码仓库", learning: "学习", topic: "通用", worktree: "交办工作区" };
export const kindLabel = (k: string) => SPACE_KIND_LABELS[k as SpaceKind] ?? k;
export type Space = {
  id: string;
  name: string;
  kind: SpaceKind;
  description: string;
  rootPath: string | null;
  /** The business space a repository belongs to (searched, delegated and reviewed as part of it); null for the others. */
  parentId: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type Row = { id: string; name: string; kind: string; description: string; root_path: string | null; parent_id: string | null; settings: string; created_at: string; updated_at: string };
const toSpace = (r: Row): Space => ({
  id: r.id,
  name: r.name,
  kind: r.kind as SpaceKind,
  description: r.description,
  rootPath: r.root_path,
  parentId: r.parent_id ?? null,
  settings: json(r.settings, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function spaceDir(app: App, id: string) {
  return join(app.libraryDir, id);
}

/** Spaces in order; temporary worktree spaces only when asked for. */
export function listSpaces(app: App, opts: { worktrees?: boolean } = {}): Space[] {
  return all<Row>(app.db, `select * from spaces ${opts.worktrees ? "" : "where kind != 'worktree'"} order by kind = 'personal' desc, updated_at desc`).map(toSpace);
}

export function getSpace(app: App, id: string): Space {
  const r = one<Row>(app.db, "select * from spaces where id = ?", id);
  if (!r) throw new HttpError(404, `空间不存在：${id}`);
  return toSpace(r);
}

export function findSpace(app: App, id: string): Space | null {
  const r = one<Row>(app.db, "select * from spaces where id = ?", id);
  return r ? toSpace(r) : null;
}

const SPACE_GUIDE = (name: string, kind: SpaceKind, description: string) => `# ${name}

${description || "（在这里写这个空间的范围、用户和整理要求，Agent 每次工作前都会读它。）"}

- 类型：${kindLabel(kind)}
- 用户：
- 范围：
- 写作要求：
`;

export function createSpace(
  app: App,
  input: { id?: string; name: string; kind?: SpaceKind; description?: string; rootPath?: string | null; parentId?: string | null },
): Space {
  const id = slugify(input.id || input.name);
  if (id.startsWith("_")) throw new HttpError(400, "空间 id 不能以下划线开头（知识库保留给 Agent 档案和技能）");
  if (findSpace(app, id)) throw new HttpError(409, `空间已存在：${id}`);
  const kind = input.kind ?? (input.rootPath ? "repo" : "topic");
  const rootPath = input.rootPath ? resolve(input.rootPath) : null;
  if (rootPath && !existsSync(rootPath)) throw new HttpError(400, `目录不存在：${rootPath}`);
  const at = now();
  run(
    app.db,
    "insert into spaces(id,name,kind,description,root_path,settings,created_at,updated_at) values(?,?,?,?,?,?,?,?)",
    id,
    input.name,
    kind,
    input.description ?? "",
    rootPath,
    "{}",
    at,
    at,
  );
  const dir = spaceDir(app, id);
  mkdirSync(join(dir, "wiki"), { recursive: true });
  if (!existsSync(join(dir, "SPACE.md"))) writeFileSync(join(dir, "SPACE.md"), SPACE_GUIDE(input.name, kind, input.description ?? ""));
  commitLibrary(app.libraryDir, `space: create ${id}`);
  app.emit({ type: "changed", entity: "space", id });
  if (input.parentId) return setSpaceParent(app, id, input.parentId);
  return getSpace(app, id);
}

export function updateSpace(app: App, id: string, patch: Partial<Pick<Space, "name" | "description" | "settings" | "rootPath">>) {
  const s = getSpace(app, id);
  run(
    app.db,
    "update spaces set name=?, description=?, settings=?, root_path=?, updated_at=? where id=?",
    patch.name ?? s.name,
    patch.description ?? s.description,
    JSON.stringify(patch.settings ?? s.settings),
    patch.rootPath === undefined ? s.rootPath : patch.rootPath,
    now(),
    id,
  );
  app.emit({ type: "changed", entity: "space", id });
  return getSpace(app, id);
}

/** The space whose linked directory contains `dir` (the innermost one), if any. */
export function spaceForDir(app: App, dir: string): string | null {
  const norm = (p: string) => {
    const r = resolve(p).replace(/\\/g, "/").replace(/\/$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const here = norm(dir);
  let best: { id: string; len: number } | null = null;
  for (const s of listSpaces(app)) {
    if (!s.rootPath) continue;
    const root = norm(s.rootPath);
    if ((here === root || here.startsWith(root + "/")) && (!best || root.length > best.len)) best = { id: s.id, len: root.length };
  }
  return best?.id ?? null;
}

export function ensurePersonalSpace(app: App) {
  if (!findSpace(app, "personal"))
    createSpace(app, { id: "personal", name: "个人", kind: "personal", description: "个人笔记、约定、聊天与日常事项。" });
}

// ---- relations between spaces --------------------------------------------------

/** `via`: not a relation of its own but the repository's business space (`parent`) or one of its repositories (`child`). */
export type SpaceRelation = { space: string; name: string; kind: SpaceKind; note: string; origin: "owner" | "agent"; status: "active" | "rejected"; evidence: string; updatedAt: string; via?: "parent" | "child" };
type RelRow = { space_a: string; space_b: string; note: string; origin: string; status: string; evidence: string; updated_at: string };
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/**
 * The spaces related to one space (relations have no direction). Rejected ones only on request. A
 * repository's business space and a business space's repositories come first: everything that reads
 * related spaces (a run's reach, the default search, the space guide) treats them as related.
 */
export function relatedSpaces(app: App, id: string, opts: { includeRejected?: boolean } = {}): SpaceRelation[] {
  const self = findSpace(app, id);
  const family: SpaceRelation[] = [];
  const parent = self?.parentId ? findSpace(app, self.parentId) : null;
  if (parent) family.push({ space: parent.id, name: parent.name, kind: parent.kind, note: "它所属的业务空间", origin: "owner", status: "active", evidence: "", updatedAt: self!.updatedAt, via: "parent" });
  for (const c of childSpaces(app, id)) family.push({ space: c.id, name: c.name, kind: c.kind, note: "它的代码仓库", origin: "owner", status: "active", evidence: "", updatedAt: c.updatedAt, via: "child" });
  const rows = all<RelRow>(app.db, `select * from space_relations where (space_a = ? or space_b = ?) ${opts.includeRejected ? "" : "and status = 'active'"} order by updated_at desc`, id, id);
  return [...family, ...rows.flatMap((r) => {
    const other = findSpace(app, r.space_a === id ? r.space_b : r.space_a);
    if (!other || family.some((f) => f.space === other.id)) return [];
    return [{ space: other.id, name: other.name, kind: other.kind, note: r.note, origin: r.origin as SpaceRelation["origin"], status: r.status as SpaceRelation["status"], evidence: r.evidence, updatedAt: r.updated_at }];
  })];
}

// ---- repositories under a business space ---------------------------------------

/** The repositories that belong to a business space. */
export function childSpaces(app: App, id: string): Space[] {
  return all<Row>(app.db, "select * from spaces where parent_id = ? order by name", id).map(toSpace);
}

/** A space with its repositories: what “this business” covers when searching, listing work or granting access. */
export function spaceFamily(app: App, id: string): string[] {
  return [id, ...all<{ id: string }>(app.db, "select id from spaces where parent_id = ? order by name", id).map((r) => r.id)];
}

/** Where a space's work is filed: a repository's business space, else the space itself. */
export const businessOf = (app: App, id: string) => findSpace(app, id)?.parentId ?? id;

/**
 * Put a repository under a business space (`parent`), or take it out (null). Only a space with a
 * repository directory goes under one, never under another repository; the relation the two had is
 * dropped, the parent stands in for it.
 */
export function setSpaceParent(app: App, id: string, parent: string | null) {
  const s = getSpace(app, id);
  if (parent) {
    const p = getSpace(app, parent);
    if (!s.rootPath || s.kind !== "repo") throw new HttpError(400, `${s.name} 不是代码仓库，不能挂到业务空间下`);
    if (p.id === s.id) throw new HttpError(400, "不能挂到自己下面");
    if (p.kind === "repo" || p.kind === "worktree" || p.parentId) throw new HttpError(400, `${p.name} 不是业务空间，仓库只能挂到业务空间下`);
    const [x, y] = pair(s.id, p.id);
    run(app.db, "delete from space_relations where space_a = ? and space_b = ?", x, y);
  }
  run(app.db, "update spaces set parent_id = ?, updated_at = ? where id = ?", parent, now(), id);
  app.emit({ type: "changed", entity: "space", id });
  if (parent) app.emit({ type: "changed", entity: "space", id: parent });
  if (s.parentId && s.parentId !== parent) app.emit({ type: "changed", entity: "space", id: s.parentId });
  return getSpace(app, id);
}

export const relatedIds = (app: App, id: string) => relatedSpaces(app, id).map((r) => r.space);

/**
 * Relate two spaces. The owner can always (re)relate; an agent cannot bring back a relation
 * the owner removed, and does not overwrite the owner's note.
 */
export function relateSpaces(app: App, a: string, b: string, input: { note?: string; origin: "owner" | "agent"; evidence?: string }) {
  if (a === b) throw new HttpError(400, "不能把空间和自己关联");
  getSpace(app, a);
  getSpace(app, b);
  const [x, y] = pair(a, b);
  const old = one<RelRow>(app.db, "select * from space_relations where space_a = ? and space_b = ?", x, y);
  if (old?.status === "rejected" && input.origin === "agent") throw new HttpError(409, `本人移除过 ${a} 与 ${b} 的关联，不再自动加回`);
  // An agent confirming the owner's relation keeps the owner's note and origin.
  const keepOwner = old?.status === "active" && old.origin === "owner" && input.origin === "agent";
  const note = keepOwner ? old.note : input.note?.trim() || old?.note || "";
  const origin = keepOwner ? "owner" : input.origin;
  const at = now();
  run(
    app.db,
    `insert into space_relations(space_a,space_b,note,origin,status,evidence,created_at,updated_at) values(?,?,?,?,'active',?,?,?)
     on conflict(space_a,space_b) do update set note = excluded.note, origin = excluded.origin, status = 'active', evidence = case when excluded.evidence != '' then excluded.evidence else space_relations.evidence end, updated_at = excluded.updated_at`,
    x,
    y,
    note,
    origin,
    input.evidence ?? "",
    at,
    at,
  );
  app.emit({ type: "changed", entity: "space", id: a });
  app.emit({ type: "changed", entity: "space", id: b });
}

/** Remove a relation. The owner's removal is remembered so agents do not suggest it again. */
export function unrelateSpaces(app: App, a: string, b: string, by: "owner" | "agent") {
  const [x, y] = pair(a, b);
  if (by === "owner")
    run(
      app.db,
      `insert into space_relations(space_a,space_b,origin,status,created_at,updated_at) values(?,?,'owner','rejected',?,?)
       on conflict(space_a,space_b) do update set status = 'rejected', updated_at = excluded.updated_at`,
      x,
      y,
      now(),
      now(),
    );
  else run(app.db, "delete from space_relations where space_a = ? and space_b = ? and origin = 'agent'", x, y);
  app.emit({ type: "changed", entity: "space", id: a });
  app.emit({ type: "changed", entity: "space", id: b });
}

/** Rows that say who may see a space or how it relates to others, and bookkeeping: they go with it. */
const SPACE_BOOKKEEPING = new Set(["space_members", "change_log", "metrics", "vector_log", "page_reads", "git_commit_cursors", "pulled_repositories"]);
const CONTENT_LABEL: Record<string, string> = { sources: "原件", chunks: "原件切块", pages: "Wiki 页面", memories: "记忆", items: "事项", runs: "运行", conversations: "对话", rules: "规则", schedules: "定时任务", designs: "方案", req_nodes: "需求", repo_lessons: "仓库约定", plugin_records: "插件记录", symbols: "代码符号", code_refs: "代码引用" };

/** What a space still holds (table → rows), apart from its members and bookkeeping. */
export function spaceContent(app: App, id: string): { table: string; label: string; count: number }[] {
  const tables = all<{ name: string }>(app.db, "select name from sqlite_master where type = 'table'").map((t) => t.name);
  const out: { table: string; label: string; count: number }[] = [];
  for (const t of tables) {
    if (SPACE_BOOKKEEPING.has(t)) continue;
    if (!all<{ name: string }>(app.db, `pragma table_info("${t.replace(/"/g, "")}")`).some((c) => c.name === "space_id")) continue;
    const n = one<{ n: number }>(app.db, `select count(*) n from "${t}" where space_id = ?`, id)?.n ?? 0;
    if (n) out.push({ table: t, label: CONTENT_LABEL[t] ?? t, count: n });
  }
  return out;
}

/**
 * Delete a space that holds nothing (made by mistake, say): its row, members, relations and its
 * folder in the library. One with content, a personal space, a business space with repositories
 * under it or an index of a branch is refused with what is in the way. The repository directory of a
 * repo space is left alone (it is the owner's, or omem's clone under repos/ that may be connected again).
 */
export function deleteSpace(app: App, id: string) {
  const s = getSpace(app, id);
  if (s.kind === "personal") throw new HttpError(400, "个人空间不能删除");
  if (s.kind === "worktree") throw new HttpError(400, `${s.name} 是分支或交办的索引，由 omem 自己收回`);
  const children = childSpaces(app, id);
  if (children.length) throw new HttpError(409, `${s.name} 下面还有仓库（${children.map((c) => c.name).join("、")}）：先把它们移出`);
  const content = spaceContent(app, id);
  if (content.length) throw new HttpError(409, `${s.name} 里还有内容，不能删除：${content.map((c) => `${c.label} ${c.count}`).join("、")}`);
  run(app.db, "delete from space_members where space_id = ?", id);
  run(app.db, "delete from git_commit_cursors where space_id = ?", id);
  run(app.db, "delete from space_relations where space_a = ? or space_b = ?", id, id);
  run(app.db, "delete from spaces where id = ?", id);
  const dir = spaceDir(app, id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    commitLibrary(app.libraryDir, `space: delete ${id}`);
  }
  app.emit({ type: "changed", entity: "space", id });
  return { deleted: id };
}
