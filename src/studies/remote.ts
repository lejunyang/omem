import { OWNER } from "../core/users.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { json, now, truncate } from "../core/util.ts";
import { findPeer, nodeId, peerFetch } from "../core/peers.ts";
import { gitAsync } from "../core/git.ts";
import { remoteKey } from "../core/repositories.ts";
import { getSpace } from "../core/spaces.ts";
import { userBy } from "../core/run-trigger.ts";
import { createRun, setRunOutput } from "../agents/runs.ts";
import { artifactInbox, collectInbox } from "../agents/artifacts.ts";
import type { Item } from "../items/store.ts";
import type { FlowStage } from "../flows/definitions.ts";
import type { ItemFlow } from "../flows/store.ts";
import { direction, type Trial } from "./store.ts";
import { checkDirectionChoice, type StudyEnv } from "./envs.ts";
import { studyScope } from "./scope.ts";
import type { PeerTrialRequest, PeerTrialResult } from "./remote-host.ts";

/**
 * A trial handed to another of the owner's devices (docs/v2/studies.md §6): this side sends what to
 * do and on which commit (POST /api/peer/trial, the run's id comes back at once), then the trials
 * stage's own tick asks for the result (GET /api/peer/trial/:id) until the run there has ended, and
 * writes the report and its evidence files into the ledger here. Only the owner's devices accept
 * (the owner's token); the other device checks again on its side (remote-host.ts).
 */

/** The other device not answering this long while a trial is out: the attempt is lost. */
export const PEER_LOST_MS = 60 * 60_000;
/** The one retry of a trial whose attempt failed on the device waits this long. */
export const PEER_RETRY_MS = 10 * 60_000;
/** A trial's time on the device when the stage sets no minutes. */
export const PEER_DEFAULT_MINUTES = 240;

type Reply<T> = { status: number; data: T & { error?: string; code?: string; repo?: string } };
/** One request to the device: a status and a body; only a connection that fails throws. */
async function call<T>(app: App, peer: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<Reply<T>> {
  const res = await peerFetch(app, peer, path, body === undefined ? { timeoutMs } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, timeoutMs });
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  return { status: res.status, data: data as Reply<T>["data"] };
}

/** The remotes of a checkout, normalized (`remoteKey`): what the other device recognizes its own checkout of the repository by. */
export async function remotesOf(root: string) {
  const r = await gitAsync(root, ["remote", "-v"], { timeoutMs: 10_000 });
  return r.ok ? [...new Set(r.stdout.split(/\r?\n/).map((l) => l.split(/\s+/)[1]).filter(Boolean).map(remoteKey))] : [];
}

export type Dispatch = { ok: true; run: string } | { ok: false; retry: boolean; reason: string };

