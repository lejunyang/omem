import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import { OWNER, userName } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import { addRunEvent } from "./runs.ts";
import { credentialMethods, type CredentialMethod } from "./credential-registry.ts";
import { availableLogin, precheckCredential, usableCredential } from "./credentials.ts";

const cutoff = () => new Date(Date.now() - 30 * 86400_000).toISOString();
const shares = `(json_extract(h.sharing,'$.scope')='all' or
  (json_extract(h.sharing,'$.scope')='members' and exists(select 1 from json_each(h.sharing,'$.members') where value=?)))`;

export function applicationUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2000 || !URL.canParse(value)) return null;
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? value : null;
}

export function recordAccess(app: App, kind: string, resource: string, user: string, allowed: boolean, source: string, applyUrl?: string) {
  const at = now(), url = allowed ? null : applicationUrl(applyUrl);
  run(app.db, `insert into credential_access(kind,resource,user_id,allowed,observed_at,source,apply_url,apply_at)
    values(?,?,?,?,?,?,?,?) on conflict(kind,resource,user_id) do update set allowed=excluded.allowed,
    observed_at=excluded.observed_at,source=excluded.source,apply_url=coalesce(excluded.apply_url,apply_url),
    apply_at=coalesce(excluded.apply_at,apply_at)`, kind, resource, user, +allowed, at, source, url, url ? at : null);
}

function visibleRecords(app: App, requester: string, resource: string, kind?: string) {
  return all<{ kind: string; name: string; allowed: number; observed_at: string; apply_at: string | null; apply_url: string | null }>(app.db,
    `select a.kind,u.name,a.allowed,a.observed_at,a.apply_url,a.apply_at from credential_access a
     join users u on u.id=a.user_id left join credential_holds h on h.user_id=a.user_id and h.kind=a.kind
     where a.resource=? and a.observed_at>? ${kind ? "and a.kind=?" : ""}
     and u.disabled_at is null and u.status='active' and u.kind='person'
     and (?=? or a.user_id=? or ${shares}) order by a.observed_at desc,a.kind,a.user_id`,
    resource, cutoff(), ...(kind ? [kind] : []), requester, OWNER, requester, requester);
}

export function knownAccess(app: App, kind: string, resource: string, user: string) {
  const since = cutoff();
  return one<{ allowed: number; apply_url: string | null }>(app.db,
    "select allowed,case when apply_at>? then apply_url end as apply_url from credential_access where kind=? and resource=? and user_id=? and observed_at>?",
    since, kind, resource, user, since);
}

export function sharedHolders(app: App, requester: string, kind: string, limit: number, resource?: string) {
  return all<{ id: string; name: string }>(app.db, `select u.id,u.name from credential_holds h
    join users u on u.id=h.user_id
    left join credential_access a on a.kind=h.kind and a.resource=? and a.user_id=u.id and a.observed_at>?
    where coalesce(a.allowed,1)=1 and h.kind=? and (h.state='logged-in' or (h.user_id=? and h.state='none'))
    and (h.expires_at is null or h.expires_at>?) and h.user_id<>? and ${shares}
    and u.disabled_at is null and u.status='active' and u.kind='person'
    order by a.allowed desc,(u.id=?) desc,h.last_used_at desc,u.id limit ?`, resource ?? null, cutoff(), kind, OWNER, Date.now(), requester, requester, OWNER, limit);
}

export async function checkAccess(app: App, requester: string, runId: string | null, method: CredentialMethod,
  holder: string, target: string, resource: string, command?: { name: string; args: readonly string[] }) {
  const detail = { holder, target, resource, runId };
  audit(app, requester, "credentials.precheck", method.kind, detail);
  if (runId) addRunEvent(app, runId, "status", { text: `使用${userName(app, holder)}的${method.name}预检${resource}，查询对象为${userName(app, target)}。`, ...detail });
  try {
    const result = await precheckCredential(app, holder, method, resource, target, command);
    if (command && result.allowed === true) {
      // A denial received during this check takes precedence over the in-flight confirmation.
      if (result.verifiedRead !== true || knownAccess(app, method.kind, resource, target)?.allowed === 0) return;
    }
    if (typeof result.allowed === "boolean") recordAccess(app, method.kind, resource, target, result.allowed, "precheck", result.applyUrl);
    return result;
  } catch { /* A failed or cancelled check leaves access unknown. */ }
}

export async function whoCan(app: App, requester: string, runId: string | null, resource: string, kind?: string) {
  let rows = visibleRecords(app, requester, resource, kind);
  if (!rows.length) {
    const jobs: { method: CredentialMethod; target: string }[] = [];
    for (const method of credentialMethods()) {
      if (!method.precheck || kind && kind !== method.kind) continue;
      for (const candidate of sharedHolders(app, requester, method.kind, 5 - jobs.length)) jobs.push({ method, target: candidate.id });
      if (jobs.length === 5) break;
    }
    async function worker() {
      for (let job; (job = jobs.shift());) {
        const { method, target } = job;
        const holders = sharedHolders(app, requester, method.kind, 5);
        if (!holders.some(user => user.id === target)) continue;
        const holder = usableCredential(app, requester, method.kind) ? requester : app.config.credentials.lending === "auto"
          ? holders.find(u => availableLogin(app, u.id, method.kind))?.id : undefined;
        if (!holder) continue;
        await checkAccess(app, requester, runId, method, holder, target, resource);
      }
    }
    await Promise.all([worker(), worker()]);
    rows = visibleRecords(app, requester, resource, kind);
  }
  const people = (allowed: number) => rows.filter(row => row.allowed === allowed)
    .map(row => ({ kind: row.kind, name: row.name, observedAt: row.observed_at }));
  const latestLink = rows.filter(row => row.apply_at && row.apply_at > cutoff()).sort((a,b) => b.apply_at!.localeCompare(a.apply_at!))[0];
  return { resource, allowed: people(1), denied: people(0), applyUrl: latestLink?.apply_url ?? null };
}
