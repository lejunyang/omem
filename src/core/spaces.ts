import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { commitLibrary } from "./git.ts";
import { HttpError, json, now, slugify } from "./util.ts";

export type SpaceKind = "personal" | "project" | "repo" | "learning" | "topic";
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

export function listSpaces(app: App): Space[] {
  return all<Row>(app.db, "select * from spaces order by kind = 'personal' desc, updated_at desc").map(toSpace);
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

${description || "（在这里写这个空间的范围、读者和整理要求，Agent 每次工作前都会读它。）"}

- 类型：${kind}
- 读者：
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

export function ensurePersonalSpace(app: App) {
  if (!findSpace(app, "personal"))
    createSpace(app, { id: "personal", name: "个人", kind: "personal", description: "个人笔记、约定、聊天与日常事项。" });
}
