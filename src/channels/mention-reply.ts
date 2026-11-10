import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { audit } from "../auth/permissions.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, truncate } from "../core/util.ts";
import { getRun, setRunOutput } from "../agents/runs.ts";

/**
 * Answering the person who looked for the owner (docs/v2/mentions.md “回复对方”), only through what
 * omem already does in Feishu: in a group the bot replies in a topic under their message (the owner's
 * identity only brings omem's own bot in when it is not there); a private chat is answered in a group
 * of the owner, them and the bot (made once, the one a rule's forward uses) or, when the owner chose
 * so, as the owner in that chat with the signature of /ai. Draft: the owner sends it from a card.
 * Auto: the owner's standing permission in settings → 渠道 → 有人找你, and only when the triage found
 * it can move on alone. Every reply goes to audit_events.
 */
export type MentionInfo = {
  /** The mention run that triaged it. */
  from: string;
  chatId: string;
  chatName: string;
  chatKind: "p2p" | "group";
  topicId: string | null;
  messageIds: string[];
  /** The message a group reply goes under (the newest one). */
  lastMessageId: string;
  senderId: string | null;
  senderName: string;
  /** Citations of the messages (chat lines). */
  refs: string[];
  /** What the handler may do with an answer, from the settings and the triage. */
  reply: "off" | "draft" | "auto";
  urgency: "normal" | "urgent";
  what: string;
};

type Replied = { via: "group" | "p2p-group" | "signed"; by: "auto" | "owner"; at: string; messageId: string | null; chatId: string; where: string };

export function mentionOf(app: App, runId: string | null | undefined): MentionInfo | null {
  if (!runId) return null;
  return (getRun(app, runId).input.mention as MentionInfo | undefined) ?? null;
}

const whereOf = (m: MentionInfo) => (m.chatKind === "p2p" ? `和 ${m.senderName} 的私聊` : `群「${m.chatName}」`);

/** The person as lark-cli (the owner's identity) knows them: capture by the bot records the bot's ids. */
function cliIdOf(app: App, id: string | null) {
  if (!id) return null;
  return one<{ cli_open_id: string | null }>(app.db, "select cli_open_id from lark_people where bot_open_id = ? or cli_open_id = ? limit 1", id, id)?.cli_open_id ?? id;
}
function botIdOf(app: App, id: string | null) {
  if (!id) return null;
  return one<{ bot_open_id: string | null }>(app.db, "select bot_open_id from lark_people where cli_open_id = ? or bot_open_id = ? limit 1", id, id)?.bot_open_id ?? null;
}

/** The tool (reply_to_asker): send, make a draft for the owner, or refuse, as the settings say. */
export async function replyToAsker(app: App, runId: string | null | undefined, text: string): Promise<string> {
  const m = mentionOf(app, runId);
  if (!m || !runId) throw new HttpError(403, "只有处理“有人找你”的运行能回复对方");
  const done = getRun(app, runId).output.mentionReply as Replied | { draft: string } | undefined;
  if (done) throw new HttpError(409, "这次已经回复过对方（或已经给本人发了草稿），不再重复");
  if (m.reply === "off") throw new HttpError(400, "本人没有打开“回复对方”：把建议的话写进给本人的提醒里");
  if (m.reply === "draft") {
    const id = await draftCard(app, runId, m, text);
    setRunOutput(app, runId, { mentionReply: { draft: id } });
    return "已作为草稿发给本人确认（还没有发出）：本人可以改一下再发，或者不发。提醒里说一句你拟了回复。";
  }
  const r = await sendMentionReply(app, runId, text, "auto");
  return `已回复对方：${r.where}${r.note}。在给本人的提醒里写清回了什么。`;
}

/** The card the owner sends the reply from: the text in an editable box, 发送 and 不发. */
async function draftCard(app: App, runId: string, m: MentionInfo, text: string) {
  const { buildCard, recordInteraction, sendLark, larkOwnerOpenId } = await import("./lark-send.ts");
  const owner = larkOwnerOpenId(app, "main");
  const dm = one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value;
  if (!owner && !dm) throw new HttpError(400, "主机器人还不知道你是谁，没法发草稿卡片");
  const how = m.chatKind === "group" ? "机器人在对方那条消息的话题里回复" : app.config.lark.mentions.reply.p2pVia === "group" ? `拉一个你、${m.senderName} 和机器人的群（只建一次），机器人在群里回复` : `以你的身份在私聊里发，结尾带“${app.config.lark.commands.signature}”`;
  const card = buildCard({
    title: `回复 ${m.senderName} 吗？`,
    color: "orange",
    blocks: [
      { markdown: `${whereOf(m)}${m.what ? `：${m.what}` : ""}\n发送方式：${how}` },
      { form: { name: "mention_reply", fields: [{ type: "input", name: "reply", label: "回复内容（可以直接改）", multiline: true, default: text.slice(0, 2000) }], submit: "发送" } },
      { buttons: [{ text: "不发", value: "drop" }] },
    ],
  });
  const sent = await sendLark(dm ? { chatId: dm, bot: "main", runId, purpose: "card" } : { userId: owner!, bot: "main", runId, purpose: "card" }, { card });
  return recordInteraction(app, { messageId: sent.messageId, chatId: dm ?? null, conversationId: null, runId, purpose: "mention-reply", allowed: owner ? [owner] : [], payload: { runId, text }, bot: "main" });
}

