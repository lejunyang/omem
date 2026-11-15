import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { HttpError, truncate } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { nodeId } from "../core/peers.ts";
import { gitAsync } from "../core/git.ts";
import { remoteKey } from "../core/repositories.ts";
import { getSpace, listSpaces, type Space } from "../core/spaces.ts";
import { roleNames, type RoleName } from "../core/config.ts";
import { cancelRun, createRun, getRun, registerHandler, setRunOutput, type RunContext, type RunStatus } from "../agents/runs.ts";
import { artifactInbox, artifactPath, artifactsByIds, attachPath } from "../agents/artifacts.ts";
import { validateExecution } from "../agents/execution.ts";
import { findAgentSpec, readSkill, skillUsable } from "../agents/specs.ts";
import { workDirOf } from "../agents/workspaces.ts";
import { resultSchema, type TrialReport } from "./schema.ts";
import { checkoutManaged, releaseManaged } from "./workspace.ts";
import { trialTask } from "./trials.ts";

/**
 * The other side of a trial handed to another device (remote.ts, docs/v2/studies.md §6): one of the
 * owner's own devices asks this one to run one trial. Only that, and only for the owner's token —
 * not a command line, not another person's server. This device finds its own checkout of the
 * repository by its remote address, puts the commit the owner's direction was confirmed on into a
 * workspace it manages (fetching once when it lacks the commit; the owner's checkout is never
 * reset), and runs the trial with its own AI and skills; the report and the evidence files go back
 * when asked for.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
export const peerTrialRequestSchema = z.object({
  from: z.object({ node: text(80), item: text(100), title: z.string().max(300), trial: text(100) }).strict(),
  trial: z.object({ id: text(100), object: text(1000), check: text(2000), prior: z.string().max(12000).optional(), previous: z.string().max(12000).optional() }).strict(),
  direction: z.object({ goal: text(500), approach: text(4000), note: z.string().max(4000), thirdParty: z.boolean() }).strict(),
  env: z.object({ name: text(100), note: z.string().max(12000), thirdParty: z.boolean() }).strict(),
  repos: z.array(z.object({ name: z.string().max(200), remotes: z.array(z.string().min(1).max(500)).min(1).max(20), commit: z.string().regex(/^[0-9a-f]{7,64}$/i) }).strict()).max(10),
  // Names of this device's own profile and skill (agents/specs.ts NAME), never a path.
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional(), skill: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional(), tier: z.enum(["strong", "standard", "cheap"]).optional(),
  minutes: z.number().int().min(1).max(24 * 60),
}).strict();
export type PeerTrialRequest = z.infer<typeof peerTrialRequestSchema>;
type Report = Pick<TrialReport, "result" | "summary" | "unsure"> & { findings: NonNullable<TrialReport["findings"]>; evidence: string[] };
export type PeerTrialResult = {
  node: string; status: RunStatus; minutes: number; error: string | null;
  ai: { profile: string; model?: string; effort?: string } | null;
  report: null | (Omit<Report, "evidence"> & { files: { name: string; size: number; truncated: boolean; data: string }[]; omitted: string[] });
};
type Input = { request: PeerTrialRequest; repos: { space: string; commit: string; remotes: string[] }[]; spaces: string[]; task?: string };

/** One evidence file sent back at most; text over it goes back cut, other files stay here. */
export const MAX_EVIDENCE_FILE = 2 * 1024 * 1024;
/** All evidence files of a trial sent back at most. */
export const MAX_EVIDENCE_TOTAL = 8 * 1024 * 1024;

