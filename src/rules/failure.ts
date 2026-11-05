import type { App } from "../core/app.ts";
import { notify } from "../core/notify.ts";
import { getRun, runUser, setRunOutput } from "../agents/runs.ts";
import { sendLark } from "../channels/lark-send.ts";
import { HttpError } from "../core/util.ts";

/** The agent reports failure; delivery follows the owner's rule, including backend failures. */
const pending = new WeakMap<App, Map<string, Promise<string>>>();
export function reportRuleFailure(app: App, runId: string, summary: string): Promise<string> {
  let calls = pending.get(app);
  if (!calls) pending.set(app, calls = new Map());
  const prior = calls.get(runId);
  if (prior) return prior;
  const call = deliverFailure(app, runId, summary).finally(() => calls!.delete(runId));
  calls.set(runId, call);
  return call;
}

async function deliverFailure(app: App, runId: string, summary: string) {
  const run = getRun(app, runId);
  const rule = run.input.rule as { id: string; name: string; failureTo?: "owner" | "chat"; failureChatId?: string; failureBot?: string } | undefined;
  if (run.kind !== "agent" || !rule) throw new HttpError(400, "这不是规则任务");
  if (run.output.ruleFailure) return "这次运行的失败已经通知，不重复发送。";
  let to = rule.failureTo ?? "owner";
  const body = `规则「${rule.name}」执行失败：\n${summary}`;
  if (to === "chat" && rule.failureChatId) {
    try { await sendLark({ chatId: rule.failureChatId, bot: rule.failureBot, runId, purpose: "answer" }, { markdown: body }); }
    catch { to = "owner"; }
  } else to = "owner";
  if (to === "owner") notify(app, { userId: runUser(app, runId), title: `规则「${rule.name}」执行失败`, body: summary, link: `#/runs/${runId}` });
  setRunOutput(app, runId, { ruleFailure: { to, summary, at: new Date().toISOString() } });
  return `失败已${to === "owner" ? "通知本人" : "发到规则指定群聊"}，最终回答不会再发送到群里。`;
}
