import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { notify } from "../core/notify.ts";
import { isApp, mentionIds, messageText, timeMs, type LarkMessage } from "../channels/lark-messages.ts";
import type { Condition, Rule, RuleAction, RuleEvent } from "./types.ts";

/**
 * Rules that cannot wait for the capture (every 10 minutes or so), like “someone asks me for a login
 * code”: every minute the owner's lark-cli searches what such a rule can fire on — group messages
 * that @ the owner, and private-chat messages — by the words the rule's conditions look for. What it
 * finds goes to those rules only; the same message coming later with the capture is not fired twice
 * (rule_handled, by message id).
 */
export async function pollFastRules(app: App) {
  const { listRules } = await import("./store.ts");
  const rules = listRules(app, { enabledOnly: true }).filter((r) => r.trigger.event === "message" && r.trigger.fast);
  if (!rules.length || polling.has(app)) return 0;
  polling.add(app);
  try {
    const { fetchMessages, ownerOpenId } = await import("../channels/lark-personal.ts");
    const owner = await ownerOpenId();
    if (!owner) return 0;
    const end = Date.now();
    const since = Number(one<{ value: string }>(app.db, "select value from kv where key = 'rule_fast_since_ms'")?.value ?? end - 2 * 60_000);
    // Search lags a little behind: look back over the last window too (a message is fired once anyway).
    const start = Math.max(since - 2 * 60_000, end - 15 * 60_000);
    const words = [...new Set(rules.flatMap((r) => textWords(r.conditions)))];
    const queries = words.length ? words : [""];
    const found: { m: LarkMessage; kind: "group" | "p2p" }[] = [];
    for (const q of queries) {
      const query = q ? ["--query", q] : [];
      for (const m of await fetchMessages(["+messages-search", ...query, "--at-chatter-ids", owner, "--chat-type", "group"], start, end, { pages: 2 })) found.push({ m, kind: "group" });
      for (const m of await fetchMessages(["+messages-search", ...query, "--chat-type", "p2p"], start, end, { pages: 2 })) found.push({ m, kind: "p2p" });
    }
    const seen = new Set<string>();
    const events: RuleEvent[] = [];
    for (const { m, kind } of found) {
      if (!m.chat_id || seen.has(m.message_id) || m.msg_type === "system" || m.sender?.id === owner) continue;
      seen.add(m.message_id);
      if (kind === "group" && !mentionIds(m).includes(owner)) continue;
      events.push(eventOf(app, m, kind, owner));
    }
    const { dispatchRuleEvent } = await import("./engine.ts");
    const ids = new Set(rules.map((r) => r.id));
    for (const e of events.sort((a, b) => a.at.localeCompare(b.at))) await dispatchRuleEvent(app, e, (r) => ids.has(r.id));
    run(app.db, "insert into kv(key,value) values('rule_fast_since_ms', ?) on conflict(key) do update set value = excluded.value", String(end));
    return events.length;
  } finally {
    polling.delete(app);
  }
}
const polling = new WeakSet<App>();

/** The words a rule's conditions look for in the message text: what the search asks for. */
export function textWords(c: Condition | null): string[] {
  if (!c) return [];
  if ("all" in c) return c.all.flatMap(textWords);
  if ("any" in c) return c.any.flatMap(textWords);
  if ("not" in c) return [];
  return c.field === "message.text" && c.op === "contains" && typeof c.value === "string" && c.value.trim() ? [c.value.trim()] : [];
}

function eventOf(app: App, m: LarkMessage, kind: "group" | "p2p", owner: string): RuleEvent {
  const chatName = m.chat_name ?? one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ?", m.chat_id!)?.name ?? m.sender?.name ?? m.chat_id!;
  const senderId = m.sender?.id;
  const email = senderId ? one<{ email: string | null }>(app.db, "select email from lark_people where cli_open_id = ?", senderId)?.email ?? null : null;
  const text = messageText(m);
  return {
    key: `lark:${m.message_id}`,
    kind: "message",
    at: new Date(timeMs(m.create_time)).toISOString(),
    chat: { id: m.chat_id!, name: chatName, kind },
    sender: { id: senderId, name: m.sender?.name ?? senderId ?? "?", email, kind: isApp(m) ? "bot" : "user" },
    message: { id: m.message_id, text, type: m.msg_type, mentionsOwner: mentionIds(m).includes(owner), mentionsBot: false, topicId: m.thread_id ?? null, cardTitle: /<card title="([^"]*)"/.exec(text)?.[1] ?? null },
    via: "capture",
  };
}

