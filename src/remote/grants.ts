import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { activeUser, findUser, OWNER } from "../core/users.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { audit } from "../auth/permissions.ts";

export type Mode = "view" | "operate";
type Session = { id: string; userId: string; kind: string };
type Grant = { id: string; sessionId: string; userId: string; userName: string; mode: Mode; expiresAt: string };
const columns = "g.id,g.session_id sessionId,g.user_id userId,u.name userName,g.mode,g.expires_at expiresAt";
const joined = "from remote_grants g join users u on u.id=g.user_id";

export function grantsFor(app: App, sessions: string[], managed: string[], userId: string) {
  return all<Grant>(app.db, `select ${columns} ${joined} where g.session_id in (select value from json_each(?))
    and (g.user_id=? or g.session_id in (select value from json_each(?)))
    and g.revoked_at is null and g.expires_at>?`, JSON.stringify(sessions), userId, JSON.stringify(managed), now());
}

/** A closed browser ends all its remaining grants together, with one audit entry per member. */
export function endSessionGrants(app: App, sessionId: string) {
  const at = now();
  withinTx(app.db, () => {
    run(app.db, `insert into audit_events(at,actor,action,target,detail)
      select ?, 'system', 'remote.revoke', session_id, json_object('sessionId',session_id,'userId',user_id,
        'mode',mode,'expiresAt',expires_at,'reason','session-ended') from remote_grants
      where session_id=? and revoked_at is null and expires_at>?`, at, sessionId, at);
    run(app.db, "update remote_grants set revoked_at=? where session_id=? and revoked_at is null", at, sessionId);
  });
}

/** The two global remote capabilities have no member preset. Use their indexed override on the frame path. */
export function effectiveGrant(app: App, session: Session, user: string) {
  if (session.kind !== "browser") return null;
  return one<Grant>(app.db, `select ${columns} ${joined}
    left join member_capability_overrides c on c.user_id=u.id and c.scope_kind='global' and c.scope_id=''
      and c.capability='remote.'||g.mode and c.revoked=0
    where g.session_id=? and g.user_id=? and g.revoked_at is null and g.expires_at>?
      and u.disabled_at is null and u.status='active' and (u.role='owner' or c.effect='allow')`, session.id, user, now());
}

type Edit = { userId?: string; mode?: Mode; hours?: number };
export function changeGrant(app: App, s: Session, actor: string, edit: Edit | null, id?: string) {
  if (actor !== OWNER && actor !== s.userId) throw new HttpError(403, "只有会话主人能管理授权");
  if (s.kind !== "browser") throw new HttpError(400, "只能授权浏览器会话");
  const result = withinTx(app.db, () => {
    const previous = id ? one<Grant>(app.db, `select ${columns} ${joined} where g.session_id=? and g.id=? and g.revoked_at is null`, s.id, id) : null;
    if (id && (!previous || previous.expiresAt <= now())) throw new HttpError(404, "授权不存在或已经到期");
    const userId = previous?.userId ?? edit!.userId!;
    const mode = edit?.mode ?? previous!.mode;
    const { defaultHours, maxHours } = app.config.remoteGrants;
    const hours = edit?.hours ?? Math.min(defaultHours, maxHours);
    if (hours > maxHours) throw new HttpError(400, `有效期最长 ${maxHours} 小时`);
    const expiresAt = previous && edit?.hours === undefined ? previous.expiresAt : new Date(Date.now() + hours * 3600_000).toISOString();
    const detail = { sessionId: s.id, userId, mode, expiresAt };
    if (edit) {
      const member = findUser(app, userId);
      if (!activeUser(member) || member.kind !== "person" || userId === OWNER || userId === s.userId ||
          !one(app.db, "select 1 from auth_sessions where user_id=? and restricted=0 and expires_at>? limit 1", userId, now()))
        throw new HttpError(400, "请选择已经登录的有效成员");
      if (!id) {
        run(app.db, "update remote_grants set revoked_at=? where session_id=? and user_id=? and revoked_at is null and expires_at<=?", now(), s.id, userId, now());
        if (one(app.db, "select 1 from remote_grants where session_id=? and user_id=? and revoked_at is null", s.id, userId))
          throw new HttpError(409, "成员已有授权，请修改原授权");
        id = newId("rg");
        run(app.db, "insert into remote_grants values(?,?,?,?,?,?,?,null)", id, s.id, userId, mode, expiresAt, actor, now());
      } else {
        run(app.db, "update remote_grants set mode=?,expires_at=? where id=?", mode, expiresAt, id);
      }
    } else run(app.db, "update remote_grants set revoked_at=? where id=?", now(), id!);
    audit(app, actor, edit ? "remote.grant" : "remote.revoke", s.id, detail);
    return { id, ...detail };
  });
  app.events.emit("remote-access", s.id, result.id, edit ? result.mode : null);
  return result;
}
