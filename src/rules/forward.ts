import { createHash } from "node:crypto";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { HttpError, truncate } from "../core/util.ts";
import type { Rule, RuleAction, RuleEvent } from "./types.ts";

type ForwardAction = Extract<RuleAction, { type: "forward" }>;
type Target = { chatId: string; name: string; kind: "group" | "p2p" };

/** The group made for a person (the owner, them and omem's bot), reused by every later forward. */
const groupKey = (p2pChatId: string) => `rule_forward_group:${p2pChatId}`;

const stamp = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * What is posted: where it came from, who sent it, the owner's note, then the message itself — the one
 * a wait step got (`awaited`) when there is one, else the triggering message.
 */
export function forwardText(e: RuleEvent, note: string) {
  if (e.awaited) return [`**转发自「${e.awaited.chatName}」**（${e.awaited.sender}，${stamp(e.awaited.at)}）`, note.trim(), e.awaited.text.trim()].filter(Boolean).join("\n\n");
  const m = e.message!;
  const from = e.chat ? `${e.chat.kind === "p2p" ? "私聊" : "群"}「${e.chat.name}」` : "飞书";
  return [`**转发自${from}**（${e.sender?.name ?? "?"}，${stamp(e.at)}）`, note.trim(), m.text.trim() || `（${m.type} 消息）`].filter(Boolean).join("\n\n");
}

/** The other person of a private chat, from what was captured there (not the owner, not a bot). */
function otherOf(app: App, p2pChatId: string) {
  return one<{ sender_id: string; sender_name: string }>(
    app.db,
    "select sender_id, sender_name from lark_messages where chat_id = ? and sender_kind = 'user' and sender_id is not null order by create_ms desc limit 1",
    p2pChatId,
  );
}

/**
 * Where a forward goes: a group (omem's bot is added as the owner when it is not there), or a
 * person's private chat — the bot cannot post there, so a group of the owner, that person and the
 * bot is made once (as the owner, like /ai拉群) and used from then on.
 */
export async function targetChat(app: App, label: string, to: Target, person?: { id: string; name: string }): Promise<{ chatId: string; note: string }> {
  const appId = app.config.lark.appId;
  if (!appId || !app.config.lark.enabled) throw new HttpError(400, "没有配置飞书机器人（lark.appId），没法转发");
  if (to.kind === "group") {
    const { chatBots } = await import("./engine.ts");
    const bots = await chatBots(app, to.chatId);
    if (bots?.some((b) => b.appId === appId)) return { chatId: to.chatId, note: "" };
    // Not there, or the list could not be read: adding it again does no harm.
    await (await import("../channels/lark-watch.ts")).inviteOwnBot(app, to.chatId);
    return { chatId: to.chatId, note: `，已用你的身份把机器人拉进「${to.name || to.chatId}」` };
  }
  const made = one<{ value: string }>(app.db, "select value from kv where key = ?", groupKey(to.chatId))?.value;
  if (made) return { chatId: made, note: "" };
  const other = person ? { sender_id: person.id, sender_name: person.name } : otherOf(app, to.chatId);
  if (!other) throw new HttpError(400, `私聊「${to.name || to.chatId}」里还没采集到对方的消息，不知道该拉谁进群`);
  const { larkCli } = await import("../channels/lark-cli.ts");
  const name = truncate(`${label}：${to.name || other.sender_name}`, 60);
  const created = await larkCli(["im", "+chat-create", "--as", "user", "--name", name, "--users", other.sender_id, "--bots", appId, "--format", "json"], 60_000);
  const chatId = String(created?.data?.chat_id ?? created?.chat_id ?? "");
  if (!chatId) throw new HttpError(502, "建群没有返回群 id");
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", groupKey(to.chatId), chatId);
  return { chatId, note: `，已用你的身份建群「${name}」（你、${other.sender_name} 和机器人）` };
}

export async function forwardAction(app: App, rule: Rule, a: ForwardAction, e: RuleEvent) {
  if (!e.message) throw new HttpError(400, "这次触发没有消息可转发");
  const { sendLark } = await import("../channels/lark-send.ts");
  // The same message forwarded twice (a retry, a second capture) is posted once.
  const what = e.awaited?.id ?? e.message.id;
  const uuidFor = (chatId: string) => createHash("sha256").update(`${rule.id}:${what}:${chatId}`).digest("hex").slice(0, 32);
  if (a.to.kind === "origin") {
    // Back to whoever asked: under their message in a group, or a group with them for a private chat.
    if (!e.awaited) throw new HttpError(400, "“回到触发的会话”要放在“等某个会话的新消息”后面：转回去的是等到的那条");
    if (!e.chat) throw new HttpError(400, "这次触发没有会话");
    if (e.chat.kind === "group") {
      const { note } = await targetChat(app, rule.name, { chatId: e.chat.id, name: e.chat.name, kind: "group" });
      await sendLark({ replyTo: e.message.id, inThread: !!e.message.topicId, uuid: uuidFor(e.chat.id) }, { markdown: forwardText(e, a.note) });
      return { action: "forward", ok: true, detail: `已回复在「${e.chat.name}」的这条消息下${note}` };
    }
    if (e.sender?.kind !== "user" || !e.sender.id) throw new HttpError(400, "私聊的对方不是人（或不知道是谁），没法拉群");
    const { chatId, note } = await targetChat(app, rule.name, { chatId: e.chat.id, name: e.chat.name, kind: "p2p" }, { id: e.sender.id, name: e.sender.name });
    await sendLark({ chatId, uuid: uuidFor(chatId) }, { markdown: forwardText(e, a.note) });
    return { action: "forward", ok: true, detail: `已发到和 ${e.sender.name} 的群${note}` };
  }
  if (e.chat?.id === a.to.chatId && !e.awaited) return { action: "forward", ok: true, detail: "目标就是消息所在的会话，没有转发" };
  const { chatId, note } = await targetChat(app, rule.name, a.to as Target);
  await sendLark({ chatId, uuid: uuidFor(chatId) }, { markdown: forwardText(e, a.note) });
  return { action: "forward", ok: true, detail: `已转发到「${a.to.name || a.to.chatId}」${note}` };
}
