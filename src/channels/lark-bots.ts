import type { App } from "../core/app.ts";
import { currentBot } from "../core/bot-context.ts";
import { one, run } from "../core/db.ts";
import { OWNER, resolveIdentity } from "../core/users.ts";
import { findAgentSpec } from "../agents/specs.ts";
import { resolveThread, updateThread, type ThreadAddress } from "../agents/threads.ts";
import { findSourceByUri, sourceText } from "../sources/store.ts";
import { chatSpace } from "./lark-personal.ts";
import { larkBotInfo, larkClientFor } from "./lark-send.ts";

/**
 * Several Feishu bots (the main one, lark.appId, and lark.bots). Every bot runs the same code
 * (lark-bot.ts) and can do the same things: answer the owner, users and guests, show progress and
 * bubbles, post cards and take their clicks, @ people, buzz them, whisper to some members. What
 * differs per bot is its app identity and who answers in its conversations (`agent`); conversations
 * of lark.bots have channel `lark:<id>`, the main bot's `lark`.
 *
 * A chat's housekeeping (capturing its messages, running rules on them) is done once: by the main
 * bot when it is in the chat, otherwise by the omem bot that is. Owner notifications not tied to a
 * conversation go through the main bot; the rest follows the conversation it belongs to.
 *
 * The bots know about one another: every turn in a group is told which omem bots are there and
 * what each does. A reply that @-s another omem bot hands the message to it through omem (Feishu
 * does not hand one bot's post to another reliably); `lark.botRelay` bounds how many hand-offs
 * follow one another before a person speaks again.
 */
export type LarkBot = App["config"]["lark"]["bots"][number];
/** "main" is the main bot; anything else one of lark.bots. */
export type BotRef = "main" | string;

export type Turn = { chatId: string; topicId?: string; replyTo: string; text: string; from: BotRef };
const relays = new Map<BotRef, (t: Turn) => Promise<void>>();
/** How a bot answers a hand-off from another bot (lark-bot.ts registers one per connected bot). */
export function registerRelay(ref: BotRef, fn: ((t: Turn) => Promise<void>) | null) {
  if (fn) relays.set(ref, fn);
  else relays.delete(ref);
}

/** What each connected omem bot is called in Feishu and who answers for it. */
export function botRoster(app: App): { ref: BotRef; name: string; role: string }[] {
  const out: { ref: BotRef; name: string; role: string }[] = [];
  const main = one<{ value: string }>(app.db, "select value from kv where key = 'lark_bot_name'")?.value ?? larkBotInfo("main")?.name;
  if (main && larkBotInfo("main")) out.push({ ref: "main", name: main, role: "主助手（本人的个人助理）" });
  for (const b of app.config.lark.bots) {
    const info = larkBotInfo(b.id);
    if (!b.enabled || !info) continue;
    const spec = b.agent === "assistant" ? null : findAgentSpec(app, b.agent);
    out.push({ ref: b.id, name: info.name, role: spec ? `Agent 档案 ${spec.name}：${spec.description}` : "主助手角色（独立的会话）" });
  }
  return out;
}

/** The roster as a turn's context: who else is here, and how to hand something to them. */
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
  const key = hopKey(t.chatId, t.topicId);
  const sent: BotRef[] = [];
  for (const target of roster.filter((r) => r.ref !== from && t.text.includes(`@${r.name}`))) {
    const answer = relays.get(target.ref);
    const n = hops.get(key) ?? 0;
    if (!answer || n >= app.config.lark.botRelay) continue;
    hops.set(key, n + 1);
    answer({ chatId: t.chatId, topicId: t.topicId, replyTo: t.messageId, text: `「${sender.name}」@ 了你：\n\n${t.text}`, from })
      .catch((e) => console.warn(`[omem] 转给机器人「${target.name}」失败：`, (e as Error).message));
    sent.push(target.ref);
  }
  return sent;
}

