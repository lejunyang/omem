import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import { receive } from "../agents/inbox.ts";
import { findAgentSpec } from "../agents/specs.ts";
import { chatSettings, setChatSettings, type WatchRule } from "../agents/threads.ts";

/**
 * Watched chats: an alert group, an on-call group, a customer chat… Each has a
 * rule naming the agent spec that handles its messages (the owner writes that
 * spec and its skills — how to triage an alert, how to answer users), which
 * messages trigger it, and whether it may reply through the bot (never, as a
 * draft the owner approves, or directly).
 *
 * Messages arrive from the bot (real time, when the bot is in the group) or
 * from the owner's capture (polling, any chat the owner is in). Each message is
 * handled once. A watched chat (or each of its topics) is a thread of channel
 * `lark-watch`, so the handler keeps context across messages.
 */
export const WATCH_CHANNEL = "lark-watch";

export type ChatMessage = { id: string; time: string; sender: string; senderId?: string; text: string; topicId?: string; mentions?: string[] };

export function watchRule(app: App, chatId: string): WatchRule | null {
  return chatSettings(app, WATCH_CHANNEL, chatId).watch ?? null;
}

export function setWatchRule(app: App, chatId: string, rule: WatchRule | null) {
  if (rule) {
    const spec = findAgentSpec(app, rule.spec);
    if (!spec) throw new Error(`没有 Agent 档案 ${rule.spec}：先建好处理这个群的 Agent（说明怎么处理、用哪些技能和工具）`);
    if (rule.on === "keyword") new RegExp(rule.pattern ?? "");
  }
  return setChatSettings(app, WATCH_CHANNEL, chatId, {
    watch: rule ?? undefined,
    spec: rule?.spec,
    spaceId: rule?.spaceId,
    mode: "topic",
    idleHours: 0,
    lark: rule ? { chats: rule.reply === "none" ? [] : [chatId], draft: rule.reply === "draft" } : undefined,
  });
}

function matches(rule: WatchRule, m: ChatMessage, who: { ownerOpenId?: string; botOpenId?: string | null; ownerName?: string }) {
  if (rule.on === "all") return true;
  if (rule.on === "keyword") {
    try {
      return new RegExp(rule.pattern ?? "", "i").test(m.text);
    } catch {
      return false;
    }
  }
  const ids = m.mentions ?? [];
  return (!!who.ownerOpenId && ids.includes(who.ownerOpenId)) || (!!who.botOpenId && ids.includes(who.botOpenId)) || (!!who.ownerName && m.text.includes(`@${who.ownerName}`));
}

/** Hand new messages of a watched chat to its handler. Returns how many were handed over. */
export async function routeWatchedMessages(app: App, chatId: string, chatName: string, messages: ChatMessage[], opts: { botOpenId?: string | null } = {}) {
  const rule = watchRule(app, chatId);
  if (!rule) return 0;
  let n = 0;
  for (const m of messages) {
    // Each message once, whichever path saw it first.
    if (one(app.db, "select 1 from handled_messages where channel = 'lark' and message_id = ?", m.id)) continue;
    if (!matches(rule, m, { ownerOpenId: app.config.lark.ownerOpenId, botOpenId: opts.botOpenId })) continue;
    if (opts.botOpenId && m.senderId === opts.botOpenId) continue; // never react to our own posts
    run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values('lark',?,?,?)", m.id, rule.spec, now());
    const r = await receive(app, {
      channel: WATCH_CHANNEL,
      chatId,
      topicId: m.topicId,
      isGroup: true,
      title: chatName,
      spaceId: rule.spaceId,
      speaker: m.sender,
      text: `${m.text}\n（飞书消息 ${m.id}${m.topicId ? `，话题 ${m.topicId}` : ""}，群「${chatName}」 ${chatId}）`,
      externalMessageId: m.id,
      mergeMs: 5000,
    });
    if (r.runId) run(app.db, "update handled_messages set run_id = ? where channel = 'lark' and message_id = ?", r.runId, m.id);
    n++;
  }
  return n;
}