/** Send a trial to the device its environment names; on success the trial is running there. */
export async function dispatchPeerTrial(app: App, item: Item, f: ItemFlow, d: FlowStage, t: Trial, env: StudyEnv, usedMinutes: number): Promise<Dispatch> {
  if (item.userId !== OWNER) return { ok: false, retry: false, reason: "设备课题试验只支持本人的账号，请为成员选择本机环境" };
  const peer = env.peer!;
  const dir = direction(app, t.direction_id);
  if (!findPeer(app, peer)) return { ok: false, retry: false, reason: `执行环境「${env.name}」的设备 ${peer} 已不在配对的设备里` };
  try { checkDirectionChoice(app, item.id, dir); } catch (e) { return { ok: false, retry: false, reason: (e as Error).message }; }
  const baseline = json<Record<string, string>>(dir.baseline, {});
  const repos: PeerTrialRequest["repos"] = [];
  for (const r of studyScope(app, item.id).repos) {
    const root = getSpace(app, r.id).rootPath, commit = baseline[r.id];
    if (!root || !commit) return { ok: false, retry: false, reason: `${r.name} 没有确认方向时的基线提交；请重新定方向` };
    const remotes = await remotesOf(root);
    if (!remotes.length) return { ok: false, retry: false, reason: `${r.name} 没有配置远端地址，${peer} 认不出它是哪个仓库` };
    repos.push({ name: r.name, remotes, commit });
  }
  const by = typeof d.by === "object" && "object" in d.by ? d.by as { agent?: string; skill?: string } : {};
  const tier = env.ai ?? d.ai;
  const minutes = Math.max(1, Math.floor(d.budget?.minutes !== undefined ? d.budget.minutes - usedMinutes : PEER_DEFAULT_MINUTES));
  const body: PeerTrialRequest = {
    from: { node: nodeId(app), item: item.id, title: truncate(item.title, 200), trial: t.id },
    trial: { id: t.id, object: t.object, check: t.check, ...(t.prior ? { prior: t.prior.slice(0, 12000) } : {}), ...(t.summary ? { previous: t.summary.slice(0, 12000) } : {}) },
    direction: { goal: dir.goal, approach: dir.approach, note: dir.note.slice(0, 4000), thirdParty: !!dir.third_party },
    env: { name: env.name, note: env.note, thirdParty: env.thirdParty },
    repos, ...(by.agent ? { agent: by.agent } : {}), ...(by.skill ? { skill: by.skill } : {}), ...(typeof tier === "string" ? { tier } : {}), minutes: Math.min(minutes, 24 * 60),
  };
  let reply: Reply<{ runId?: string }>;
  try { reply = await call<{ runId?: string }>(app, peer, "/api/peer/trial", body); }
  catch (e) { return { ok: false, retry: true, reason: `连不上 ${peer}：${(e as Error).message}` }; }
  if (reply.status >= 500) return { ok: false, retry: true, reason: `${peer} 出错：${reply.data.error ?? reply.status}` };
  if (reply.status === 404 && !reply.data.code) return { ok: false, retry: false, reason: `${peer} 上的 omem 还不能接受试验，先更新它` };
  if (reply.data.code === "no-repo") return { ok: false, retry: false, reason: `${peer}上没有这个仓库（${reply.data.repo}）` };
  if (reply.status >= 400 || !reply.data.runId) return { ok: false, retry: false, reason: `${peer} 没有接受这个试验：${reply.data.error ?? reply.status}` };
  const at = now();
  run(app.db, "update study_trials set state='running',result=null,run_id=null,peer=?,peer_run=?,peer_seen=?,round=?,attempts=attempts+1,unsure=0,commits=?,updated_at=? where id=?",
    peer, reply.data.runId, at, f.round, JSON.stringify(baseline), at, t.id);
  run(app.db, "update study_directions set state='active',updated_at=? where id=?", at, dir.id);
  return { ok: true, run: reply.data.runId };
}

export type PeerCheck =
  | { state: "live"; minutes: number }
  | { state: "quiet" }
  | { state: "lost"; reason: string }
  | { state: "failed"; minutes: number; reason: string }
  | { state: "settled"; minutes: number; result: string };

/**
 * Where a trial out on a device stands. A report that came back is written into the ledger here
 * (settled); a run there that ended without one, or a device silent for PEER_LOST_MS, is a failed attempt.
 */
export async function checkPeerTrial(app: App, item: Item, f: ItemFlow, d: FlowStage, t: Trial, at: Date): Promise<PeerCheck> {
  const peer = t.peer!, id = t.peer_run!;
  let reply: Reply<PeerTrialResult> | null = null;
  try { reply = await call<PeerTrialResult>(app, peer, `/api/peer/trial/${encodeURIComponent(id)}`, undefined, 120_000); } catch { reply = null; }
  if (!reply || reply.status >= 500) {
    const seen = Date.parse(t.peer_seen ?? t.updated_at);
    return at.getTime() - seen >= PEER_LOST_MS ? { state: "lost", reason: `连不上 ${peer} 超过 ${Math.round(PEER_LOST_MS / 60_000)} 分钟，不知道它那边的运行 ${id} 怎样了` } : { state: "quiet" };
  }
  if (reply.status >= 400) return { state: "failed", minutes: 0, reason: `${peer} 找不到运行 ${id}：${reply.data.error ?? reply.status}` };
  run(app.db, "update study_trials set peer_seen=? where id=?", at.toISOString(), t.id);
  const r = reply.data;
  if (["queued", "running"].includes(r.status)) return { state: "live", minutes: r.minutes };
  if (!r.report) return { state: "failed", minutes: r.minutes, reason: r.status === "done" ? `${peer} 上的运行结束了，没有交结果` : `${peer} 上的运行${r.status === "cancelled" ? "被取消了" : `出错：${r.error ?? "没有说明"}`}` };
  await settle(app, item, f, d, t, r);
  return { state: "settled", minutes: r.minutes, result: r.report.result };
}