/** A real @ for the bots this one knows the id of (learned from people's mentions), plain text otherwise. */
export function renderBotMentions(app: App, self: BotRef, text: string) {
  let out = text;
  for (const r of botRoster(app)) {
    if (r.ref === self) continue;
    const id = one<{ value: string }>(app.db, "select value from kv where key = ?", `lark_peer:${self}:${r.ref}`)?.value;
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
    if (peer && m.id?.open_id)
      run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", `lark_peer:${self}:${peer.ref}`, m.id.open_id);
  }
}

/** Who wrote to one of lark.bots: the owner by this app's id, or a person the main bot knows by user_id. */
export function botSender(app: App, bot: LarkBot, sender: { open_id?: string; user_id?: string }): string | null {
  if (bot.ownerOpenId && sender.open_id === bot.ownerOpenId) return OWNER;
  if (!sender.user_id) return null;
  const known = one<{ bot_open_id: string | null }>(app.db, "select bot_open_id from lark_people where user_id = ? and bot_open_id is not null", sender.user_id);
  return known?.bot_open_id ? resolveIdentity(app, "lark", known.bot_open_id) : null;
}

/** The omem user behind a Feishu sender or card operator, as the given bot sees them. */
export function larkUser(app: App, ids: { open_id?: string; user_id?: string }, bot: BotRef = currentBot()): string | null {
  if (bot === "main") return resolveIdentity(app, "lark", ids.open_id);
  const b = app.config.lark.bots.find((x) => x.id === bot);
  return b ? botSender(app, b, ids) : null;
}

/** The conversation channel of a bot. */
export const botChannel = (bot: BotRef) => (bot === "main" ? "lark" : `lark:${bot}`);

/** Before a turn of one of lark.bots: its conversation answers as the bot's profile (read each time). */
export function bindAnswerer(app: App, bot: BotRef, addr: ThreadAddress) {
  if (bot === "main") return;
  const agent = app.config.lark.bots.find((b) => b.id === bot)?.agent ?? "assistant";
  const spec = agent === "assistant" ? undefined : agent;
  const { thread } = resolveThread(app, addr);
  if (thread.settings.spec !== spec) updateThread(app, thread.id, { settings: { ...thread.settings, spec } });
}

/** Recent lines of the chat (whoever captured it), in the topic when there is one. */
export function chatContext(app: App, chatId: string, topicId?: string) {
  const s = findSourceByUri(app, chatSpace(app, chatId), `lark:${chatId}`);
  if (!s) return "";
  const lines = sourceText(app, s.id).split("\n").filter(Boolean);
  return (topicId ? lines.filter((l) => l.includes(`话题 ${topicId}]`)) : lines).slice(-15).join("\n");
}

const mainMember = new Map<string, { at: number; yes: boolean }>();
/**
 * Whether this bot keeps the chat's records (capture, rules, watched chats): the main bot always;
 * another bot only where the main bot is not a member (a bot can read only chats it is in).
 */
export async function keepsRecords(bot: BotRef, chatId: string): Promise<boolean> {
  if (bot === "main" || !larkBotInfo("main")) return true;
  const c = mainMember.get(chatId);
  if (c && Date.now() - c.at < 60 * 60_000) return !c.yes;
  let yes = false;
  try {
    const r = await larkClientFor("main").im.chat.get({ path: { chat_id: chatId } });
    yes = !r?.code && !!r?.data;
  } catch {}
  mainMember.set(chatId, { at: Date.now(), yes });
  return !yes;
}
export function setMainMemberForTests(chatId: string, yes: boolean) {
  mainMember.set(chatId, { at: Date.now(), yes });
}

/** Connect every enabled bot in lark.bots (the main bot is started on its own). */
export async function startLarkBots(app: App) {
  const { startLarkBot } = await import("./lark-bot.ts");
  for (const bot of app.config.lark.bots.filter((b) => b.enabled))
    await startLarkBot(app, bot.id).catch((e) => console.warn(`[omem] 飞书机器人 ${bot.id} 启动失败：`, (e as Error).message));
}