/** The owner answered the draft card (lark-actions.ts). Returns the card to show instead. */
export async function decideMentionReply(app: App, payload: { runId: string; text: string }, send: boolean, edited: string | null, by: string) {
  const { buildCard, decidedBlocks } = await import("./lark-send.ts");
  const m = mentionOf(app, payload.runId);
  const text = (edited ?? payload.text).trim();
  const decided = { by, at: new Date().toISOString(), timeZone: app.config.timezone };
  if (!m) throw new HttpError(404, "找不到这次处理");
  if (!send || !text) {
    audit(app, OWNER, "lark.mention-reply.drop", m.chatId, { runId: payload.runId });
    return buildCard({ title: "没有回复", color: "grey", blocks: [{ markdown: `${whereOf(m)}：${truncate(payload.text, 600)}` }, ...decidedBlocks({ ...decided, verdict: "决定不发" })] });
  }
  const r = await sendMentionReply(app, payload.runId, text, "owner", true);
  return buildCard({ title: "已回复", color: "green", blocks: [{ markdown: truncate(text, 1500) }, ...decidedBlocks({ ...decided, verdict: `确认发送：${r.where}${r.note}` })] });
}

/**
 * Send the reply. `by`: auto (the handler, under the owner's standing permission) or owner (clicked).
 * The work's home follows the reply (agents/home.ts): what it says later goes where the talk now is.
 */
export async function sendMentionReply(app: App, runId: string, text: string, by: "auto" | "owner", fromDraft = false): Promise<Replied & { note: string }> {
  const m = mentionOf(app, runId);
  if (!m) throw new HttpError(404, "找不到这次处理");
  const prev = getRun(app, runId).output.mentionReply as Partial<Replied> & { draft?: string } | undefined;
  if (prev?.via && !fromDraft) throw new HttpError(409, "这次已经回复过对方");
  const cfg = app.config.lark;
  if (!cfg.enabled || !cfg.appId) throw new HttpError(400, "没有配置飞书机器人，没法回复");
  const { sendLark } = await import("./lark-send.ts");
  let r: Replied;
  let note = "";
  if (m.chatKind === "group") {
    const { targetChat } = await import("../rules/forward.ts");
    note = (await targetChat(app, "有人找你", { chatId: m.chatId, name: m.chatName, kind: "group" })).note;
    const at = botIdOf(app, m.senderId);
    const sent = await sendLark({ replyTo: m.lastMessageId, inThread: true, runId, purpose: "answer" }, { markdown: `${at ? `<at id=${at}></at> ` : ""}${text}` });
    r = { via: "group", by, at: new Date().toISOString(), messageId: sent.messageId, chatId: m.chatId, where: `在${whereOf(m)}里 ${m.senderName} 那条消息的话题里` };
    follow(app, runId, m.chatId, sent.threadId ?? m.topicId, m.chatName, sent.messageId);
  } else if (cfg.mentions.reply.p2pVia === "group") {
    const { targetChat } = await import("../rules/forward.ts");
    const person = cliIdOf(app, m.senderId);
    const t = await targetChat(app, "有人找你", { chatId: m.chatId, name: m.senderName, kind: "p2p" }, person ? { id: person, name: m.senderName } : undefined);
    note = t.note;
    const sent = await sendLark({ chatId: t.chatId, runId, purpose: "answer" }, { markdown: `**${m.senderName} 在私聊里问${m.what ? `：${m.what}` : ""}**\n\n${text}` });
    r = { via: "p2p-group", by, at: new Date().toISOString(), messageId: sent.messageId, chatId: t.chatId, where: `在你、${m.senderName} 和机器人的群里` };
    follow(app, runId, t.chatId, null, `和${m.senderName}`, sent.messageId);
  } else {
    const { larkCli } = await import("./lark-cli.ts");
    const { larkMarkdown } = await import("./lark-markdown.ts");
    const body = larkMarkdown(`${text}\n\n${cfg.commands.signature}`.trim());
    const v = await larkCli(["im", "+messages-send", "--as", "user", "--chat-id", m.chatId, "--markdown", body, "--idempotency-key", `omem-m-${runId}`.slice(0, 50), "--format", "json"], 60_000);
    r = { via: "signed", by, at: new Date().toISOString(), messageId: String(v?.data?.message_id ?? v?.message_id ?? "") || null, chatId: m.chatId, where: `以你的身份在和 ${m.senderName} 的私聊里（带署名）` };
  }
  audit(app, by === "owner" ? OWNER : "agent", "lark.mention-reply", r.chatId, { runId, via: r.via, by, messageId: r.messageId, triggeredBy: m.messageIds, text: truncate(text, 1000) });
  setRunOutput(app, runId, { mentionReply: r });
  return { ...r, note };
}

/** The work is now followed where the reply went. */
function follow(app: App, runId: string, chatId: string, topicId: string | null, title: string, messageId: string) {
  void (async () => {
    const { resolveThread } = await import("../agents/threads.ts");
    const { moveHome } = await import("../agents/home.ts");
    const { captureSpace } = await import("../core/capture-space.ts");
    const t = resolveThread(app, { channel: "lark", chatId, topicId: topicId ?? undefined, isGroup: true, title, spaceId: captureSpace(app, chatId), userId: OWNER }).thread;
    moveHome(app, runId, t.id, messageId);
  })().catch((e) => console.warn("[omem] 回复后记录这件事在哪里聊失败：", (e as Error).message));
}
