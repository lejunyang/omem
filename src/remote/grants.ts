import type { App, AppEvent } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { activeUser, findUser, OWNER } from "../core/users.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { audit } from "../auth/permissions.ts";

export type Mode = "view" | "operate";
type Session = { id: string; userId: string; kind: string; guarded?: boolean };
type Grant = { id: string; sessionId: string; userId: string; userName: string; mode: Mode; expiresAt: string };
const columns = "g.id,g.session_id sessionId,g.user_id userId,u.name userName,g.mode,g.expires_at expiresAt";
const joined = "from remote_grants g join users u on u.id=g.user_id";

export function grantsFor(app: App, sessions: string[], managed: string[], userId: string) {
  return all<Grant>(app.db, `select ${columns} ${joined} where g.session_id in (select value from json_each(?))
    and (g.user_id=? or g.session_id in (select value from json_each(?)))
    and g.revoked_at is null and g.expires_at>?`, JSON.stringify(sessions), userId, JSON.stringify(managed), now());
}

export function grantCandidates(app: App, actor: string) {
  const rows = all<{ id: string; name: string; caps: string }>(app.db, `select u.id,u.name,json_group_array(c.capability) caps
    from member_capability_overrides c join users u on u.id=c.user_id
    where c.capability in ('remote.view','remote.operate') and c.scope_kind='global' and c.scope_id=''
      and c.effect='allow' and c.revoked=0 and u.id!=? and u.role!='owner' and u.kind='person'
      and u.status='active' and u.disabled_at is null and exists
      (select 1 from auth_sessions a where a.user_id=u.id and a.restricted=0 and a.expires_at>?)
    group by u.id order by u.name,u.id`, actor, now());
  return rows.map(r => ({ id: r.id, name: r.name, caps: JSON.parse(r.caps) as string[] }));
}

type EndReason = Extract<AppEvent, { type: "remote-grant-ended" }>["ended"];
type TimedGrant = Pick<Grant, "id" | "userId" | "sessionId" | "expiresAt">;
const timers = new Map<string, NodeJS.Timeout>();

function recordEnd(app: App, grant: TimedGrant, ended: EndReason, at: string) {
  run(app.db, "update remote_grants set ended=?,revoked_at=? where id=?", ended, at, grant.id);
}

function notifyEnd(app: App, grant: TimedGrant, ended: EndReason) {
  clearTimeout(timers.get(grant.id));
  timers.delete(grant.id);
  app.events.emit("remote-access", grant.sessionId, grant.id, null);
  app.emit({ type: "remote-grant-ended", sessionId: grant.sessionId, grantId: grant.id, userId: grant.userId, ended });
}

function scheduleExpiry(app: App, grant: TimedGrant) {
  clearTimeout(timers.get(grant.id));
  const delay = Date.parse(grant.expiresAt) - Date.now();
  if (delay > 0) {
    timers.set(grant.id, setTimeout(() => scheduleExpiry(app, grant), Math.min(delay, 2_147_483_647)).unref());
  } else {
    recordEnd(app, grant, "expired", grant.expiresAt);
    notifyEnd(app, grant, "expired");
  }
}

export function recentlyEnded(app: App, user: string) {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  return all<{ id: string; grantId: string; ended: EndReason; endedAt: string }>(app.db,
    `select session_id id,id grantId,ended,revoked_at endedAt from remote_grants
     where user_id=? and ended is not null and revoked_at>? order by revoked_at desc`, user, since);
}

export function grantEndReason(app: App, id: string) {
  return one<{ reason: EndReason | null }>(app.db, `select coalesce(ended,
    case when expires_at<=? then 'expired' end) reason from remote_grants where id=?`, now(), id)?.reason;
}

export function endSessionGrants(app: App, sessionId: string) {
  const at = now();
  const grants = withinTx(app.db, () => {
    const rows = all<Grant>(app.db, `select ${columns} ${joined} where g.session_id=? and g.revoked_at is null`, sessionId);
    for (const g of rows) {
      if (g.expiresAt <= at) recordEnd(app, g, "expired", g.expiresAt);
      else {
        recordEnd(app, g, "closed", at);
        audit(app, "system", "remote.revoke", sessionId, { sessionId, userId: g.userId, mode: g.mode, expiresAt: g.expiresAt, reason: "session-ended" });
      }
    }
    return rows;
  });
  for (const g of grants) notifyEnd(app, g, g.expiresAt <= at ? "expired" : "closed");
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
  // Operating a browser that can reach this machine would hand over the owner's local access (browser-guard.ts).
  if (edit?.mode === "operate" && !s.guarded) throw new HttpError(400, "这个浏览器能访问本机地址，只能给成员看；要让成员操作，新开一个“给成员用”的浏览器");
  let expired: Grant | undefined;
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
        expired = one<Grant>(app.db, `select ${columns} ${joined} where g.session_id=? and g.user_id=? and g.revoked_at is null`, s.id, userId);
        if (expired) {
          if (expired.expiresAt > now()) throw new HttpError(409, "成员已有授权，请修改原授权");
          recordEnd(app, expired, "expired", expired.expiresAt);
        }
        id = newId("rg");
        run(app.db, "insert into remote_grants(id,session_id,user_id,mode,expires_at,created_by,created_at) values(?,?,?,?,?,?,?)", id, s.id, userId, mode, expiresAt, actor, now());
      } else {
        run(app.db, "update remote_grants set mode=?,expires_at=? where id=?", mode, expiresAt, id);
      }
    } else recordEnd(app, previous!, "revoked", now());
    audit(app, actor, edit ? "remote.grant" : "remote.revoke", s.id, detail);
    return { id: id!, ...detail };
  });
  if (expired) notifyEnd(app, expired, "expired");
  if (edit) {
    app.events.emit("remote-access", s.id, result.id, result.mode);
    scheduleExpiry(app, result);
  } else notifyEnd(app, result, "revoked");
  return result;
}
