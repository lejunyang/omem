import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { getUser, OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { capabilityAccess, capabilityCatalog, globalCapability, legacyCapabilities, type Capability, type Override } from "./capabilities.ts";
import { can, findRole, requirePerm, type GlobalPerm, type SpacePerm } from "./permissions.ts";

const ordinaryRoles = ["member", "viewer", "observer"];
export const ownerOnlyMemberGrants = new Set<string>(["settings.members.edit", "settings.security.edit", "settings.system.edit"]);

export type MemberAction = "read" | "manage" | "identity" | "revokeInvite";

export function requireMemberAction(app: App, actor: string, action: MemberAction, id?: string) {
  if (!capabilityAccess(app, actor, null).source("settings.members")) throw new HttpError(403, "没有管理成员的权限");
  if (actor === OWNER || action === "read") return;
  if (action === "identity") throw new HttpError(403, "只有主人能管理登录身份和会话");
  if (!id) return;
  if (action === "revokeInvite") {
    const invite = one<{ role: string }>(app.db, "select role from invites where id=?", id);
    if (invite && !ordinaryRoles.includes(invite.role)) throw new HttpError(403, "只有主人能撤销管理角色的邀请");
    return;
  }
  const target = getUser(app, id);
  if (target.id === actor || target.kind !== "person" || !ordinaryRoles.includes(target.role))
    throw new HttpError(403, "只能管理其他普通成员");
}

/** A whole-form save can grant access by clearing a deny as well as by adding an allow. */
export function requireDelegableChanges(app: App, actor: string, currentPreset: string, preset: string, added: Override[], removed: Override[]) {
  if (actor === OWNER) return;
  const access = capabilityAccess(app, actor);
  const requireGrant = (cap: Capability, space?: string) => {
    if (ownerOnlyMemberGrants.has(cap)) throw new HttpError(403, `只有主人能授予 ${cap}`);
    // A global override on a space capability also covers future memberships.
    if (!globalCapability(cap) && !space) throw new HttpError(403, `请按空间授予 ${cap}`);
    if (!access.source(cap, space)) throw new HttpError(403, `不能授予自己没有的能力：${cap}`);
  };
  if (preset !== currentPreset) {
    if (!ordinaryRoles.includes(preset)) throw new HttpError(403, "只有主人能分配管理角色");
    // Leaving the observer preset also reactivates all legacy space-role writes.
    if (currentPreset === "observer") throw new HttpError(403, "只有主人能解除观察者的只读限制");
    const old = findRole(app, currentPreset)!;
    for (const p of findRole(app, preset)!.permissions)
      if (!old.permissions.includes(p)) requirePerm(app, actor, p as GlobalPerm);
    for (const c of capabilityCatalog(app))
      if (c.presets.includes(preset) && !c.presets.includes(currentPreset)) requireGrant(c.key);
  }
  for (const o of added)
    if (o.effect === "allow") requireGrant(o.capability, o.scope_id);
  for (const o of removed)
    if (o.effect === "deny") requireGrant(o.capability, o.scope_id);
}

export function requireMemberSpaceGrant(app: App, actor: string, space: string, role: string | null) {
  const target = findSpace(app, space);
  if (!target) throw new HttpError(404, `空间不存在：${space}`);
  if (target.kind === "personal") throw new HttpError(400, "个人空间不能加人或移出");
  if (actor === OWNER) return;
  requirePerm(app, actor, "space.manage", space);
  if (!role) return;
  const r = findRole(app, role);
  if (r?.scope !== "space") throw new HttpError(400, "不是空间角色");
  const access = capabilityAccess(app, actor);
  for (const s of access.spaces.filter(s => s.id === space || s.parent_id === space)) {
    for (const perm of r.permissions) {
      if (!can(app, actor, perm as SpacePerm, s.id) || legacyCapabilities[perm]?.some(c => !access.source(c, s.id)))
        throw new HttpError(403, `不能在空间 ${s.id} 授予自己没有的权限：${perm}`);
    }
  }
}