type WaitAction = Extract<RuleAction, { type: "wait-message" }>;

/** Whether a message is the one a wait step is after (not the owner's own). */
export function waitMatches(a: Pick<WaitAction, "contains" | "matches">, text: string) {
  if (a.contains && !text.toLowerCase().includes(a.contains.toLowerCase())) return false;
  if (a.matches) {
    try { if (!new RegExp(a.matches, "i").test(text)) return false; } catch { return false; }
  }
  return true;
}

/**
 * A “wait for a message” step (rule-fire run with `wait`): read that chat every 10 seconds until a
 * matching message stamped at or after `since` (the trigger minute less a short look-back, actions.ts) arrives; the newest one wins or time is up; then the actions after the step run with
 * it as `awaited`.
 */
export async function waitThenAct(app: App, input: { ruleId: string; key: string; event: RuleEvent; wait: WaitAction; actions: RuleAction[]; reason?: string; since: number }, signal?: AbortSignal) {
  const { listRules } = await import("./store.ts");
  const rule = listRules(app, { enabledOnly: true }).find((r) => r.id === input.ruleId);
  if (!rule) return { summary: "规则已停用或删除，没有执行" };
  const { fetchMessages, ownerOpenId } = await import("../channels/lark-personal.ts");
  const owner = await ownerOpenId();
  // The wait runs from the trigger, not from the look-back start.
  const until = Math.max(Date.parse(input.event.at) || 0, input.since) + input.wait.minutes * 60_000;
  const name = input.wait.name || input.wait.chatId;
  while (!signal?.aborted) {
    const got = (await fetchMessages(["+chat-messages-list", "--chat-id", input.wait.chatId, "--order", "asc"], input.since - 1000, Date.now() + 1000, { pages: 1 }).catch(() => [] as LarkMessage[]))
      .filter((m) => m.msg_type !== "system" && m.sender?.id !== owner && timeMs(m.create_time) >= input.since && waitMatches(input.wait, messageText(m)))
      .sort((x, y) => timeMs(y.create_time) - timeMs(x.create_time))[0];
    if (got) {
      const awaited = { chatId: input.wait.chatId, chatName: name, id: got.message_id, text: messageText(got), sender: got.sender?.name ?? "?", at: new Date(timeMs(got.create_time)).toISOString() };
      const { fireAfterWait } = await import("./engine.ts");
      return fireAfterWait(app, rule.id, input.key, { ...input.event, awaited }, { actions: input.actions, reason: input.reason });
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, Math.min(10_000, Math.max(1000, until - Date.now()))));
  }
  if (signal?.aborted) throw new HttpError(499, "CANCELLED");
  if (input.wait.onTimeout === "notify") notify(app, { title: `规则「${rule.name}」`, body: `等了 ${input.wait.minutes} 分钟，「${name}」没有新的${input.wait.contains ? `含“${input.wait.contains}”的` : ""}消息，后面的动作没有做。`, link: `#/rules?id=${rule.id}` });
  return { summary: `${input.wait.minutes} 分钟内「${name}」没有符合的新消息，后面的动作没有做` };
}

/** What a rule with a wait step looks like to the rule check before saving. */
export function checkWaitRule(r: Pick<Rule, "actions" | "trigger">) {
  const i = r.actions.findIndex((a) => a.type === "wait-message");
  if (i < 0) return;
  if (r.trigger.event !== "message") throw new HttpError(400, "“等某个会话的新消息”只用于新消息规则");
  if (i === r.actions.length - 1) throw new HttpError(400, "“等某个会话的新消息”后面要有动作：等到的消息交给它们");
  const a = r.actions[i] as WaitAction;
  if (a.matches) try { new RegExp(a.matches); } catch { throw new HttpError(400, `正则写错了：${a.matches}`); }
}
