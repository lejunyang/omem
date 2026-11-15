import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { HttpError, json, now } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { describeStage } from "../flows/definitions.ts";
import { answerAsk, createAsk, getAsk, registerAskHandler } from "../agents/asks.ts";
import { artifactInbox, artifactsByIds, attachPath } from "../agents/artifacts.ts";
import { getRun } from "../agents/runs.ts";
import { changeStage, getStage, itemFlow, type FlowActor } from "../flows/store.ts";
import { studyOperation } from "../flows/engine.ts";
import { assertOwner, confirmDirection, direction, findings, idleRounds, saveProposals, trial, trials, directions, type PlannedTrial, type Trial } from "./store.ts";
import { coverage } from "./materials.ts";
import type { Proposal, TrialReport } from "./schema.ts";
import { studyScope } from "./scope.ts";
import { checkDirectionChoice, resolveEnv, thirdPartyReason } from "./envs.ts";
import { captureBaseline } from "./workspace.ts";
import { studyPushes } from "./push.ts";
import { findingFix } from "./fix.ts";

/** Resolve the stage from the host's flow copy, never from the caller's task text. */
export function runStage(app: App, runId: string) {
  const r = getRun(app, runId);
  const f = typeof r.input.itemId === "string" ? itemFlow(app, r.input.itemId) : null;
  return { r, f, d: f?.definition.stages.find((d) => d.id === r.input.stageId) };
}
export function assertLedgerReader(app: App, runId: string | null) {
  if (!runId) return;
  const { r, d } = runStage(app, runId);
  if (d?.tools?.includes("propose_directions") || Array.isArray(r.input.stageTools) && r.input.stageTools.includes("propose_directions")) throw new HttpError(403, "定方向阶段不能读取台账；提交以后由宿主对账");
}
export function proposeDirections(app: App, p: Proposal, by: FlowActor) {
  return studyOperation(app, p.item, async () => {
    assertOwner(app, p.item, by.userId ?? "owner");
    if (!by.runId) throw new HttpError(403, "只能由定方向阶段的运行交提案");
    const { r, f, d } = runStage(app, by.runId);
    if (r.kind !== "flow-stage" || !f || f.endedAt || f.itemId !== p.item || f.startedAt !== r.input.flowStartedAt || !d?.tools?.includes("propose_directions")) throw new HttpError(403, "这不是定方向阶段的运行");
    const s = getStage(app, p.item, d.id);
    if (s.state !== "doing" || s.control.runId !== r.id || s.control.reported) throw new HttpError(409, "这次定方向已结束或已交提案");
    const proposed = saveProposals(app, { ...p, directions: p.directions.map((d) => ({ ...d, env: resolveEnv(app, p.item, d.env ?? "").id })) }, f.round);
    const text = proposed.length ? [`这一轮提了 ${proposed.length} 个方向，选一个：`, ...proposed.map((d, i) => {
      const env = resolveEnv(app, p.item, d.env), removed = json<{ object: string; check: string; prior: string }[]>(d.removed, []);
      return [`**${i + 1}. ${d.goal}**`, `- 做法：${d.approach}`, `- 验收：${d.acceptance}`, `- 在哪跑：${env.name}`,
        d.third_party ? `- ${env.thirdParty ? "这个方向要执行第三方样本的代码，所选环境允许执行。" : thirdPartyReason}` : "",
        `- ${json<unknown[]>(d.plan, []).length} 个试验，${removed.length} 个以前做过并被去掉${removed.length ? `：${removed.map((t) => `${t.object} × ${t.check}（${t.prior}）`).join("；")}` : ""}`,
        `- 预计花费：${d.estimate || "未估算"}`].filter(Boolean).join("\n");
    })].join("\n\n") : `这一轮没有提出方向\n${p.note || "没有值得做的方向"}`;
    const budgets = f.definition.stages.filter((d) => typeof d.by === "object" && "object" in d.by && d.by.object === "trials").map((d) => {
      const words = describeStage(d);
      return `「${d.name}」这一段：${[words.budget, words.ai].filter(Boolean).join("；") || "没有设预算"}。要改，在事项页这一段的“预算”里改。`;
    }).join("\n");
    const ask = createAsk(app, { runId: null, userId: getItem(app, p.item).userId, question: [text, p.note && proposed.length ? p.note.trim() : "", budgets, proposed.length ? "回答时可以附一句要改的地方。" : ""].filter(Boolean).join("\n\n"), options: proposed.length ? [...proposed.map((d) => ({ label: d.goal })), { label: "这一轮不跑" }] : [{ label: "知道了" }], allowText: true, context: { handler: "study-plan", itemId: p.item, stageId: d.id, startedAt: f.startedAt, round: f.round, directions: proposed.map((d) => d.id) } });
    changeStage(app, p.item, d.id, "doing", { askId: ask.id, waitingOn: "owner", control: { ...s.control, reported: true } }, by, `提案已交，等本人选方向${p.note?.trim() ? `。${p.note.trim()}` : ""}`);
    return `提案已交，等本人选择：${ask.id}`;
  });
}
registerAskHandler("study-plan", async (app, ask, ctx) => {
  const itemId = String(ctx.itemId), stageId = String(ctx.stageId);
  await studyOperation(app, itemId, async () => {
    const f = itemFlow(app, itemId), s = getStage(app, itemId, stageId), item = getItem(app, itemId);
    if (!f || f.endedAt || f.startedAt !== ctx.startedAt || f.round !== ctx.round || s.askId !== ask.id || ask.userId !== item.userId || ask.answeredBy !== item.userId) return;
    if (ask.choice === null) {
      const again = createAsk(app, { runId: null, userId: item.userId, question: ask.question, options: ask.options, allowText: true, context: { ...ctx, handler: "study-plan" } });
      changeStage(app, itemId, stageId, "doing", { askId: again.id }, { actor: "host" }, "请先选择方向或这一轮不跑，可另附改动要求");
      return;
    }
    const ids = ctx.directions as string[], id = ids[ask.choice];
    const label = ask.options[ask.choice ?? -1]?.label ?? "";
    const note = (ask.answer ?? "").startsWith(label) ? (ask.answer ?? "").slice(label.length).replace(/^[：:，,\s]+/, "") : ask.answer ?? "";
    if (id) {
      const allowCode = checkDirectionChoice(app, itemId, direction(app, id), typeof ctx.allowCode === "boolean" ? ctx.allowCode : undefined);
      const baseline = await captureBaseline(app, itemId);
      confirmDirection(app, id, note, baseline, allowCode);
    }
    for (const other of ids.filter((x) => x !== id)) run(app.db, "update study_directions set state='dropped',conclusion='本轮未选',updated_at=? where id=? and state='proposed'", now(), other);
    changeStage(app, itemId, stageId, "done", { askId: null, waitingOn: null, control: { ...s.control, reported: true } }, { actor: "owner", userId: item.userId }, id ? `本人确认方向：${direction(app, id).goal}${note ? `；${note}` : ""}` : "本人确认这一轮不跑");
    if (!id) {
      const start = f.definition.stages.findIndex((d) => d.id === stageId);
      for (const d of f.definition.stages.slice(start + 1)) changeStage(app, itemId, d.id, "skipped", { control: { reported: true } }, { actor: "owner" }, ids.length ? "本人选择这一轮不跑" : "这一轮没有提出方向，本人已知晓");
    }
    run(app.db, "update item_flows set auto_streak=0,updated_at=? where item_id=?", now(), itemId);
  });
}, (app, ask, ctx, by, answer) => {
  const item = getItem(app, String(ctx.itemId)), f = itemFlow(app, item.id);
  if (ask.userId !== item.userId || by !== item.userId) throw new HttpError(403, "方向只能由事项本人选择");
  if (!f || f.endedAt || f.startedAt !== ctx.startedAt || f.round !== ctx.round || getStage(app, item.id, String(ctx.stageId)).askId !== ask.id) throw new HttpError(409, "提案已失效");
  const id = answer.choice === null ? undefined : (ctx.directions as string[])[answer.choice];
  if (id) checkDirectionChoice(app, item.id, direction(app, id), typeof ctx.allowCode === "boolean" ? ctx.allowCode : undefined);
});

