import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { audit } from "../auth/permissions.ts";
import { notify } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, truncate } from "../core/util.ts";
import { getRun, setRunOutput } from "../agents/runs.ts";
import type { MentionInfo, Replied } from "../mentions/channel.ts";
import { mentionOf } from "../mentions/mentions.ts";

/**
 * Answering the person who looked for the owner on Feishu (docs/v2/mentions.md “回复对方”; the tool
 * and its checks are src/mentions/mentions.ts replyToAsker), only through what omem already does in
 * Feishu: in a group the bot replies in a topic under their message (the owner's identity only brings
 * omem's own bot in when it is not there); a private chat is answered in a group of the owner, them and
 * the bot (made once, the one a rule's forward uses) or, when the owner chose so, as the owner in that
 * chat with the signature of /ai — through lark-cli, or through a one-off Doubao session where the
 * tenant keeps lark-cli from sending (`signedVia: doubao`, doubao-send.ts; checked by reading the chat
 * back). Draft: the owner sends it from a card. Auto: the owner's standing
 * permission in settings → 渠道 → 有人找你 (`mentions.reply.lark`), and only when the triage found it
 * can move on alone. Every reply goes to audit_events.
 */

const whereOf = (m: Pick<MentionInfo, "chatKind" | "senderName" | "chatName">) => (m.chatKind === "p2p" ? `和 ${m.senderName} 的私聊` : `群「${m.chatName}」`);

/** A private chat answered as the owner through a Doubao session (doubao-send.ts), not lark-cli. */
const viaDoubao = (app: App, m: Pick<MentionInfo, "chatKind">) => m.chatKind === "p2p" && app.config.mentions.reply.lark.p2pVia === "signed" && app.config.mentions.reply.lark.signedVia === "doubao";

/** How a reply goes out, in a sentence (the handler's task, the draft card). `you`: “你” on the owner's card. */
export function replyHow(app: App, m: Pick<MentionInfo, "chatKind" | "senderName">, you = "本人") {
  if (m.chatKind === "group") return "机器人在对方那条消息的话题里回复（机器人不在群里时先用本人身份把它拉进来）";
  const signature = app.config.lark.commands.signature;
  if (app.config.mentions.reply.lark.p2pVia === "group") return `拉一个${you}、${m.senderName} 和机器人的群（只建一次），机器人在群里回复`;
  if (viaDoubao(app, m)) return `经豆包以${you}的身份在私聊里发，结尾带“${signature}”，发完读私聊核对`;
  return `以${you}的身份在私聊里发，结尾带“${signature}”`;
}

/** The person as lark-cli (the owner's identity) knows them: capture by the bot records the bot's ids. */
function cliIdOf(app: App, id: string | null) {
  if (!id) return null;
  return one<{ cli_open_id: string | null }>(app.db, "select cli_open_id from lark_people where bot_open_id = ? or cli_open_id = ? limit 1", id, id)?.cli_open_id ?? id;
}
function botIdOf(app: App, id: string | null) {
  if (!id) return null;
  return one<{ bot_open_id: string | null }>(app.db, "select bot_open_id from lark_people where cli_open_id = ? or bot_open_id = ? limit 1", id, id)?.bot_open_id ?? null;
}

