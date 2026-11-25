import { createHash, randomUUID } from "node:crypto";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { retryFailure } from "./delivery-policy.ts";
import { hookEvent, hookWindowMs, parseHookEvent } from "./hook-request.ts";
import { hookRetryAfter, pluginHook, runHook, type RegisteredHook } from "./hooks.ts";
import type { PluginHookAcceptState, PluginHookFormat, PluginHookRequest } from "./types.ts";

export const HOOK_CONCURRENCY = 4;
export const HOOK_PENDING_MAX = 256;
export const HOOK_HISTORY_MAX = 10_000;
export const HOOK_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
export const HOOK_RETRY_MS = [5_000, 30_000] as const;
const POLL_MS = 1_000;
const CLEANUP_MS = 60_000;
const FINAL = "('done','failed','duplicate')";

type Envelope = Pick<PluginHookRequest, "method" | "headers" | "query">;
type Queued = { id: string; plugin: string; name: string; key: string | null; format: PluginHookFormat; envelope: string; body: string; attempts: number };
type Admission = (PluginHookAcceptState & { at: number; staged: boolean }) | { status: 429 | 503; retry: number };
export const hookBodyHash = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");

function discardUnaccepted(app: App, before: number) {
  run(app.db, `update plugin_hook_deliveries set status='failed',key_until=null,body=null,envelope=null,error='未完成回调受理'
    where status='admitting' and received_at<=?`, before);
}

function prune(app: App, reference: number) {
  run(app.db, `delete from plugin_hook_deliveries where received_at <= ? and status in ${FINAL} and coalesce(key_until,0)<=?`, reference - HOOK_HISTORY_MS, reference);
}

function makeRoom(app: App, at: number) {
  const excess = one<{ count: number }>(app.db, "select count(*) as count from plugin_hook_deliveries")!.count - HOOK_HISTORY_MAX + 1;
  if (excess <= 0) return true;
  return run(app.db, `delete from plugin_hook_deliveries where rowid in (
    select rowid from plugin_hook_deliveries where status in ${FINAL} and coalesce(key_until,0)<=? order by received_at,rowid limit ?
  )`, at, excess).changes === excess;
}

export function recentHookDeliveries(app: App, plugin: string, name: string) {
  return all(app.db, `select id,key as deliveryKey,received_at as receivedAt,status,format,attempts,duration_ms as durationMs,error,
    due_at as retryAt,duplicate_of as duplicateOf,duplicates,last_duplicate_at as lastDuplicateAt
    from plugin_hook_deliveries where plugin=? and name=? order by received_at desc,rowid desc limit 50`, plugin, name);
}

