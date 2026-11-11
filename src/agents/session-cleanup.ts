import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { json, now } from "../core/util.ts";
import { cleanupAcpSession } from "./acp.ts";
import { disposableChildren } from "./session-children.ts";
import { deleteDoubaoSession, doubaoAppFor, doubaoApps, doubaoSessionStatus, doubaoTokenExists } from "./doubao.ts";
import type { AgentEvent, AgentRequest, SessionCleanup } from "./types.ts";

type Pending = {
  backend_key: string; session_id: string; transport: string; profile_id: string | null;
  fingerprint: string | null; app_id: string | null; cwd: string; run_id: string | null;
  owner_pid: number; ready: number; retry_at: string; attempts?: number;
};
type Key = Pick<Pending, "backend_key" | "session_id">;
type Emit = (e: AgentEvent) => void;
/** How long the sessions of work handed to agents are kept after the last run in it. */
const RETAIN_IDLE_MS = 2 * 86400_000;
/** A cleanup that keeps failing is retried less and less often, then dropped: the session is most likely gone on the backend's side. */
const GIVE_UP_AFTER = 12;
const retryDelay = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3600_000);
const busy = new Set<string>();
const activeTurns = new Set<string>();
const sessionKey = (app: App, p: Key) => `${app.home}:${p.backend_key}:${p.session_id}`;