/** The report that came back, with its files, into the ledger: a run here holds them (marked as having run on the device). */
async function settle(app: App, item: Item, f: ItemFlow, d: FlowStage, t: Trial, r: PeerTrialResult) {
  const peer = t.peer!, report = r.report!;
  const rec = createRun(app, {
    kind: "study-trial", spaceId: item.spaceId, userId: item.userId, title: `${item.title} · ${t.object} × ${t.check}（在 ${peer} 上）`,
    input: { itemId: item.id, flowId: f.id, flowStartedAt: f.startedAt, stageId: d.id, round: f.round, trialId: t.id, peer: { node: peer, run: t.peer_run }, spaces: [item.spaceId, ...studyScope(app, item.id).repos.map((x) => x.id)], task: `这个试验派给了设备 ${peer}，在那里的运行 ${t.peer_run} 里跑完。\n对象：${t.object}\n要检查的事：${t.check}` },
    trigger: { via: "flow", source: { kind: "flow", id: f.id, name: f.definition.name }, by: userBy(app, item.userId), where: d.name },
  });
  // Ended already: the worker must never pick it up (this happens before any await, as peer-agent.ts does).
  const ai = r.ai ? { ...r.ai, profile: `peer:${peer}:${r.ai.profile}` } : { profile: `peer:${peer}` };
  const started = new Date(Date.now() - r.minutes * 60_000).toISOString();
  run(app.db, "update runs set status='done',started_at=?,finished_at=?,ai=?,profile_id=? where id=? and status='queued'", started, now(), JSON.stringify(ai), ai.profile, rec.id);
  const { taken, notes } = await collectPeerEvidence(app, rec.id, peer, report);
  const summary = [report.summary, notes.length ? `证据：${notes.join("；")}` : ""].filter(Boolean).join("\n\n");
  setRunOutput(app, rec.id, { text: summary, peerTrial: { node: peer, run: t.peer_run, status: r.status } });
  run(app.db, "update study_trials set state='reported',result=?,summary=?,evidence=?,findings=?,unsure=?,run_id=?,updated_at=? where id=?",
    report.result, summary, JSON.stringify(taken.made.map((a) => a.id)), JSON.stringify(report.findings), report.unsure ? 1 : 0, rec.id, now(), t.id);
  app.emit({ type: "run", runId: rec.id, status: "done" });
}

/** Tell the device to stop a trial's run there. Best effort: a device that does not answer keeps it until its own time limit. */
export async function cancelPeerTrial(app: App, t: Pick<Trial, "peer" | "peer_run">) {
  if (!t.peer || !t.peer_run) return false;
  try { return (await call(app, t.peer, `/api/peer/trial/${encodeURIComponent(t.peer_run)}/cancel`, {}, 8000)).status < 300; }
  catch { return false; }
}

export async function collectPeerEvidence(app: App, runId: string, peer: string, report: Pick<NonNullable<PeerTrialResult["report"]>, "files" | "omitted">) {
  const notes = [...report.omitted];
  const inbox = artifactInbox(app, runId), names = new Set<string>();
  for (const file of report.files) {
    let name = file.name.replace(/^.*[\\/]/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "") || "evidence";
    while (names.has(name)) name = `_${name}`;
    names.add(name);
    writeFileSync(join(inbox, name), Buffer.from(file.data, "base64"));
    if (file.truncated) notes.push(`${file.name} 原来 ${(file.size / 1024 / 1024).toFixed(1)} MB，只带回开头`);
  }
  const taken = await collectInbox(app, runId, { source: "agent", by: `peer:${peer}` });
  notes.push(...taken.skipped);
  return { taken, notes };
}
