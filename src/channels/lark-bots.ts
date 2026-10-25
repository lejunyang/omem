import * as lark from "@larksuiteoapi/node-sdk";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { OWNER, resolveIdentity } from "../core/users.ts";
import { registerThreadSender } from "../agents/inbox.ts";
import { findAgentSpec } from "../agents/specs.ts";
import { resolveThread, updateThread } from "../agents/threads.ts";
import { findSourceByUri, sourceText } from "../sources/store.ts";
import { answerFromChannel, resolveCitations } from "./common.ts";
import { chatSpace } from "./lark-personal.ts";
import { larkAppSecret } from "./lark-setup.ts";
import { larkBotInfo, postedByOmem, reactLark, sendLark, setLarkBotClient, unreactLark } from "./lark-send.ts";

/**
 * More Feishu bots beside the main one (lark.bots). Each is its own app with its own connection and
 * answers as the Agent profile it is bound to, in conversations of its own (channel `lark:<id>`),
 * when the owner or a user @-s it in a group or talks to it one-to-one. Captures, notifications,
 * cards and rules stay with the main bot.
 *
 * The bots know about one another: every turn in a group is told which omem bots are there and
 * what each does. A reply that @-s another omem bot hands the message to it through omem (not
 * through Feishu, where a bot's ids for another app are not known); `lark.botRelay` bounds how many
 * hand-offs follow one another before a person speaks again.
 */
export type LarkBot = App["config"]["lark"]["bots"][number];
/** "main" is the main bot; anything else one of lark.bots. */
export type BotRef = "main" | string;

type Turn = { chatId: string; topicId?: string; replyTo: string; text: string; from: BotRef };
const mainTurn: { run: ((t: Turn) => Promise<void>) | null } = { run: null };
/** The main bot takes hand-offs too (lark-bot.ts registers how it answers). */
export function registerMainRelay(fn: ((t: Turn) => Promise<void>) | null) {
  mainTurn.run = fn;
}

function kv(app: App, key: string, value?: string) {
  if (value === undefined) return one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
  return value;
}

/** What each omem bot is called in Feishu and what it does. */
export function botRoster(app: App): { ref: BotRef; name: string; role: string }[] {
  const out: { ref: BotRef; name: string; role: string }[] = [];
  const main = kv(app, "lark_bot_name");
  if (main) out.push({ ref: "main", name: main, role: "主助手（本人的个人助理）" });
  for (const b of app.config.lark.bots) {
    const info = larkBotInfo(b.id);
    if (!b.enabled || !info) continue;
    const spec = b.agent === "assistant" ? null : findAgentSpec(app, b.agent);
    out.push({ ref: b.id, name: info.name, role: spec ? `Agent 档案 ${spec.name}：${spec.description}` : "主助手角色（独立的会话）" });
  }
  return out;
}

/** The roster as the turn's context: who else is here, and how to hand something to them. */
export function rosterNote(app: App, self: BotRef) {
  const roster = botRoster(app);
  if (roster.length < 2) return "";
  const me = roster.find((r) => r.ref === self);
  return [
    `omem 在飞书里有这几个机器人${me ? `，你是「${me.name}」` : ""}：`,
    ...roster.map((r) => `- 「${r.name}」：${r.role}`),
    `要请另一位接手或一起讨论，在回复里写「@名字」并说清楚要它做什么，omem 会把你的回复转给它；它的回复也会这样回到你。不需要它时不要 @。机器人之间连续转交最多 ${app.config.lark.botRelay} 次，之后等本人发话。`,
  ].join("\n");
}

/** Bot-to-bot hand-offs in a row per chat (or topic), reset when a person speaks. */
const hops = new Map<string, number>();
const hopKey = (chatId: string, topicId?: string) => `${chatId}#${topicId ?? ""}`;
export function personSpoke(chatId: string, topicId?: string) {
  hops.delete(hopKey(chatId, topicId));
}

/**
 * After a bot posted `text` in a group: hand it to every other omem bot it @-s by name, within the
 * hand-off limit. Returns who it went to.
 */
export function relayMentions(app: App, from: BotRef, t: { chatId: string; topicId?: string; messageId: string; text: string }): BotRef[] {
  const roster = botRoster(app);
  const sender = roster.find((r) => r.ref === from);
  if (!sender) return [];
  const targets = roster.filter((r) => r.ref !== from && t.text.includes(`@${r.name}`));
  const key = hopKey(t.chatId, t.topicId);
  const sent: BotRef[] = [];
  for (const target of targets) {
    const n = hops.get(key) ?? 0;
    if (n >= app.config.lark.botRelay) break;
    hops.set(key, n + 1);
    const turn: Turn = { chatId: t.chatId, topicId: t.topicId, replyTo: t.messageId, text: `「${sender.name}」@ 了你：\n\n${t.text}`, from };
    const go = target.ref === "main" ? mainTurn.run?.(turn) : botTurn(app, target.ref, { ...turn, chatType: "group", userId: OWNER, asker: `机器人「${sender.name}」` });
    if (!go) continue;
    go.catch((e) => console.warn(`[omem] 转给机器人「${target.name}」失败：`, (e as Error).message));
    sent.push(target.ref);
  }
  return sent;
}