// Resolve credentials from current configuration; never copy environment values into the ledger.
function fingerprint(p: AgentProfile) {
  return createHash("sha256").update(JSON.stringify([p.transport, p.command, p.args, p.archiveArgs ?? [], Object.entries(p.env).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}

/** One lifecycle for temporary turns, pooled ACP sessions and explicitly replaced sessions. */
export async function sessionCleanup(app: App, profile: AgentProfile, req: Pick<AgentRequest, "cwd" | "runId" | "persistSession" | "resumeSessionId">, emit: Emit): Promise<SessionCleanup> {
  const acp = profile.transport === "acp";
  const appId = acp ? null : (profile.env.DOUBAO_APP_ID ?? doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config))?.appId ?? null);
  const hash = acp ? fingerprint(profile) : null;
  const backend = acp ? `acp:${hash}` : `doubao:${appId ?? ""}`;
  const retained = !!req.persistSession || !!req.resumeSessionId;
  const record = (id: string, ready: number) => {
    run(app.db, `insert into session_cleanup(backend_key,session_id,transport,profile_id,fingerprint,app_id,cwd,run_id,owner_pid,ready,retry_at) values(?,?,?,?,?,?,?,?,?,?,?)
      on conflict(backend_key,session_id) do update set run_id = coalesce(excluded.run_id, session_cleanup.run_id), owner_pid = excluded.owner_pid, ready = excluded.ready`, backend, id, profile.transport, profile.id, hash, appId, req.cwd, req.runId ?? null, process.pid, ready, now());
  };
  return {
    created(id) { record(id, retained ? -1 : 0); },
    active(id, active) {
      const key = sessionKey(app, { backend_key: backend, session_id: id });
      if (active) activeTurns.add(key);
      else activeTurns.delete(key);
    },
    async children(id) {
      const p = one<Pending>(app.db, "select * from session_cleanup where backend_key = ? and session_id = ?", backend, id);
      if (p) await cleanChildren(app, p, profile, emit);
    },
    async discard(id, operation) {
      run(app.db, "update session_cleanup set ready = 1 where backend_key = ? and session_id = ?", backend, id);
      const p = one<Pending>(app.db, "select * from session_cleanup where backend_key = ? and session_id = ?", backend, id);
      if (p) await clean(app, p, emit, false, operation ?? (acp ? () => cleanupAcpSession(profile, id, req.cwd) : undefined), profile);
    },
  };
}

/** An explicitly replaced retained session: its original backend is recorded even if routing changed. */
export async function retireRecordedSession(app: App, sessionId: string, emit: Emit) {
  const records = all<Pending>(app.db, "select * from session_cleanup where session_id = ?", sessionId);
  // Older runs have no recorded backend; ambiguous ids cannot safely choose one.
  if (!records.length) return false;
  if (records.length !== 1) {
    emit({ type: "status", text: "后端会话清理未执行：这个会话 ID 对应多个后端，无法唯一识别" });
    return true;
  }
  const p = records[0];
  update(app, p, "ready = 1");
  await clean(app, p, emit, false);
  return true;
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function activeElsewhere(app: App, p: Pending) {
  return activeTurns.has(sessionKey(app, p)) || (p.owner_pid !== process.pid && alive(p.owner_pid));
}
function update(app: App, p: Key, sql: string, ...args: (string | number)[]) {
  run(app.db, `update session_cleanup set ${sql} where backend_key = ? and session_id = ?`, ...args, p.backend_key, p.session_id);
}

async function cleanChildren(app: App, p: Pending, profile: AgentProfile, emit: Emit) {
  for (const id of await disposableChildren(profile, p.session_id, p.cwd)) {
    // Each helper gets its own durable retry, including when its parent is kept or already archived.
    run(app.db, `insert into session_cleanup(backend_key,session_id,transport,profile_id,fingerprint,app_id,cwd,run_id,owner_pid,ready,retry_at)
      values(?,?,?,?,?,?,?,?,?,1,?) on conflict(backend_key,session_id) do nothing`,
    p.backend_key, id, p.transport, p.profile_id, p.fingerprint, p.app_id, p.cwd, p.run_id, process.pid, now());
    const child = one<Pending>(app.db, "select * from session_cleanup where backend_key = ? and session_id = ?", p.backend_key, id)!;
    await clean(app, child, emit, false, () => cleanupAcpSession(profile, id, existsSync(p.cwd) ? p.cwd : app.home), profile);
  }
}

function recordedProfile(app: App, p: Pending) {
  const profile = allProfiles(app.config).find(a => a.id === p.profile_id && fingerprint(a) === p.fingerprint);
  if (!profile) throw new Error("创建时使用的后端配置已变更或移除，等待原配置恢复后重试");
  return profile;
}

async function perform(app: App, p: Pending, recovering: boolean): Promise<boolean> {
  if (p.transport === "acp") {
    const profile = recordedProfile(app, p);
    await cleanupAcpSession(profile, p.session_id, existsSync(p.cwd) ? p.cwd : app.home);
    return true;
  }
  if (!doubaoTokenExists(app.home)) throw new Error("豆包 OpenAPI 没有在这台机器上授权，会话留在豆包历史里（omem doubao login 后重试）");
  const apps = await doubaoApps(app.home, app.config);
  const da = p.app_id ? apps.find(a => a.appId === p.app_id) : doubaoAppFor(app.home, { env: {} }, apps);
  if (!da) throw new Error("找不到创建时选用的豆包应用，等待应用恢复后重试");
  if (!p.app_id) update(app, p, "app_id = ?", da.appId);
  if (recovering) {
    const status = await doubaoSessionStatus(app.home, da, p.session_id);
    if (status !== null && status !== "idle") return false;
    if (status === null) return true;
  }
  await deleteDoubaoSession(app.home, da, p.session_id);
  return true;
}

async function clean(app: App, p: Pending, emit: Emit, recovering: boolean, operation?: () => Promise<void>, profile?: AgentProfile) {
  const key = sessionKey(app, p);
  if (busy.has(key)) return;
  busy.add(key);
  try {
    // Delay both failures and still-running cloud tasks; the next sweep tries again.
    update(app, p, "retry_at = ?", new Date(Date.now() + retryDelay(p.attempts ?? 0)).toISOString());
    if (p.transport === "acp") await cleanChildren(app, p, profile ?? recordedProfile(app, p), emit);
    if (operation) await operation();
    else if (!await perform(app, p, recovering)) return;
    run(app.db, "delete from session_cleanup where backend_key = ? and session_id = ?", p.backend_key, p.session_id);
    emit({ type: "status", text: `已清理后端会话 ${p.session_id}（${p.profile_id ?? p.transport}${p.app_id ? `，应用 ${p.app_id}` : ""}${recovering ? "，恢复待清理会话" : ""}）` });
  } catch (e) {
    const attempts = (p.attempts ?? 0) + 1;
    const why = (e as Error).message.slice(0, 160);
    if (attempts >= GIVE_UP_AFTER) {
      run(app.db, "delete from session_cleanup where backend_key = ? and session_id = ?", p.backend_key, p.session_id);
      emit({ type: "status", text: `后端会话 ${p.session_id}（${p.profile_id ?? p.transport}）清理了 ${attempts} 次都失败，不再重试：${why}` });
    } else {
      update(app, p, "attempts = ?, retry_at = ?", attempts, new Date(Date.now() + retryDelay(attempts)).toISOString());
      emit({ type: "status", text: `后端会话清理失败，稍后重试（第 ${attempts} 次）：${why}` });
    }
  } finally { busy.delete(key); }
}

/** A rule batch only needs its session while a queued successor or a followed topic can resume it. */
function releaseRuleSessions(app: App) {
  const active = all<{ id: string; lane: string | null; input: string }>(app.db, "select id,lane,input from runs where status in ('queued','running')");
  const lanes = new Set(active.map(r => r.lane).filter(Boolean));
  const resumeIds = new Set<string>();
  const resumeRuns = new Set<string>();
  for (const r of active) {
    const input = json<Record<string, unknown>>(r.input, {});
    if (typeof input.resumeSessionId === "string") resumeIds.add(input.resumeSessionId);
    if (typeof input.resumeFromRun === "string") resumeRuns.add(input.resumeFromRun);
    // A pending wake_later continues the run that set it (wakes.ts fireWake resumes its session).
    const wakeOf = (input.target as { resumeRunId?: unknown } | undefined)?.resumeRunId;
    if (typeof wakeOf === "string") resumeRuns.add(wakeOf);
  }
  // So does a pending wake_on_message, kept as a temporary rule with a wake action.
  for (const r of all<{ actions: string }>(app.db, "select actions from rules where temporary is not null and enabled = 1")) {
    for (const a of json<{ type?: string; target?: { resumeRunId?: unknown } }[]>(r.actions, [])) {
      if (a.type === "wake" && typeof a.target?.resumeRunId === "string") resumeRuns.add(a.target.resumeRunId);
    }
  }
  const followedRuns = new Set<string>();
  for (const r of all<{ value: string }>(app.db, "select value from kv where key like 'rule_follow:%'")) {
    const f = json<{ runId?: string; until?: string }>(r.value, {});
    if (f.runId && f.until && f.until > now()) followedRuns.add(f.runId);
  }
  for (const runId of followedRuns) {
    const r = one<{ output: string }>(app.db, "select output from runs where id = ?", runId);
    const id = r && json<{ sessionId?: string }>(r.output, {}).sessionId;
    if (id) resumeIds.add(id);
  }
  const kept = all<Pending & { input: string; output: string; status: string; lane: string | null }>(app.db,
    `select s.*,r.input,r.output,r.status,r.lane from session_cleanup s join runs r on r.id=s.run_id
     where s.ready=-1 and r.kind='agent' and r.status not in ('queued','running')`);
  for (const p of kept) {
    if (activeElsewhere(app, p)) continue;
    const input = json<Record<string, unknown>>(p.input, {});
    if (!input.rule || input.agentWorkId || input.meeting) continue;
    if (resumeIds.has(p.session_id) || (p.lane && lanes.has(p.lane))) continue;
    const currentId = json<{ sessionId?: string }>(p.output, {}).sessionId;
    if (p.run_id && (resumeRuns.has(p.run_id) || followedRuns.has(p.run_id)) && (!currentId || currentId === p.session_id)) continue;
    update(app, p, "ready = 1, retry_at = ?", now());
  }
  // A delegation that was confirmed or discarded will not resume its coder's or its reviewers'
  // sessions: without this they stay in the backend's history for good (every check keeps one).
  const coding = all<Pending & { rid: string; input: string }>(app.db,
    `select s.*, r.id rid, r.input from session_cleanup s join runs r on r.id = s.run_id
     where s.ready = -1 and r.kind = 'code' and r.status not in ('queued','running')`);
  const over = new Map<string, boolean>();
  for (const p of coding) {
    if (activeElsewhere(app, p) || resumeIds.has(p.session_id)) continue;
    const rootId = String(json<{ continueFrom?: string }>(p.input, {}).continueFrom ?? p.rid);
    if (!over.has(rootId)) {
      const root = one<{ output: string }>(app.db, "select output from runs where id = ?", rootId);
      const o = json<{ appliedAt?: string; discardedAt?: string }>(root?.output ?? "{}", {});
      over.set(rootId, !root || !!o.appliedAt || !!o.discardedAt);
    }
    if (over.get(rootId)) update(app, p, "ready = 1, retry_at = ?", now());
  }
  // Work handed to agents has no end of its own: its sessions go once nothing ran in it for two days.
  const weekAgo = new Date(Date.now() - RETAIN_IDLE_MS).toISOString();
  const working = new Set(active.map((r) => json<{ agentWorkId?: string }>(r.input, {}).agentWorkId).filter(Boolean));
  const idle = all<Pending & { input: string }>(app.db,
    `select s.*, r.input from session_cleanup s join runs r on r.id = s.run_id
     where s.ready = -1 and r.kind = 'agent' and r.status not in ('queued','running') and coalesce(r.finished_at, r.created_at) < ?`, weekAgo);
  for (const p of idle) {
    const workId = json<{ agentWorkId?: string }>(p.input, {}).agentWorkId;
    if (!workId || working.has(workId) || activeElsewhere(app, p) || resumeIds.has(p.session_id) || (p.run_id && resumeRuns.has(p.run_id))) continue;
    const last = one<{ at: string | null }>(app.db, "select max(coalesce(finished_at, created_at)) at from runs where json_extract(input, '$.agentWorkId') = ?", workId)?.at;
    if (last && last >= weekAgo) continue;
    update(app, p, "ready = 1, retry_at = ?", now());
  }
}

/** Recorded disposable sessions only; a live omem process retains ownership, including pool idle time. */
export async function recoverSessionCleanup(app: App, emit: (runId: string | null, e: AgentEvent) => void) {
  releaseRuleSessions(app);
  const pending = all<Pending>(app.db, "select * from session_cleanup where ready >= 0 and retry_at <= ? order by retry_at", now());
  let attempts = 0;
  for (const p of pending) {
    if (!p.ready && alive(p.owner_pid)) continue;
    if (attempts++ >= 20) break;
    // A local cleanup record may outlive its run after a library is overwritten from another device.
    const runId = p.run_id && one(app.db, "select id from runs where id = ?", p.run_id) ? p.run_id : null;
    await clean(app, p, e => emit(runId, e), true);
  }
  // Retained coding/chat sessions can also have disposable helpers after an interrupted turn.
  const retained = all<Pending>(app.db, `select s.* from session_cleanup s join runs r on r.id=s.run_id
    where s.ready=-1 and s.transport='acp' and r.status not in ('queued','running')`);
  for (const p of retained) {
    if (activeElsewhere(app, p)) continue;
    try { await cleanChildren(app, p, recordedProfile(app, p), e => emit(p.run_id, e)); }
    catch (e) { emit(p.run_id, { type: "status", text: `后端子会话清理失败，稍后重试：${(e as Error).message.slice(0, 160)}` }); }
  }
}

const workers = new WeakMap<App, { timer: NodeJS.Timeout; pending?: Promise<void> }>();
export function startSessionCleanup(app: App, emit: (runId: string | null, e: AgentEvent) => void) {
  if (workers.has(app)) return;
  const tick = () => {
    if (worker.pending) return;
    worker.pending = recoverSessionCleanup(app, emit)
      .catch(e => console.warn("[omem] 恢复后端会话清理失败：", (e as Error).message))
      .finally(() => { worker.pending = undefined; });
  };
  const worker = { timer: setInterval(tick, 60_000).unref(), pending: undefined as Promise<void> | undefined };
  workers.set(app, worker); tick();
}
export async function stopSessionCleanup(app: App) {
  const worker = workers.get(app);
  if (!worker) return;
  clearInterval(worker.timer); workers.delete(app); await worker.pending;
}
