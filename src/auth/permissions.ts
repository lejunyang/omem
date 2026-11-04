import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, now, slugify } from "../core/util.ts";

/**
 * Roles and permissions (docs/v2/multi-user.md, “角色与权限”). A permission is an action; global
 * ones do not depend on a space, space ones apply to one space. Every user has one global role, and
 * one space role in each space they are a member of. A user may do P in space S when their global
 * role grants `P@*` (every space but other people's personal ones) or their role in S grants P. The
 * owner may do everything. Only grants, no denials.
 */
export const GLOBAL_PERMS = {
  "users.manage": "管理用户、角色、邀请和批准",
  "settings.manage": "改渠道、AI 后端和系统设置",
  "peers.manage": "设备配对、对外共享和订阅",
  "agents.manage": "改 Agent 档案、技能、规则和定时任务",
  "spaces.create": "新建空间",
  "runs.read.all": "看所有人的运行",
  "code.delegate": "交办编码和评审（在宿主机上跑命令）",
  "desktop.control": "操作桌面",
  "share.external": "生成对外分享链接",
  "connector.use": "连接第三方平台（飞书等）",
} as const;
export const SPACE_PERMS = {
  "space.read": "检索，读原件、Wiki、记忆、事项",
  "source.write": "导入、移动、定级、标注原件",
  "memory.write": "写记忆和事项",
  "wiki.write": "写页面、整理 Wiki",
  "capture.route": "把聊天和文档的采集指到这个空间",
  "runs.read": "看这个空间里别人的运行",
  "space.manage": "成员、空间设置、空间关联",
} as const;
export type GlobalPerm = keyof typeof GLOBAL_PERMS;
export type SpacePerm = keyof typeof SPACE_PERMS;
export type Perm = GlobalPerm | SpacePerm;
const SPACE_LIST = Object.keys(SPACE_PERMS) as SpacePerm[];
const everySpace = (perms: SpacePerm[]) => perms.map((p) => `${p}@*`);

export type RoleScope = "global" | "space";
export type Role = { id: string; name: string; scope: RoleScope; description: string; permissions: string[]; builtin: boolean };

/** Built in, not editable (copy one to make a custom role). `owner` is everything and needs no list. */
export const BUILTIN_ROLES: Role[] = [
  { id: "owner", name: "主人", scope: "global", builtin: true, description: "omem 的主人：全部权限", permissions: ["*"] },
  {
    id: "admin",
    name: "管理员",
    scope: "global",
    builtin: true,
    description: "所有空间（别人的个人空间除外）的管理者；能改 Agent、规则；不能改系统设置、设备、交办编码",
    permissions: ["agents.manage", "spaces.create", "runs.read.all", "share.external", "connector.use", ...everySpace(SPACE_LIST)],
  },
  { id: "member", name: "成员", scope: "global", builtin: true, description: "能新建空间、连接飞书、生成分享链接；只能用被加入的空间", permissions: ["spaces.create", "connector.use", "share.external"] },
  { id: "viewer", name: "访客", scope: "global", builtin: true, description: "只读被加入的空间，可以提问", permissions: [] },
  { id: "reader", name: "只读", scope: "space", builtin: true, description: "检索和阅读", permissions: ["space.read"] },
  { id: "contributor", name: "贡献者", scope: "space", builtin: true, description: "只读 + 导入原件、写记忆和事项", permissions: ["space.read", "source.write", "memory.write"] },
  { id: "editor", name: "编辑", scope: "space", builtin: true, description: "贡献者 + 写 Wiki、采集进来、看别人的运行", permissions: ["space.read", "source.write", "memory.write", "wiki.write", "capture.route", "runs.read"] },
  { id: "manager", name: "管理", scope: "space", builtin: true, description: "编辑 + 成员和空间设置", permissions: [...SPACE_LIST] },
];
const BUILTIN = new Map(BUILTIN_ROLES.map((r) => [r.id, r]));

type RoleRow = { id: string; name: string; scope: string; description: string; permissions: string; created_at: string; updated_at: string };
const toRole = (r: RoleRow): Role => ({ id: r.id, name: r.name, scope: r.scope === "space" ? "space" : "global", description: r.description, permissions: json<string[]>(r.permissions, []), builtin: false });