export function hookInbox(app: App) {
  let stopped = true;
  let lastCleanup = 0;
  let timer: NodeJS.Timeout | undefined;
  let wake: NodeJS.Immediate | undefined;
  const slots = new Set<string>();
  const jobs = new Set<Promise<void>>();

  function admit(hook: RegisteredHook, envelope: Envelope, body: string, format: PluginHookFormat, key: string | null, hash: string | null, at = Date.now()): Admission {
    return tx(app.db, () => {
      const id = randomUUID();
      const original = key === null ? undefined : one<{ id: string; received_at: number; status: string; body_hash: string | null; legacy_body: string | null }>(app.db,
        `select id,received_at,status,body_hash,case when body_hash is null then body end as legacy_body
          from plugin_hook_deliveries where plugin=? and name=? and key=? and key_until>? order by key_until desc limit 1`,
        hook.plugin, hook.name, key, at);
      if (original) {
        if (original.status === "admitting") return { status: 503, retry: 1 };
        const originalHash = original.body_hash ?? (original.legacy_body === null ? null : hookBodyHash(original.legacy_body));
        if (originalHash !== hash || originalHash === null) return { deliveryId: original.id, conflict: true, duplicate: false, at: original.received_at, staged: false };
        run(app.db, "update plugin_hook_deliveries set duplicates=duplicates+1,last_duplicate_at=? where id=?", at, original.id);
        if (makeRoom(app, at)) run(app.db, `insert into plugin_hook_deliveries(id,plugin,name,key,received_at,status,format,duplicate_of,duration_ms)
          values(?,?,?,?,?,'duplicate',?,?,0)`, id, hook.plugin, hook.name, key, at, format, original.id);
        return { deliveryId: original.id, duplicate: true, conflict: false, at: original.received_at, staged: false };
      }

      const queued = hook.ack === "first";
      const staged = queued && !!hook.respond;
      if (stopped || (!queued && slots.size >= HOOK_CONCURRENCY)) return { status: 503, retry: 1 };
      if (queued && one<{ count: number }>(app.db, "select count(*) as count from plugin_hook_deliveries where body is not null")!.count >= HOOK_PENDING_MAX)
        return { status: 503, retry: 5 };
      const retry = hook.respond ? 0 : hookRetryAfter(app, hook, at);
      if (retry) return { status: 429, retry };
      if (!makeRoom(app, at)) return { status: 503, retry: 60 };
      run(app.db, `insert into plugin_hook_deliveries(id,plugin,name,key,key_until,received_at,status,due_at,format,envelope,body,attempts,body_hash)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, hook.plugin, hook.name, key, key === null ? null : at + hookWindowMs(hook), at,
        staged ? "admitting" : queued ? "pending" : "running", queued && !staged ? at : null, format,
        queued ? JSON.stringify(envelope) : null, queued ? body : null, queued ? 0 : 1, hash);
      return { deliveryId: id, duplicate: false, conflict: false, at, staged };
    });
  }

  function finishAdmission(id: string, status: number) {
    const result = status >= 200 && status < 300
      ? run(app.db, "update plugin_hook_deliveries set status='pending',due_at=? where id=? and status='admitting'", Date.now(), id)
      : run(app.db, `update plugin_hook_deliveries set status='failed',key_until=null,body=null,envelope=null,error=?
        where id=? and status='admitting'`, `回调未受理（HTTP ${status}）`, id);
    if (result.changes !== 1) throw new Error("回调待受理记录已经失效");
  }

  function reserve(id: string) {
    slots.add(id);
    let processing = true, handling = false;
    const release = () => {
      if (processing || handling) return;
      slots.delete(id);
      schedule();
    };
    return {
      get handling() { return handling; },
      track: (work: Promise<unknown>) => {
        handling = true;
        const done = () => { handling = false; release(); };
        void work.then(done, done);
      },
      finish: () => { processing = false; release(); },
    };
  }

  function complete(id: string, status: "done" | "failed" | "pending", started: number, error: string | null, next: number | null, keepKey = true) {
    run(app.db, `update plugin_hook_deliveries set status=?,due_at=?,duration_ms=coalesce(duration_ms,0)+?,error=?,
      body=case when ?='pending' then body end,envelope=case when ?='pending' then envelope end,
      key_until=case when ?=1 then key_until end where id=? and status='running'`, status, next, Date.now() - started, error?.slice(0, 1000) ?? null,
      status, status, keepKey ? 1 : 0, id);
  }

  async function sync(hook: RegisteredHook, req: PluginHookRequest) {
    const started = Date.now();
    const slot = reserve(req.deliveryId);
    try {
      const result = await runHook(app, hook, req, slot.track);
      complete(req.deliveryId, "done", started, null, null);
      return result;
    } catch (error) {
      complete(req.deliveryId, "failed", started, String((error as Error).message ?? error), null, false);
      throw error;
    } finally { slot.finish(); }
  }

  async function process(row: Queued, started: number) {
    const slot = reserve(row.id);
    try {
      const hook = pluginHook(row.plugin, row.name);
      if (!hook) throw new HttpError(404, "回调已停用或不存在");
      const req = { ...JSON.parse(row.envelope) as Envelope, body: row.body, event: hookEvent(parseHookEvent(row.body, row.format)), deliveryId: row.id, deliveryKey: row.key };
      await runHook(app, hook, req, slot.track);
      complete(row.id, "done", started, null, null);
    } catch (error) {
      const reason = slot.handling ? "回调超时，处理器未退出，不再重试" : String((error as Error).message ?? error);
      const failure = retryFailure(row.attempts, reason, slot.handling ? [] : HOOK_RETRY_MS);
      complete(row.id, failure.state, started, failure.error, failure.state === "pending" ? failure.due : null);
    } finally { slot.finish(); }
  }

  function tick() {
    if (stopped) return;
    if (!app.db.isOpen) { pause(); return; }
    const at = Date.now();
    if (at - lastCleanup >= CLEANUP_MS) { discardUnaccepted(app, at - CLEANUP_MS); prune(app, at); lastCleanup = at; }
    if (slots.size >= HOOK_CONCURRENCY) return;
    const rows = all<{ id: string }>(app.db, "select id from plugin_hook_deliveries where status='pending' and due_at<=? order by due_at,rowid limit ?", at, HOOK_CONCURRENCY);
    for (const { id } of rows) {
      if (slots.has(id)) continue;
      const row = one<Queued>(app.db, `update plugin_hook_deliveries set status='running',due_at=null,attempts=attempts+1
        where id=? and status='pending' returning id,plugin,name,key,format,envelope,body,attempts-1 as attempts`, id);
      if (!row) continue;
      const job = process(row, at).catch(error => console.error("[hook inbox]", error));
      jobs.add(job);
      void job.then(() => jobs.delete(job));
      if (slots.size >= HOOK_CONCURRENCY) break;
    }
  }

  function poll() { try { tick(); } catch (error) { console.error("[hook inbox]", error); } }
  function schedule() {
    if (stopped || wake) return;
    wake = setImmediate(() => { wake = undefined; poll(); });
    wake.unref();
  }

  function start() {
    const at = Date.now();
    tx(app.db, () => {
      discardUnaccepted(app, at);
      run(app.db, "update plugin_hook_deliveries set status='pending',due_at=?,attempts=attempts-1 where status='running' and body is not null", at);
      run(app.db, "update plugin_hook_deliveries set status='failed',key_until=null,error='同步回调在服务重启时中断' where status='running' and body is null");
      prune(app, at);
    });
    lastCleanup = at;
    stopped = false;
    timer = setInterval(poll, POLL_MS);
    timer.unref();
  }

  function pause() { stopped = true; clearInterval(timer); clearImmediate(wake); wake = undefined; }
  async function stop() { pause(); await Promise.all(jobs); }
  return { admit, finishAdmission, sync, schedule, start, pause, stop };
}