async function remotesOf(root: string) {
  const r = await gitAsync(root, ["remote", "-v"], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.split(/\r?\n/).map((l) => l.split(/\s+/)).filter((p) => p[0] && p[1]).map(([name, url]) => ({ name, key: remoteKey(url) })) : [];
}
/** This device's checkout of a repository, recognized by a remote address in common (https / ssh / scp forms, `.git`, case). */
export async function findRepoByRemotes(app: App, keys: string[]): Promise<{ space: Space; remotes: string[] } | null> {
  const wanted = new Set(keys.map(remoteKey));
  for (const s of listSpaces(app).filter((s) => s.kind === "repo" && !!s.rootPath && existsSync(s.rootPath))) {
    const hit = (await remotesOf(s.rootPath!)).filter((x) => wanted.has(x.key));
    if (hit.length) return { space: s, remotes: [...new Set(hit.map((x) => x.name))] };
  }
  return null;
}

/** POST /api/peer/trial: check, then queue the trial's run here; the caller asks for the result by its id. */
export async function acceptPeerTrial(app: App, caller: string, body: unknown) {
  if (caller !== OWNER) throw new HttpError(403, "只接受本人自己设备派来的试验");
  const parsed = peerTrialRequestSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `试验的写法不对：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const req = parsed.data;
  // The environment's declaration is the owner's: samples' own scripts only where it says they may run.
  if (req.direction.thirdParty && !req.env.thirdParty) throw new HttpError(409, `这个方向要执行第三方样本的代码，执行环境「${req.env.name}」不允许`);
  const repos: Input["repos"] = [];
  for (const r of req.repos) {
    const found = await findRepoByRemotes(app, r.remotes);
    if (!found) throw Object.assign(new HttpError(409, `${nodeId(app)}上没有这个仓库（${r.name}）`), { code: "no-repo", repo: r.name });
    repos.push({ space: found.space.id, commit: r.commit, remotes: found.remotes });
  }
  const spaces = [...new Set(repos.map((r) => r.space))];
  const created = createRun(app, {
    kind: "peer-trial", spaceId: spaces[0] ?? "personal", title: truncate(`${req.from.title} · ${req.trial.object} × ${req.trial.check}（${req.from.node} 派来的试验）`, 120),
    input: { request: req, repos, spaces } satisfies Input,
    trigger: { via: "peer", by: { key: `user:${OWNER}`, name: "你" }, where: req.from.node, source: { kind: "peer", id: req.from.node, name: req.from.node } },
  });
  return { node: nodeId(app), runId: created.id };
}

function peerRun(app: App, id: string) {
  const r = one<{ id: string }>(app.db, "select id from runs where id=? and kind='peer-trial'", id);
  if (!r) throw new HttpError(404, `没有派来的试验运行 ${id}`);
  return getRun(app, id);
}

/** GET /api/peer/trial/:id: how the run stands; once it has ended, the report with its evidence files. */
export function peerTrialResult(app: App, caller: string, id: string): PeerTrialResult {
  if (caller !== OWNER) throw new HttpError(403, "只接受本人自己设备派来的试验");
  const r = peerRun(app, id);
  const end = r.finishedAt ? Date.parse(r.finishedAt) : Date.now();
  const minutes = r.startedAt ? Math.max(0, (end - Date.parse(r.startedAt)) / 60_000) : 0;
  const ended = ["done", "failed", "cancelled"].includes(r.status);
  const report = r.output.trialReport as Report | undefined;
  return { node: nodeId(app), status: r.status, minutes, error: r.error, ai: r.ai, report: ended && report ? { ...report, evidence: undefined, ...evidenceFiles(app, report.evidence) } as PeerTrialResult["report"] : null };
}
function evidenceFiles(app: App, ids: string[]) {
  const files: { name: string; size: number; truncated: boolean; data: string }[] = [], omitted: string[] = [];
  let total = 0;
  for (const a of artifactsByIds(app, ids)) {
    const path = artifactPath(app, a);
    if (a.kind === "site" || !existsSync(path)) { omitted.push(`${a.name} 是一个目录或已不在，没有带回`); continue; }
    const textual = a.kind === "text" || /^text\/|json/.test(a.mime);
    const room = Math.min(MAX_EVIDENCE_FILE, MAX_EVIDENCE_TOTAL - total);
    if (a.size > room && (!textual || room < 1024)) { omitted.push(`${a.name}（${(a.size / 1024 / 1024).toFixed(1)} MB）超过带回的上限，留在 ${nodeId(app)} 上`); continue; }
    let data = readFileSync(path);
    const truncated = data.length > room;
    if (truncated) data = Buffer.concat([data.subarray(0, room), Buffer.from(`\n\n[以下截断：原文件 ${(a.size / 1024 / 1024).toFixed(1)} MB，只带回前 ${(room / 1024 / 1024).toFixed(1)} MB]\n`)]);
    total += data.length;
    files.push({ name: a.name, size: a.size, truncated, data: data.toString("base64") });
  }
  return { files, omitted };
}

/** POST /api/peer/trial/:id/cancel: the owner's device stopped the trial (the flow stopped, the stage reopened, the budget ran out). */
export function cancelPeerTrialRun(app: App, caller: string, id: string) {
  if (caller !== OWNER) throw new HttpError(403, "只接受本人自己设备派来的试验");
  const r = peerRun(app, id);
  if (["queued", "running"].includes(r.status)) cancelRun(app, id);
  return { status: getRun(app, id).status };
}

/** trial_report in a trial sent here: kept with the run (files only: this device's src: ids do not open on the other one). */
export async function reportPeerTrial(app: App, runId: string, report: TrialReport, by: string) {
  const r = getRun(app, runId), input = r.input as Input;
  if (r.kind !== "peer-trial" || r.status !== "running") throw new HttpError(409, "这个试验已不是进行中的运行");
  if (report.trial !== input.request.trial.id) throw new HttpError(403, `这次运行只做试验 ${input.request.trial.id}`);
  const evidence: string[] = [];
  for (const ref of report.evidence ?? []) {
    if (ref.startsWith("src:")) throw new HttpError(400, "派来的试验证据只收 $OMEM_ARTIFACTS 里的文件，不收 src: 引用");
    const taken = await attachPath(app, runId, ref, [artifactInbox(app, runId)], { source: "agent", by });
    if (!taken.made.length || taken.skipped.length) throw new HttpError(400, `证据没有收下：${taken.skipped.join("；") || ref}`);
    evidence.push(...taken.made.map((a) => a.id));
  }
  const kept: Report = { result: resultSchema.parse(report.result), summary: report.summary, unsure: !!report.unsure, findings: report.findings ?? [], evidence };
  setRunOutput(app, runId, { trialReport: kept });
  return `已记下试验结果；${input.request.from.node} 会来取结果和证据。`;
}
export const isPeerTrialRun = (app: App, runId: string | null | undefined) => !!runId && !!one(app.db, "select 1 from runs where id=? and kind='peer-trial'", runId);

/** The commit each repository was confirmed on, in a workspace of this run's: fetched once from the matching remotes when missing. */
async function prepare(app: App, owner: string, repos: Input["repos"]) {
  const out: { space: string; dir: string; commit: string }[] = [];
  for (const r of repos) {
    const repo = getSpace(app, r.space), root = repo.rootPath!;
    const has = async () => (await gitAsync(root, ["cat-file", "-e", `${r.commit}^{commit}`], { timeoutMs: 10_000 })).ok;
    if (!(await has())) {
      for (const remote of r.remotes) {
        await gitAsync(root, ["fetch", "-q", remote], { timeoutMs: 180_000 });
        if (await has()) break;
      }
      if (!(await has())) throw new Error(`${repo.name} 里没有提交 ${r.commit.slice(0, 12)}，从 ${r.remotes.join("、")} 取过一次也没有`);
    }
    const wt = await checkoutManaged(app, owner, repo, r.commit);
    out.push({ space: r.space, dir: workDirOf(wt), commit: r.commit });
  }
  return out;
}

async function runPeerTrial(ctx: RunContext) {
  const { app } = ctx, r = ctx.run, input = r.input as Input, req = input.request;
  const blocked = (summary: string) => {
    ctx.output({ trialReport: { result: "blocked", summary, unsure: false, findings: [], evidence: [] } satisfies Report });
    return { text: summary };
  };
  const limit = AbortSignal.timeout(req.minutes * 60_000);
  try {
    let dirs: Awaited<ReturnType<typeof prepare>>;
    try { dirs = await prepare(app, r.id, input.repos); }
    catch (e) { return blocked(`无法在 ${nodeId(app)} 上准备试验工作区：${(e as Error).message}`); }
    const notes: string[] = [];
    const name = req.agent ?? "assistant";
    const builtin = (roleNames as readonly string[]).includes(name);
    const spec = builtin ? undefined : findAgentSpec(app, name);
    if (!builtin && (!spec || spec.status !== "active")) notes.push(`这台没有启用的 Agent 档案 ${name}，由主助手来做。`);
    let skill = "";
    if (req.skill) {
      try {
        const s = readSkill(app, req.skill);
        if (s.status === "active" && skillUsable(app, s)) skill = `\n\n## 这一轮的技能：${s.name}\n${s.body}`;
        else notes.push(`这台的技能 ${req.skill} 没有启用，照任务做。`);
      } catch { notes.push(`这台没有技能 ${req.skill}，照任务做。`); }
    }
    const pick = req.tier ? app.config.agents.tiers[req.tier] : undefined;
    const execution = pick ? validateExecution(app, { ...pick, source: "flow", reason: `${req.from.node} 派来的试验写了档位 ${req.tier}` }) : undefined;
    const task = trialTask({
      header: `## ${req.from.node} 上的课题派来的一个试验：${req.from.title}`,
      dir: req.direction, env: req.env,
      trial: { id: req.trial.id, object: req.trial.object, check: req.trial.check, prior: req.trial.prior, summary: req.trial.previous },
      extra: [
        `这个试验是本人的另一台设备 ${req.from.node} 派来的，在这台的工作区里做：结果和证据文件会送回那台。evidence 只收 $OMEM_ARTIFACTS 里的文件，不收 src: 引用；单个文件超过 ${MAX_EVIDENCE_FILE / 1024 / 1024} MB 的文本只带回开头，其他大文件不带回。`,
        `这个试验最多 ${req.minutes} 分钟，到了会被停下。`,
        dirs.length ? `## 试验工作区\n${dirs.map((d) => `${d.space}：${d.dir}（${d.commit}）`).join("\n")}` : "这个课题没有登记仓库。",
        ...notes,
      ],
    }) + skill;
    const { runRole } = await import("../agents/runner.ts");
    try {
      const result = await runRole(app, {
        role: builtin ? name as RoleName : "assistant", spec: spec?.status === "active" ? spec : undefined, execution, ownAI: !!req.tier && !execution,
        spaceId: input.spaces[0] ?? "personal", spaces: input.spaces.length ? input.spaces : undefined, cwd: dirs[0]?.dir, task, runId: r.id,
        signal: AbortSignal.any([ctx.signal, limit]), addTools: ["trial_report", "attach_artifact"],
        denyTools: ["read_ledger", "read_item", "read_run", "list_runs", "stage_report", "delegate_code", "study_push", "propose_directions", "record_finding", "close_direction"],
        artifacts: true, onEvent: (e) => ctx.event(e.type, e),
      });
      return { text: result.text, ai: result.ai, sessionId: result.sessionId };
    } catch (e) {
      if (!limit.aborted || ctx.signal.aborted) throw e;
      if (!getRun(app, r.id).output.trialReport) ctx.output({ trialReport: { result: "unclear", summary: `到了 ${req.minutes} 分钟的时间上限，试验停下了，没有交结果`, unsure: true, findings: [], evidence: [] } satisfies Report });
      return { text: "到了时间上限" };
    }
  } finally {
    await releaseManaged(app, r.id).catch((e: Error) => console.warn(`[omem] 派来的试验工作区清理失败：${e.message}`));
  }
}
registerHandler("peer-trial", runPeerTrial);

export function registerPeerTrialRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  server.post("/api/peer/trial", async (req, reply) => {
    try { return await acceptPeerTrial(app, who(req), req.body); }
    catch (e) {
      const code = (e as { code?: string; repo?: string }).code;
      if (code === "no-repo") return reply.status(409).send({ error: (e as Error).message, code, repo: (e as { repo?: string }).repo });
      throw e;
    }
  });
  server.get("/api/peer/trial/:id", async (req) => peerTrialResult(app, who(req), (req.params as { id: string }).id));
  server.post("/api/peer/trial/:id/cancel", async (req) => cancelPeerTrialRun(app, who(req), (req.params as { id: string }).id));
}