export function listRoles(app: App, scope?: RoleScope): Role[] {
  const custom = all<RoleRow>(app.db, "select * from roles order by created_at").map(toRole);
  return [...BUILTIN_ROLES, ...custom].filter((r) => !scope || r.scope === scope);
}
export function findRole(app: App, id: string): Role | null {
  if (BUILTIN.has(id)) return BUILTIN.get(id)!;
  const r = one<RoleRow>(app.db, "select * from roles where id = ?", id);
  return r ? toRole(r) : null;
}

function validPermissions(scope: RoleScope, perms: string[]) {
  const ok = new Set<string>(scope === "space" ? SPACE_LIST : [...Object.keys(GLOBAL_PERMS), ...everySpace(SPACE_LIST)]);
  const bad = perms.filter((p) => !ok.has(p));
  if (bad.length) throw new HttpError(400, `不认识的权限：${bad.join("、")}`);
  return [...new Set(perms)];
}

export function saveRole(app: App, input: { id?: string; name: string; scope: RoleScope; description?: string; permissions: string[] }) {
  const id = input.id ?? (slugify(input.name).replace(/[^a-z0-9-]/g, "") || `role-${Date.now().toString(36)}`);
  if (BUILTIN.has(id)) throw new HttpError(400, "内置角色不能改，复制一份再改");
  const perms = validPermissions(input.scope, input.permissions);
  const old = one<RoleRow>(app.db, "select * from roles where id = ?", id);
  if (old && old.scope !== input.scope) throw new HttpError(400, "角色的类型不能改");
  run(
    app.db,
    "insert into roles(id,name,scope,description,permissions,created_at,updated_at) values(?,?,?,?,?,?,?) on conflict(id) do update set name = excluded.name, description = excluded.description, permissions = excluded.permissions, updated_at = excluded.updated_at",
    id, input.name, input.scope, input.description ?? "", JSON.stringify(perms), now(), now(),
  );
  return findRole(app, id)!;
}
export function deleteRole(app: App, id: string) {
  if (BUILTIN.has(id)) throw new HttpError(400, "内置角色不能删");
  const used = one<{ n: number }>(app.db, "select (select count(*) from users where role = ?) + (select count(*) from space_members where role = ?) n", id, id)!.n;
  if (used) throw new HttpError(409, `还有 ${used} 处在用这个角色，先换成别的角色`);
  run(app.db, "delete from roles where id = ?", id);
}

// ---- checking ----------------------------------------------------------------

type Who = { id: string; role: string; active: boolean };
function who(app: App, userId: string): Who | null {
  const r = one<{ id: string; role: string; status: string; disabled_at: string | null }>(app.db, "select id, role, status, disabled_at from users where id = ?", userId);
  return r ? { id: r.id, role: r.role, active: r.status === "active" && !r.disabled_at } : null;
}
const grants = (app: App, roleId: string) => new Set(findRole(app, roleId)?.permissions ?? []);
/** Someone else's personal space: `@*` grants never reach it. */
const othersPersonal = (app: App, spaceId: string, userId: string) => {
  const s = one<{ kind: string; owner_id: string }>(app.db, "select kind, owner_id from spaces where id = ?", spaceId);
  return !!s && s.kind === "personal" && s.owner_id !== userId;
};

export const isOwner = (app: App, userId: string) => who(app, userId)?.role === "owner";

/** Whether the user may do this; space permissions need the space. */
/** Space permissions that change its content: none in another server's mirror (src/core/federation.ts), whoever asks. */
const WRITES = new Set<Perm>(["source.write", "memory.write", "wiki.write", "capture.route"]);
const mirrored = (app: App, spaceId: string) => !!one<{ m: string | null }>(app.db, "select json_extract(settings, '$.mirror') m from spaces where id = ?", spaceId)?.m;

export function can(app: App, userId: string, perm: Perm, spaceId?: string | null): boolean {
  const u = who(app, userId);
  if (!u?.active) return false;
  if (spaceId && WRITES.has(perm) && mirrored(app, spaceId)) return false;
  if (u.role === "owner") return true;
  const g = grants(app, u.role);
  if (perm in GLOBAL_PERMS) return g.has(perm);
  if (!spaceId) return false;
  if (g.has(`${perm}@*`) && !othersPersonal(app, spaceId, userId)) return true;
  const m = one<{ role: string }>(app.db, "select role from space_members where space_id = ? and user_id = ?", spaceId, userId);
  return !!m && grants(app, spaceRole(m.role)).has(perm);
}
/** Old memberships said `owner` for the space's manager. */
const spaceRole = (role: string) => (role === "owner" ? "manager" : role);

