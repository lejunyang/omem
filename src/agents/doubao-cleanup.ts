import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import { deleteDoubaoSession, doubaoAppFor, doubaoApps, doubaoSessionStatus, doubaoTokenExists } from "./doubao.ts";
import type { AgentEvent } from "./types.ts";

type Pending = {
  session_id: string;
  transport: string;
  app_id: string | null;
  run_id: string | null;
  owner_pid: number;
  ready: number;
  retry_at: string;
};
type Emit = (e: AgentEvent) => void;
const busy = new Set<string>();

/** Persist as soon as the backend reports an id, before a restart can lose the finally block. */
export function queueDoubaoCleanup(app: App, sessionId: string, transport: string, appId?: string | null, runId?: string | null) {
  run(app.db, `insert into doubao_session_cleanup(session_id,transport,app_id,run_id,owner_pid,retry_at) values(?,?,?,?,?,?)
    on conflict(session_id) do update set app_id = coalesce(doubao_session_cleanup.app_id, excluded.app_id), run_id = coalesce(doubao_session_cleanup.run_id, excluded.run_id)`, sessionId, transport, appId ?? null, runId ?? null, process.pid, now());
}

/** A turn is done (or its session was explicitly replaced); failures remain queued for retry. */
export async function finishDoubaoCleanup(app: App, sessionId: string, emit: Emit) {
  run(app.db, "update doubao_session_cleanup set ready = 1 where session_id = ?", sessionId);
  const p = one<Pending>(app.db, "select * from doubao_session_cleanup where session_id = ?", sessionId);
  if (p) await clean(app, p, emit, false);
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function clean(app: App, p: Pending, emit: Emit, recovering: boolean) {
  const key = `${app.home}:${p.session_id}`;
  if (busy.has(key)) return;
  busy.add(key);
  // Delay both failed attempts and still-running cloud tasks; the next sweep tries again.
  run(app.db, "update doubao_session_cleanup set retry_at = ? where session_id = ?", new Date(Date.now() + 60_000).toISOString(), p.session_id);
  try {
    if (!doubaoTokenExists(app.home)) throw new Error("豆包 OpenAPI 没有在这台机器上授权，会话留在豆包历史里（omem doubao login 后重试）");
    const apps = await doubaoApps(app.home, app.config);
    const da = p.app_id ? apps.find(a => a.appId === p.app_id) : doubaoAppFor(app.home, { env: {} }, apps);
    if (!da) throw new Error("找不到创建时选用的豆包应用，等待应用恢复后重试");
    if (!p.app_id) run(app.db, "update doubao_session_cleanup set app_id = ? where session_id = ?", da.appId, p.session_id);
    if (recovering) {
      const status = await doubaoSessionStatus(app.home, da, p.session_id);
      if (status !== null && status !== "idle") return;
      if (status !== null) await deleteDoubaoSession(app.home, da, p.session_id);
    } else await deleteDoubaoSession(app.home, da, p.session_id);
    run(app.db, "delete from doubao_session_cleanup where session_id = ?", p.session_id);
    emit({ type: "status", text: `已经通过应用 ${da.appId} 删除豆包会话 ${p.session_id}${recovering ? "（恢复待清理会话）" : ""}${p.transport === "doubao-cli" ? "（豆包 CLI 登录的若是别的账号，它的历史里仍会留着）" : ""}` });
  } catch (e) {
    emit({ type: "status", text: `豆包会话清理失败，稍后重试：${(e as Error).message.slice(0, 160)}` });
  } finally {
    busy.delete(key);
  }
}

/** Only recorded disposable sessions; other live omem processes keep ownership of their turns. */
export async function recoverDoubaoCleanup(app: App, emit: (runId: string | null, e: AgentEvent) => void) {
  const pending = all<Pending>(app.db, "select * from doubao_session_cleanup where retry_at <= ? order by retry_at", now());
  let attempts = 0;
  for (const p of pending) {
    if (!p.ready && alive(p.owner_pid)) continue;
    if (attempts++ >= 20) break;
    await clean(app, p, e => emit(p.run_id, e), true);
  }
}

const workers = new WeakMap<App, { timer: NodeJS.Timeout; pending?: Promise<void> }>();

export function startDoubaoCleanup(app: App, emit: (runId: string | null, e: AgentEvent) => void) {
  if (workers.has(app)) return;
  const tick = () => {
    if (worker.pending) return;
    worker.pending = recoverDoubaoCleanup(app, emit)
      .catch(e => console.warn("[omem] 恢复豆包会话清理失败：", (e as Error).message))
      .finally(() => { worker.pending = undefined; });
  };
  const worker = { timer: setInterval(tick, 60_000).unref(), pending: undefined as Promise<void> | undefined };
  workers.set(app, worker);
  tick();
}

export async function stopDoubaoCleanup(app: App) {
  const worker = workers.get(app);
  if (!worker) return;
  clearInterval(worker.timer);
  workers.delete(app);
  await worker.pending;
}
