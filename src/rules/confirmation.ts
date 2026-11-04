import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { OWNER, canWrite } from "../core/users.ts";
import { HttpError, sha256 } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskAction } from "../agents/asks.ts";
import { getRule, saveRule } from "./store.ts";
import type { Rule } from "./types.ts";
import { describe } from "./conditions.ts";

const revision = (rule: Rule) => sha256(JSON.stringify(rule));

export function confirmRule(app: App, rule: Rule, runId: string, conversationId: string) {
  for (const ask of all<{ id: string }>(app.db, "select id from asks where status = 'pending' and json_extract(context, '$.handler') = 'rule-enable' and json_extract(context, '$.ruleId') = ?", rule.id)) cancelAsk(app, ask.id);
  if (rule.enabled) return null;
  const actions = rule.actions.map(a => a.type === "agent"
    ? `交给 ${a.spec ?? "assistant"}${a.task ? `：${a.task}` : ""}（${a.reply === "auto" ? "直接回复" : a.reply === "draft" ? "回复先确认" : a.reply === "silent" ? "静默排查" : "只告诉本人"}）`
    : ({ notify: "通知本人", capture: "优先采集", watch: "持续监听", "invite-bot": "拉机器人进群", "meeting-bot": "拉机器人入会", wake: "唤醒" })[a.type]);
  return createAsk(app, {
    runId, conversationId, userId: OWNER,
    question: [
      `规则「${rule.name}」已保存，是否启用？`, rule.description,
      `触发：${({ message: "新消息", "chat-new": "第一次看到的群", meeting: "本人加入会议", schedule: `定时 ${rule.trigger.cron ?? ""}` })[rule.trigger.event]}`,
      `条件：${describe(rule.conditions)}`,
      `判断：${({ code: "按条件", ai: "交给 AI", "code+ai": "条件命中后由 AI 确认" })[rule.judge]}`,
      `动作：${actions.join("；")}`,
    ].join("\n\n"),
    options: [{ label: "启用规则" }, { label: "先不启用" }], allowText: false,
    context: { handler: "rule-enable", ruleId: rule.id, revision: revision(rule), afterReply: true },
  });
}

registerAskAction("rule-enable", (app, ask, context) => {
  if (ask.userId !== OWNER || ask.answeredBy !== OWNER) throw new HttpError(403, "只有本人可以确认启用规则");
  const rule = getRule(app, String(context.ruleId ?? ""));
  if (rule.spaceId && !canWrite(app, ask.userId, rule.spaceId)) throw new HttpError(403, "不能修改这个空间的规则");
  if (revision(rule) !== context.revision) throw new HttpError(409, "规则已修改，请核对最新内容后再启用");
  if (ask.choice === 1) return `规则「${rule.name}」保持停用。`;
  if (ask.choice !== 0) throw new HttpError(400, "请选择是否启用规则");
  saveRule(app, { ...rule, temporary: rule.temporary ?? undefined, enabled: true }, "user");
  return `规则「${rule.name}」已启用，即时生效。`;
});