/** Spaces where the user has this permission; null means all of them (the owner). */
export function spacesWith(app: App, userId: string, perm: SpacePerm): string[] | null {
  const u = who(app, userId);
  if (!u?.active) return [];
  if (u.role === "owner") return null;
  const out = new Set<string>();
  if (grants(app, u.role).has(`${perm}@*`))
    for (const s of all<{ id: string; kind: string; owner_id: string }>(app.db, "select id, kind, owner_id from spaces")) if (s.kind !== "personal" || s.owner_id === userId) out.add(s.id);
  for (const m of all<{ space_id: string; role: string }>(app.db, "select space_id, role from space_members where user_id = ?", userId)) if (grants(app, spaceRole(m.role)).has(perm)) out.add(m.space_id);
  return [...out];
}

/** The global permissions the user has (the page shows what they can use). */
export function globalPerms(app: App, userId: string): GlobalPerm[] {
  const u = who(app, userId);
  if (!u?.active) return [];
  const all = Object.keys(GLOBAL_PERMS) as GlobalPerm[];
  if (u.role === "owner") return all;
  const g = grants(app, u.role);
  return all.filter((p) => g.has(p));
}

export function requirePerm(app: App, userId: string, perm: Perm, spaceId?: string | null) {
  if (can(app, userId, perm, spaceId)) return;
  const label = (GLOBAL_PERMS as Record<string, string>)[perm] ?? (SPACE_PERMS as Record<string, string>)[perm] ?? perm;
  throw new HttpError(403, spaceId ? `在空间 ${spaceId} 没有权限：${label}` : `没有权限：${label}`);
}

/**
 * Who may read a run: its user; or someone with `runs.read` in every space the run could read
 * (its events may quote any of them), or `runs.read.all` (still not into other people's personal spaces).
 */
export function canReadRun(app: App, userId: string, runId: string): boolean {
  const r = one<{ user_id: string | null; space_id: string | null; scope: string | null }>(app.db, "select user_id, space_id, scope from runs where id = ?", runId);
  if (!r) return false;
  const u = who(app, userId);
  if (!u?.active) return false;
  if (u.role === "owner" || (r.user_id ?? "owner") === userId) return true;
  // No recorded scope: a run of the owner's that could read everything, or one from before scopes were
  // recorded. Those stay with their user (and the owner).
  const spaces = r.scope === null ? null : json<string[] | null>(r.scope, null);
  if (spaces === null) return false;
  if (!spaces.length) return grants(app, u.role).has("runs.read.all");
  if (grants(app, u.role).has("runs.read.all")) return spaces.every((s) => !othersPersonal(app, s, userId));
  return spaces.every((s) => can(app, userId, "runs.read", s));
}

/** The spaces in which the user may read other people's runs (the list filter of canReadRun); null: all runs. */
export function runReadableSpaces(app: App, userId: string): string[] | null {
  const u = who(app, userId);
  if (!u?.active) return [];
  if (u.role === "owner") return null;
  if (grants(app, u.role).has("runs.read.all"))
    return all<{ id: string; kind: string; owner_id: string }>(app.db, "select id, kind, owner_id from spaces").filter((s) => s.kind !== "personal" || s.owner_id === userId).map((s) => s.id);
  return spacesWith(app, userId, "runs.read") ?? [];
}

// ---- audit -------------------------------------------------------------------

/** Who changed roles, members, identities, invites, connections or shares (设置 → 成员). */
export function audit(app: App, actor: string, action: string, target: string, detail: Record<string, unknown> = {}) {
  run(app.db, "insert into audit_events(at,actor,action,target,detail) values(?,?,?,?,?)", now(), actor, action, target, JSON.stringify(detail));
}
export function auditLog(app: App, limit = 200) {
  return all<{ id: number; at: string; actor: string; action: string; target: string; detail: string }>(app.db, "select * from audit_events order by id desc limit ?", limit).map((r) => ({ ...r, detail: json<Record<string, unknown>>(r.detail, {}) }));
}
