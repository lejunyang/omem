import { can, audit } from "../auth/permissions.ts";
import { cancelAsk, createAsk, registerAskHandler } from "../agents/asks.ts";
import { getThread } from "../agents/threads.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { activeUser, findUser, larkOpenIdOf, OWNER, userName } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import type { Rule } from "./types.ts";

/**
 * A rule's agent working as members (docs/v2/rules.md, “以成员身份运行”): the owner lists people on an
 * agent action (`runAs`); each is asked once — on a card in the group the rule was set up from, else in
 * their private chat with the bot — and only those who agreed can be switched to. In one run the agent
 * goes through them in turn with `act_as`: the commands a plugin declares (credential-registry.ts) then
 * run on that person's login in their own account sandbox, and lark_read reads as them. A person can
 * withdraw on their account page; the owner sees each one's state on the rules page.
 */
export type RunAsStatus = "pending" | "granted" | "declined" | "revoked" | "unavailable";
export type RunAsEntry = { userId: string; name: string; status: RunAsStatus; reason: string | null; updatedAt: string | null };
type Row = { rule_id: string; user_id: string; status: RunAsStatus; reason: string | null; ask_id: string | null; updated_at: string };

export const MAX_RUN_AS = 20;

/** Why this person cannot be asked (null: they can). */
export function runAsBlocker(app: App, userId: string): string | null {
  if (userId === OWNER) return "本人的身份不用另外同意";
  const u = findUser(app, userId);
  if (!activeUser(u)) return "没有可用的 omem 账号";
  if (!can(app, userId, "ask.send")) return "没有使用助手（机器人）的权限";
  if (!larkOpenIdOf(app, userId)) return "没有关联飞书账号，机器人联系不到他";
  return null;
}

export const runAsMembers = (rule: Pick<Rule, "actions">) =>
  [...new Set(rule.actions.flatMap((a) => (a.type === "agent" ? a.runAs ?? [] : [])))];

const rowOf = (app: App, ruleId: string, userId: string) =>
  one<Row>(app.db, "select * from rule_run_as where rule_id = ? and user_id = ?", ruleId, userId);

function put(app: App, ruleId: string, userId: string, status: RunAsStatus, reason: string | null, askId: string | null = null) {
  run(app.db, `insert into rule_run_as(rule_id,user_id,status,reason,ask_id,updated_at) values(?,?,?,?,?,?)
    on conflict(rule_id,user_id) do update set status=excluded.status, reason=excluded.reason, ask_id=excluded.ask_id, updated_at=excluded.updated_at`,
    ruleId, userId, status, reason, askId, now());
}

/** Each listed person's state, in the rule's order. */
export function runAsOf(app: App, rule: Pick<Rule, "id" | "actions">): RunAsEntry[] {
  return runAsMembers(rule).map((userId) => {
    const r = rowOf(app, rule.id, userId);
    const blocked = r?.status === "granted" ? runAsBlocker(app, userId) : null;
    // The card lapsed unanswered (ask-expiry.ts): still waiting, and the owner can ask again.
    const lapsed = r?.status === "pending" && r.ask_id && one(app.db, "select 1 from asks where id = ? and status != 'pending'", r.ask_id) ? "提问已失效，可以再问一次" : null;
    return { userId, name: userName(app, userId), status: blocked ? "unavailable" : r?.status ?? "pending", reason: blocked ?? lapsed ?? r?.reason ?? null, updatedAt: r?.updated_at ?? null };
  });
}

/** Agreed and still able to: the only people a run may switch to. */
export function consented(app: App, ruleId: string, userId: string) {
  return rowOf(app, ruleId, userId)?.status === "granted" && !runAsBlocker(app, userId);
}

/** The group the rule was set up from (its 发到 conversation, when that is a Feishu group of the owner's). */
function askIn(app: App, rule: Pick<Rule, "conversationId">) {
  if (!rule.conversationId) return null;
  try {
    const t = getThread(app, rule.conversationId);
    return (t.channel === "lark" || t.channel.startsWith("lark:")) && t.settings.group ? t.id : null;
  } catch {
    return null;
  }
}

function ask(app: App, rule: Rule, userId: string) {
  const blocked = runAsBlocker(app, userId);
  if (blocked) return put(app, rule.id, userId, "unavailable", blocked);
  const task = rule.actions.flatMap((a) => (a.type === "agent" && a.runAs?.includes(userId) && a.task ? [a.task] : [])).join("\n");
  const q = createAsk(app, {
    runId: null,
    conversationId: askIn(app, rule),
    userId,
    question: [
      `${userName(app, OWNER)}的规则「${rule.name}」想在运行时用你的身份做事：${rule.description}`,
      task ? `要做的：${task.slice(0, 500)}` : "",
      "同意后，这条规则的助手轮到你时，会用你的登录运行插件登记过的命令（比如研发平台的命令行）、以你的身份读飞书；每次都记在运行里。你随时可以在 omem 的“账号”页撤回。",
    ].filter(Boolean).join("\n\n"),
    options: [{ label: "同意" }, { label: "不同意" }],
    allowText: false,
    context: { handler: "rule-run-as", ruleId: rule.id, userId },
  });
  put(app, rule.id, userId, "pending", null, q.id);
}