/** A real @ for the bots this one knows the id of (learned from people's mentions), plain text otherwise. */
export function renderBotMentions(app: App, self: BotRef, text: string) {
  let out = text;
  for (const r of botRoster(app)) {
    if (r.ref === self) continue;
    const id = kv(app, `lark_peer:${self}:${r.ref}`);
    if (id) out = out.replaceAll(`@${r.name}`, `<at id=${id}></at>`);
  }
  return out;
}

/**
 * A person's message names other omem bots among its mentions: remember their ids as this bot
 * sees them (open_ids differ per app), so its own replies can @ them for real.
 */
export function learnPeerIds(app: App, self: BotRef, mentions: { name?: string; id?: { open_id?: string } }[]) {
  const roster = botRoster(app);
  for (const m of mentions) {
    const peer = roster.find((r) => r.ref !== self && r.name === m.name);
    if (peer && m.id?.open_id) kv(app, `lark_peer:${self}:${peer.ref}`, m.id.open_id);
  }
}

/** Who wrote to this bot: the owner by this app's id, or a person the main bot knows by user_id. */
export function botSender(app: App, bot: LarkBot, sender: { open_id?: string; user_id?: string }): string | null {
  if (bot.ownerOpenId && sender.open_id === bot.ownerOpenId) return OWNER;
  if (!sender.user_id) return null;
  const known = one<{ bot_open_id: string | null }>(app.db, "select bot_open_id from lark_people where user_id = ?", sender.user_id);
  return known?.bot_open_id ? resolveIdentity(app, "lark", known.bot_open_id) : null;
}

/** Recent lines of the chat (captured by the main bot or the owner's lark-cli), in the topic when there is one. */
function chatContext(app: App, chatId: string, topicId?: string) {
  const s = findSourceByUri(app, chatSpace(app, chatId), `lark:${chatId}`);
  if (!s) return "";
  const lines = sourceText(app, s.id).split("\n").filter(Boolean);
  return (topicId ? lines.filter((l) => l.includes(`话题 ${topicId}]`)) : lines).slice(-15).join("\n");
}

/** One turn of a bot's conversation in a chat: answer as its profile, post as the bot, pass on @s. */
export async function botTurn(
  app: App,
  botId: string,
  t: { chatId: string; chatType: "p2p" | "group"; topicId?: string; replyTo: string; text: string; userId: string; asker?: string },
) {
  const bot = app.config.lark.bots.find((b) => b.id === botId && b.enabled);
  if (!bot) return;
  const isGroup = t.chatType === "group";
  const channel = `lark:${bot.id}`;
  const spaceId = isGroup ? chatSpace(app, t.chatId) : app.config.lark.defaultSpace;
  // The conversation answers as the bot's profile (read each time: changing it needs no restart).
  const { thread } = resolveThread(app, { channel, chatId: t.chatId, topicId: t.topicId, isGroup, spaceId, userId: t.userId });
  const spec = bot.agent === "assistant" ? undefined : bot.agent;
  if (thread.settings.spec !== spec) updateThread(app, thread.id, { settings: { ...thread.settings, spec } });
  const context = [rosterNote(app, bot.id), isGroup ? chatContext(app, t.chatId, t.topicId) : ""].filter(Boolean).join("\n\n");
  const working = await reactLark(t.replyTo, "OnIt", bot.id).catch(() => undefined);
  try {
    const answer = await answerFromChannel(
      app,
      { channel, chatId: t.chatId, topicId: t.topicId, isGroup, text: t.text, asker: t.asker, spaceId, context, contextLabel: t.topicId ? "话题里" : "群里", externalMessageId: t.replyTo, userId: t.userId },
      { onCard: async (card) => void (await sendLark({ replyTo: t.replyTo, inThread: !!t.topicId, bot: bot.id }, { card }).catch(() => null)) },
    );
    if (answer === null) return;
    const sent = await sendLark({ replyTo: t.replyTo, inThread: !!t.topicId, bot: bot.id }, { markdown: renderBotMentions(app, bot.id, answer) });
    if (isGroup && sent.messageId) relayMentions(app, bot.id, { chatId: t.chatId, topicId: t.topicId, messageId: sent.messageId, text: answer });
  } finally {
    if (working) await unreactLark(t.replyTo, working, bot.id);
  }
}