/** The card the owner sends the reply from: the text in an editable box, 发送 and 不发. Returns the interaction's id. */
export async function draftMentionReply(app: App, runId: string, m: MentionInfo, text: string) {
  const { buildCard, recordInteraction, sendLark, larkOwnerOpenId } = await import("./lark-send.ts");
  const owner = larkOwnerOpenId(app, "main");
  const dm = one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value;
  if (!owner && !dm) throw new HttpError(400, "主机器人还不知道你是谁，没法发草稿卡片");
  const how = m.chatKind === "group" ? "机器人在对方那条消息的话题里回复" : replyHow(app, m, "你");
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
  if (viaDoubao(app, m)) {
    // Doubao and the check after it take far longer than a card callback may: the result comes as a reminder.
    void sendMentionReply(app, payload.runId, text, "owner", true).catch((e) => {
      if ((e as { told?: boolean }).told) return;
      notify(app, { title: `没有回复 ${m.senderName}`, body: `${(e as Error).message}\n\n要发的内容：\n${truncate(text, 1500)}`, runId: payload.runId, link: `#/runs/${payload.runId}` });
    });
    return buildCard({ title: "正在经豆包发送", color: "blue", blocks: [{ markdown: truncate(text, 1500) }, ...decidedBlocks({ ...decided, verdict: "确认发送：经豆包以你的身份在私聊里发，发完核对后另行告诉你结果" })] });
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
    const sent = await sendLark({ replyTo: m.lastMessageId, inThread: true, runId, purpose: "answer" }, { markdown: await atEveryone(app, text, m.chatId, m.senderName, at) });
    r = { via: "group", by, at: new Date().toISOString(), messageId: sent.messageId, chatId: m.chatId, where: `在${whereOf(m)}里 ${m.senderName} 那条消息的话题里` };
    follow(app, runId, m.chatId, sent.threadId ?? m.topicId, m.chatName, sent.messageId);
  } else if (app.config.mentions.reply.lark.p2pVia === "group") {
    const { targetChat } = await import("../rules/forward.ts");
    const person = cliIdOf(app, m.senderId);
    const t = await targetChat(app, "有人找你", { chatId: m.chatId, name: m.senderName, kind: "p2p" }, person ? { id: person, name: m.senderName } : undefined);
    note = t.note;
    const sent = await sendLark({ chatId: t.chatId, runId, purpose: "answer" }, { markdown: `**${m.senderName} 在私聊里问${m.what ? `：${m.what}` : ""}**\n\n${text}` });
    r = { via: "p2p-group", by, at: new Date().toISOString(), messageId: sent.messageId, chatId: t.chatId, where: `在你、${m.senderName} 和机器人的群里` };
    follow(app, runId, t.chatId, null, `和${m.senderName}`, sent.messageId);
  } else if (viaDoubao(app, m)) {
    return doubaoReply(app, runId, m, text, by);
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

/**
 * A private chat answered as the owner by a one-off Doubao session (doubao-send.ts). Once Doubao was
 * asked, the attempt is recorded (no second try: it may have gone out). Anything but a message found
 * as written, or Doubao's word with the chat unreadable (said as 未核对), is a failure the owner hears
 * about directly; the error carries `told` so callers do not tell them twice.
 */
async function doubaoReply(app: App, runId: string, m: MentionInfo, text: string, by: "auto" | "owner"): Promise<Replied & { note: string }> {
  const { sendViaDoubao, recipientOf, doubaoOutcomeLine } = await import("./doubao-send.ts");
  const body = `${text}\n\n${app.config.lark.commands.signature}`.trim();
  const d = await sendViaDoubao(app, { body, to: recipientOf(app, m.senderId, m.senderName, m.chatId), runId });
  const line = doubaoOutcomeLine(d);
  const r: Replied & { ok: boolean; outcome: string; problem?: string } = {
    via: "doubao",
    by,
    at: new Date().toISOString(),
    messageId: d.messageId,
    chatId: m.chatId,
    where: `经豆包以你的身份在和 ${m.senderName} 的私聊里（带署名，${d.outcome === "verified" ? "已核对" : d.outcome === "unverified" ? "未核对" : "没有成功"}）`,
    ok: d.ok,
    outcome: d.outcome,
    ...(d.problem ? { problem: d.problem } : {}),
  };
  audit(app, by === "owner" ? OWNER : "agent", "lark.mention-reply", m.chatId, {
    runId, via: "doubao", by, ok: d.ok, outcome: d.outcome, report: d.report, problem: d.problem, raw: d.raw, doubaoSession: d.sessionId, doubaoApp: d.appId,
    messageId: d.messageId, triggeredBy: m.messageIds, text: truncate(text, 1000),
  });
  setRunOutput(app, runId, { mentionReply: r });
  // The owner clicked send and waits for the result; a failed or unchecked one they hear about however it was sent.
  if (by === "owner" || d.outcome !== "verified")
    notify(app, {
      title: d.ok ? `已回复 ${m.senderName}${d.outcome === "unverified" ? "（未核对）" : ""}` : `回复 ${m.senderName} 没有成功`,
      body: `${line}\n\n${d.ok ? "发出的内容" : "要发的内容"}：\n${truncate(body, 1500)}`,
      runId,
      link: `#/runs/${runId}`,
    });
  if (!d.ok) throw Object.assign(new HttpError(502, `${line}。已告诉本人，不要再发一次；在提醒里写清没有回复成功。`), { told: true });
  return { ...r, note: d.outcome === "unverified" ? "（豆包说已发出，没能读私聊核对）" : "（已在私聊里核对）" };
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

/**
 * The reply @s the asker once: where the text already names them (“@小王 …”, written by the handler)
 * that becomes the real mention; otherwise one goes in front. Both at once showed one working @ and
 * one plain “@小王”.
 */
export function atAsker(text: string, name: string, at: string | null | undefined) {
  if (!at) return text;
  const tag = `<at id=${at}></at>`;
  const i = name ? text.indexOf(`@${name}`) : -1;
  if (i < 0) return `${tag} ${text}`;
  return `${text.slice(0, i)}${tag}${text.slice(i + name.length + 1)}`;
}

/** The asker @-ed once, and everyone else the reply names who is in the chat. */
async function atEveryone(app: App, text: string, chatId: string, askerName: string, askerAt: string | null | undefined) {
  const { resolveMention } = await import("./lark-people.ts");
  const others = await atOthers(
    text,
    askerName,
    (name) => !!one(app.db, "select 1 from lark_people where name = ? limit 1", name),
    async (name) => {
      const r = await resolveMention(app, name, chatId);
      return "all" in r ? null : r.userId;
    },
  );
  return atAsker(others, askerName, askerAt);
}

/** `@名字` in a reply: the run of name characters after it (a space, punctuation or another @ ends it). */
const AT_NAME = /@([^\s@<>，。、；：！？,.;:!?（）()【】「」“”"']{1,20})/g;

/**
 * Every other `@名字` the handler wrote becomes a real mention when that person is in the chat
 * (`resolve`: lark-people resolveMention, which checks the chat's members); a name it cannot place
 * stays as written. A name run on into the next words (“@小李确认下”) is tried shortest-known first:
 * the longest prefix that is a known person.
 */
export async function atOthers(text: string, skip: string, known: (name: string) => boolean, resolve: (name: string) => Promise<string | null>) {
  let out = text;
  const done = new Set<string>([skip]);
  for (const m of [...text.matchAll(AT_NAME)]) {
    const run = m[1];
    let name = run;
    for (let n = Math.min(run.length, 12); n >= 2; n--) if (known(run.slice(0, n))) { name = run.slice(0, n); break; }
    if (done.has(name)) continue;
    done.add(name);
    const id = await resolve(name).catch(() => null);
    if (id) out = out.replace(`@${name}`, `<at id=${id}></at>`);
  }
  return out;
}