/**
 * After a rule is saved: ask the people newly listed (and those who could not be asked before), forget
 * the ones taken off. Someone who said no or withdrew is not asked again until the owner asks (reask).
 */
export function syncRunAs(app: App, rule: Rule) {
  const listed = runAsMembers(rule);
  for (const r of all<Row>(app.db, "select * from rule_run_as where rule_id = ?", rule.id)) {
    if (listed.includes(r.user_id)) continue;
    if (r.status === "pending" && r.ask_id) cancelAsk(app, r.ask_id, "规则不再以他的身份运行");
    run(app.db, "delete from rule_run_as where rule_id = ? and user_id = ?", rule.id, r.user_id);
  }
  for (const userId of listed) {
    const r = rowOf(app, rule.id, userId);
    if (!r || r.status === "unavailable") ask(app, rule, userId);
  }
}

/** The owner asks someone again (after a no, a withdrawal, or once they can be reached). */
export function reaskRunAs(app: App, rule: Rule, userId: string) {
  if (!runAsMembers(rule).includes(userId)) throw new HttpError(400, "这条规则没有列这个人");
  const r = rowOf(app, rule.id, userId);
  if (r?.status === "granted" && !runAsBlocker(app, userId)) throw new HttpError(409, "他已经同意了");
  if (r?.status === "pending" && r.ask_id) cancelAsk(app, r.ask_id, "重新问了一次");
  ask(app, rule, userId);
  return runAsOf(app, rule);
}

export function forgetRunAs(app: App, ruleId: string) {
  for (const r of all<Row>(app.db, "select * from rule_run_as where rule_id = ? and status = 'pending'", ruleId)) if (r.ask_id) cancelAsk(app, r.ask_id, "规则已删除");
  run(app.db, "delete from rule_run_as where rule_id = ?", ruleId);
}

/** The rules that asked to use this person's identity, for their account page. */
export function myRunAs(app: App, userId: string) {
  return all<Row & { name: string; description: string }>(app.db,
    "select r.*, rules.name, rules.description from rule_run_as r join rules on rules.id = r.rule_id where r.user_id = ? order by r.updated_at desc", userId)
    .map((r) => ({ ruleId: r.rule_id, name: r.name, description: r.description, status: r.status, updatedAt: r.updated_at, askId: r.status === "pending" ? r.ask_id : null }));
}

/** The person themselves withdraws (or, with grant, agrees from the account page to a pending ask). */
export function decideRunAs(app: App, ruleId: string, userId: string, grant: boolean, by: string) {
  if (by !== userId) throw new HttpError(403, "只有本人能决定自己的身份给不给用");
  const r = rowOf(app, ruleId, userId);
  if (!r) throw new HttpError(404, "这条规则没有请你同意");
  if (r.status === "pending" && r.ask_id) cancelAsk(app, r.ask_id, grant ? "已在账号页同意" : "已在账号页拒绝");
  record(app, ruleId, userId, grant ? "granted" : r.status === "granted" ? "revoked" : "declined");
}

function record(app: App, ruleId: string, userId: string, status: "granted" | "declined" | "revoked") {
  put(app, ruleId, userId, status, null);
  audit(app, userId, `rule.run-as.${status === "granted" ? "grant" : status === "declined" ? "decline" : "revoke"}`, ruleId);
  const rule = one<{ name: string }>(app.db, "select name from rules where id = ?", ruleId);
  const verb = status === "granted" ? "同意" : status === "declined" ? "不同意" : "撤回了同意，不再允许";
  notify(app, { userId: OWNER, title: `${userName(app, userId)}${verb}规则「${rule?.name ?? ruleId}」以他的身份运行`, link: `#/rules/${ruleId}` });
}

registerAskHandler("rule-run-as", async (app, q, context) => {
  const ruleId = String(context.ruleId), userId = String(context.userId);
  const r = rowOf(app, ruleId, userId);
  if (!r || r.ask_id !== q.id || r.status !== "pending") return;
  record(app, ruleId, userId, q.choice === 0 ? "granted" : "declined");
}, (_app, q, context, by) => {
  if (by !== context.userId || by !== q.userId) throw new HttpError(403, "只有被问的人能回答");
});

// ---- Who a running rule acts as ------------------------------------------------------------

/** By run: the person the agent switched to (absent: the owner). Process memory: a restarted run starts as the owner. */
const acting = new Map<string, string>();
export const actingAs = (runId: string | null | undefined) => (runId ? acting.get(runId) ?? null : null);

export function switchIdentity(app: App, runId: string, rule: { id: string; runAs?: string[] }, to: string | null) {
  if (!to) {
    acting.delete(runId);
    return null;
  }
  const userId = (rule.runAs ?? []).find((id) => id === to || userName(app, id) === to);
  if (!userId) throw new HttpError(403, `这条规则没有列 ${to}：只能换成规则页“以谁的身份运行”里的人`);
  if (!consented(app, rule.id, userId)) {
    const r = rowOf(app, rule.id, userId);
    throw new HttpError(403, `${userName(app, userId)}${r?.status === "pending" ? "还没同意" : r?.status === "declined" ? "没有同意" : r?.status === "revoked" ? "撤回了同意" : runAsBlocker(app, userId) ?? "不能用"}：跳过他，继续下一个`);
  }
  acting.set(runId, userId);
  return userId;
}
export const endActing = (runId: string) => acting.delete(runId);
