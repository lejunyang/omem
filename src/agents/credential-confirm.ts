import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER, userName } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { cancelAsk, conversationOfRun, createAsk, registerAskHandler } from "./asks.ts";
import { signalDecision, waitDecision } from "./command-gate.ts";
import { rootRun } from "./progress-runs.ts";
import { addRunEvent } from "./runs.ts";
import { findThread } from "./threads.ts";

const handler = "credential-confirm";
const timeout = 600_000;
const options = ["这一次可以", "这次任务里都可以", "不行"].map(label => ({ label }));

registerAskHandler(handler, async (_app, ask) => { signalDecision(ask); }, (_app, ask, context, by, answer) => {
  if (by !== ask.userId) throw new HttpError(403, "只有持有人能回答");
  if (String(context.expiresAt) <= now()) throw new HttpError(409, "确认已过期");
  if (answer.choice === null) throw new HttpError(400, "请选择是否同意");
});

export function expireCredentialAsks(app: App) {
  for (const { id } of all<{id: string}>(app.db, `select id from asks where status='pending'
    and json_extract(context,'$.handler')='credential-confirm' and json_extract(context,'$.expiresAt')<=? limit 200`, now())) {
    cancelAsk(app, id, "持有人没同意");
  }
}

export async function confirmCredential(app: App, runId: string, requester: string, holder: string, kind: string,
  resource: string, line: string, signal: AbortSignal) {
  const root = rootRun(app, runId, { user: OWNER }) ?? runId;
  const scope = [root, requester, holder, kind, resource];
  if (one(app.db, "select 1 from credential_run_grants where root=? and requester=? and holder=? and kind=? and resource=?", ...scope)) return true;
  const conversation = conversationOfRun(app, runId) ?? conversationOfRun(app, root);
  const thread = conversation ? findThread(app, conversation) : null;
  const title = one<{title: string}>(app.db, "select title from runs where id=?", runId)!.title;
  const expiresAt = new Date(Date.now() + timeout).toISOString();
  const ask = createAsk(app, { runId: null, userId: holder, allowText: false, options,
    question: `${userName(app, requester)}想借用你的凭据读取 ${resource}。\n任务：${title}${thread ? "\n来源会话：" + (thread.title || thread.key || "网页会话") : ""}\n命令：\n${line}`,
    context: { handler, askedBy: requester, fromRun: runId, expiresAt } });
  const pending = waitDecision(ask.id, timeout, signal);
  if (thread?.settings.group) void import("../channels/lark-credential-confirm.ts").then(({ remindHolderInGroup }) =>
    remindHolderInGroup(app, ask, thread, runId)).catch((error: Error) =>
    addRunEvent(app, runId, "status", { text: `群内确认提醒未送达：${error.message}`, askId: ask.id }));
  if (thread) void import("./inbox.ts").then(({ deliverToThread }) =>
    deliverToThread(app, thread.id, `已请 ${userName(app, holder)} 确认，等他答复。`)).catch(() => {});
  const answer = await pending;
  if (!answer) cancelAsk(app, ask.id, "持有人没同意");
  const granted = answer?.choice === 0 || answer?.choice === 1;
  if (answer?.choice === 1 && !signal.aborted) run(app.db, `insert or ignore into credential_run_grants
    select ?,?,?,?,? where exists(select 1 from runs where id=? and status in ('running','queued'))`, ...scope, root);
  addRunEvent(app, root, "status", { text: `凭据确认：${userName(app, holder)} · ${answer?.answer ?? "持有人没同意"}`, askId: ask.id, runId, requester, holder, kind, resource });
  return granted && !signal.aborted;
}