/** Text of a message to the bot: its own @ removed, other people and bots by name. */
function spokenText(raw: string | undefined, type: string | undefined, mentions: { key?: string; name?: string; id?: { open_id?: string } }[], selfOpenId: string | null) {
  let text = "";
  try {
    const c = JSON.parse(raw || "{}");
    text = type === "text" ? String(c.text ?? "") : type === "post" ? [c.title, ...((c.content ?? c.zh_cn?.content ?? []) as { text?: string }[][]).map((l) => l.map((n) => n.text ?? "").join(""))].filter(Boolean).join("\n") : "";
  } catch {}
  for (const m of mentions) if (m.key) text = text.replaceAll(m.key, m.id?.open_id === selfOpenId ? "" : `@${m.name ?? ""}`);
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

/** A message event as one of lark.bots received it. */
export async function onBotMessage(app: App, bot: LarkBot, data: any) {
  const msg = data?.message;
  if (!msg?.message_id) return;
  // Another omem bot's post: hand-offs go through relayMentions, not through Feishu.
  if (postedByOmem(msg.message_id)) return;
  if (run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values(?,?,'',?)", `lark-bot:${bot.id}`, msg.message_id, new Date().toISOString()).changes === 0) return;
  const self = larkBotInfo(bot.id)?.openId ?? null;
  const mentions = (msg.mentions ?? []) as { key?: string; name?: string; id?: { open_id?: string } }[];
  const chatType = msg.chat_type === "p2p" ? "p2p" : "group";
  const topicId = msg.thread_id || undefined;
  const fromApp = data.sender?.sender_type === "app";
  if (chatType === "group" && !fromApp) personSpoke(msg.chat_id, topicId);
  learnPeerIds(app, bot.id, mentions);
  if (chatType === "group" && !(self && mentions.some((m) => m.id?.open_id === self))) return;
  if (fromApp) return;
  const sender = data.sender?.sender_id ?? {};
  const userId = botSender(app, bot, sender);
  if (!userId) {
    if (chatType === "p2p" && !bot.ownerOpenId)
      await sendLark({ replyTo: msg.message_id, bot: bot.id }, { markdown: `还没有确认本人：在 omem 设置 → 渠道 → 其他机器人里，把这个机器人的本人 open_id 设为 \`${sender.open_id ?? ""}\`。` }).catch(() => {});
    return;
  }
  const text = spokenText(msg.content, msg.message_type, mentions, self);
  if (!text) return;
  await botTurn(app, bot.id, { chatId: msg.chat_id, chatType, topicId, replyTo: msg.message_id, text, userId });
}

/** Connect every enabled bot in lark.bots (the main bot is started by lark-bot.ts). */
export async function startLarkBots(app: App) {
  for (const bot of app.config.lark.bots.filter((b) => b.enabled)) {
    try {
      const secret = larkAppSecret(app.home, bot.appId, `OMEM_LARK_APP_SECRET_${bot.id.toUpperCase().replace(/-/g, "_")}`);
      if (!secret) throw new Error(`没有 ${bot.appId} 的 App Secret：运行 omem setup → 渠道 → 飞书 → 添加机器人`);
      const client = new lark.Client({ appId: bot.appId, appSecret: secret, domain: lark.Domain.Feishu });
      const info = (await client.request({ method: "GET", url: "/open-apis/bot/v3/info" })) as { bot?: { open_id?: string; app_name?: string } };
      setLarkBotClient(bot.id, client, info.bot?.open_id ?? null, info.bot?.app_name || bot.id);
      if (bot.agent !== "assistant" && !findAgentSpec(app, bot.agent)) console.warn(`[omem] 飞书机器人 ${bot.id} 绑定的 Agent 档案 ${bot.agent} 不存在，收到消息时会失败`);
      // Later results of its conversations (delegated work…) go back through the same bot.
      registerThreadSender(`lark:${bot.id}`, async (thread, raw) => {
        const [chatId, topic] = (thread.key ?? "").split("#");
        if (!chatId) return;
        const to = thread.settings.lastMessageId ? { replyTo: thread.settings.lastMessageId, inThread: !!topic } : { chatId };
        await sendLark({ ...to, bot: bot.id }, { markdown: renderBotMentions(app, bot.id, resolveCitations(app, raw)) });
      });
      const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
        "im.message.receive_v1": async (data: any) => {
          onBotMessage(app, bot, data).catch((e) => console.warn(`[omem] 飞书机器人 ${bot.id} 处理消息失败`, e));
          return {};
        },
      } as never);
      const ws = new lark.WSClient({ appId: bot.appId, appSecret: secret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
      await ws.start({ eventDispatcher: dispatcher });
      console.log(`[omem] 飞书机器人 ${bot.id}（${info.bot?.app_name ?? bot.appId}）已连接，回答者：${bot.agent}`);
    } catch (e) {
      console.warn(`[omem] 飞书机器人 ${bot.id} 启动失败：`, (e as Error).message);
    }
  }
}