export async function reportTrial(app: App, report: TrialReport, by: FlowActor) {
  const t = trial(app, report.trial);
  assertOwner(app, t.item_id, by.userId ?? "owner");
  if (!by.runId || t.run_id !== by.runId) throw new HttpError(403, "只能由这个试验自己的运行交结果");
  const { r, f, d } = runStage(app, by.runId);
  const s = d && f ? getStage(app, f.itemId, d.id) : null;
  if (r.kind !== "study-trial" || !f || f.endedAt || f.startedAt !== r.input.flowStartedAt || !s || s.state !== "doing" || s.control.runId !== by.runId || t.state !== "running") throw new HttpError(409, "这个试验已不是当前的运行");
  const evidence: string[] = [];
  for (const ref of report.evidence ?? []) {
    if (ref.startsWith("src:")) { evidence.push(ref); continue; }
    const taken = await attachPath(app, by.runId, ref, [artifactInbox(app, by.runId)], { source: "agent", by: by.actor });
    if (!taken.made.length || taken.skipped.length) throw new HttpError(400, `证据没有收下：${taken.skipped.join("；") || ref}`);
    evidence.push(...taken.made.map((a) => a.id));
  }
  // Revalidate after copying artifacts: an owner action may have cancelled this run meanwhile.
  await studyOperation(app, t.item_id, async () => {
    if (trial(app, t.id).state !== "running" || itemFlow(app, t.item_id)?.endedAt || getStage(app, t.item_id, d!.id).control.runId !== by.runId) throw new HttpError(409, "试验已结束或被取消");
    run(app.db, "update study_trials set state='reported',result=?,summary=?,evidence=?,findings=?,unsure=?,updated_at=? where id=?", report.result, report.summary, JSON.stringify(evidence), JSON.stringify(report.findings ?? []), report.unsure ? 1 : 0, now(), t.id);
  });
  return "已记下试验结果；候选发现由小结归并。";
}
export function readLedger(app: App, input: { item: string; direction?: string; object?: string; result?: string; round?: number; limit?: number }, runId: string | null) {
  assertLedgerReader(app, runId);
  const selected = trials(app, input.item).filter((t) => (!input.direction || t.direction_id === input.direction) && (!input.object || t.object.includes(input.object)) && (!input.result || t.result === input.result) && (!input.round || t.round === input.round)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, input.limit ?? 200);
  return ["## 试验", ...selected.map((t) => `${t.id} 第 ${t.round} 轮 ${t.object} × ${t.check}（${t.state}/${t.result ?? "未交"}${t.peer ? `，在设备 ${t.peer} 上跑` : ""}）\n${t.summary}\n证据：${t.evidence}\n候选发现：${t.findings}`), "## 已有发现", ...findings(app, input.item).map((f) => {
    const fix = findingFix(app, f);
    return `${f.id}（${f.state}）${f.title}\n${f.repro}\n本人判定原因：${f.state_reason || "未写"}\n依据：${f.trials}${f.work_id ? `\n已有改动：${fix?.status ?? "交办记录不可用"}；重跑：${fix?.verified ?? "未验证"}；试验：${fix?.reruns.join("、") || "无"}` : ""}`;
  })].join("\n\n");
}
/** The owner picks this round's direction on the item page (null: no run this round): the same answer as on the card. */
export async function chooseDirection(app: App, itemId: string, directionId: string | null, note: string | undefined, by: string, allowCode?: boolean) {
  assertOwner(app, itemId, by);
  if (allowCode && !studyScope(app, itemId).allowCode) throw new HttpError(409, "先在课题范围里打开可以改代码");
  const f = itemFlow(app, itemId);
  const d = f && !f.endedAt ? f.definition.stages.find((d) => d.tools?.includes("propose_directions")) : undefined;
  const askId = d ? getStage(app, itemId, d.id).askId : null;
  const ask = askId ? getAsk(app, askId) : null;
  if (!ask || ask.status !== "pending" || ask.handler !== "study-plan") throw new HttpError(409, "现在没有等你选的方向");
  const ids = (JSON.parse(one<{ context: string | null }>(app.db, "select context from asks where id=?", ask.id)?.context ?? "{}") as { directions?: string[] }).directions ?? [];
  const choice = directionId === null ? ask.options.length - 1 : ids.indexOf(directionId);
  if (choice < 0) throw new HttpError(404, "这个方向不在这一轮的提案里");
  if (directionId) {
    checkDirectionChoice(app, itemId, direction(app, directionId), allowCode);
    run(app.db, "update asks set context=json_set(context,'$.allowCode',json(?)) where id=?", JSON.stringify(allowCode ?? studyScope(app, itemId).allowCode), ask.id);
  }
  await answerAsk(app, ask.id, { choice, text: note?.trim() || undefined, by });
}
/** The ledger as the item page shows it: directions with how their trials went, the latest trials, findings with the trials they rest on. */
export function studyView(app: App, itemId: string) {
  const item = getItem(app, itemId), history = trials(app, itemId);
  const present = (t: Trial) => {
    const evidence = json<string[]>(t.evidence, []);
    return { id: t.id, directionId: t.direction_id, round: t.round, seq: t.seq, object: t.object, check: t.check, env: t.env, state: t.state, result: t.result, summary: t.summary,
      evidence, artifacts: artifactsByIds(app, evidence.filter((r) => !r.startsWith("src:"))), findings: json<{ kind: string; title: string; repro: string }[]>(t.findings, []),
      fixOf: t.fix_of, workId: t.work_id, commits: json<Record<string, string>>(t.commits, {}), runId: t.run_id, peer: t.peer, peerRunId: t.peer_run, attempts: t.attempts, prior: t.prior, unsure: !!t.unsure, escalated: !!t.escalated, updatedAt: t.updated_at };
  };
  return {
    scope: studyScope(app, itemId), pushes: studyPushes(app, itemId),
    directions: directions(app, itemId).map((d) => {
      const own = history.filter((t) => t.direction_id === d.id);
      return { id: d.id, round: d.round, goal: d.goal, approach: d.approach, acceptance: d.acceptance, env: d.env, estimate: d.estimate, state: d.state, conclusion: d.conclusion, note: d.note,
        allowCode: !!d.allow_code, thirdParty: !!d.third_party, baseline: json<Record<string, string>>(d.baseline, {}), plan: json<PlannedTrial[]>(d.plan, []), removed: json<(PlannedTrial & { prior: string })[]>(d.removed, []),
        counts: Object.fromEntries(["queued", "running", "skipped", "passed", "failed", "blocked", "unclear"].map((key) => [key, own.filter((t) => t.state === key || t.result === key).length])),
        createdAt: d.created_at, updatedAt: d.updated_at };
    }),
    trials: [...history].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)).slice(0, 200).map(present),
    findings: findings(app, itemId).map((f) => ({ id: f.id, kind: f.kind, title: f.title, repro: f.repro, state: f.state, stateReason: f.state_reason, sameAs: f.same_as, createdAt: f.created_at, updatedAt: f.updated_at,
      fix: findingFix(app, f), trials: json<string[]>(f.trials, []).flatMap((id) => { const t = history.find((t) => t.id === id); return t ? [present(t)] : []; }) })),
    coverage: coverage(app, item), idleRounds: idleRounds(app, itemId),
  };
}
