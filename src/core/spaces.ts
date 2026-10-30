import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type Row = { id: string; name: string; kind: string; description: string; root_path: string | null; settings: string; created_at: string; updated_at: string };
const toSpace = (r: Row): Space => ({
  id: r.id,
  name: r.name,
  kind: r.kind as SpaceKind,
  description: r.description,
  rootPath: r.root_path,
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
  input: { id?: string; name: string; kind?: SpaceKind; description?: string; rootPath?: string | null },
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

export type SpaceRelation = { space: string; name: string; kind: SpaceKind; note: string; origin: "owner" | "agent"; status: "active" | "rejected"; evidence: string; updatedAt: string };
type RelRow = { space_a: string; space_b: string; note: string; origin: string; status: string; evidence: string; updated_at: string };
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/** The spaces related to one space (relations have no direction). Rejected ones only on request. */
export function relatedSpaces(app: App, id: string, opts: { includeRejected?: boolean } = {}): SpaceRelation[] {
  const rows = all<RelRow>(app.db, `select * from space_relations where (space_a = ? or space_b = ?) ${opts.includeRejected ? "" : "and status = 'active'"} order by updated_at desc`, id, id);
  return rows.flatMap((r) => {
    const other = findSpace(app, r.space_a === id ? r.space_b : r.space_a);
    if (!other) return [];
    return [{ space: other.id, name: other.name, kind: other.kind, note: r.note, origin: r.origin as SpaceRelation["origin"], status: r.status as SpaceRelation["status"], evidence: r.evidence, updatedAt: r.updated_at }];
  });
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
