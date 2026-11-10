import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { captureSpace } from "../core/capture-space.ts";
import { notify } from "../core/notify.ts";
import { now, truncate } from "../core/util.ts";
import { createRun, getRun, queuedInLane, registerHandler, updateQueuedRun, type RunContext } from "../agents/runs.ts";
import { runRole } from "../agents/runner.ts";
import { quietReason } from "../agents/quiet.ts";
import { fmtTime, isApp, mentionIds, messageText, timeMs, type LarkMessage } from "./lark-messages.ts";
import { ownerAlreadyHandled } from "./notify-gate.ts";
import { watchRule } from "./lark-watch.ts";

/**
 * Someone looking for the owner: a person @-ing them in a group, or writing to them one-to-one.
 * The host only notices, waits and checks; the liaison role (roles/liaison.md) reads the context,
 * looks up what is already known, moves what it can and writes the notification. When it fails, runs
 * too long or ends without a word, the short reminder (who, where, what they said) goes out instead,
 * so nothing is missed because the homework did not work out.
 *
 * Each message once (handled_messages, channel lark-mention), whichever path saw it first (the bot in
 * real time, the owner's capture). One run per chat at a time: later messages of the same chat join
 * the run still waiting. The run starts `delayMinutes` after the message; by then a message the owner
 * read, reacted to or answered needs nothing, and costs nothing.
 */
export const MENTION_CHANNEL = "lark-mention";
/** Messages older than this when first seen (a chat read for the first time) are history, not someone waiting. */
const FRESH_MS = 6 * 3600_000;
/** How many times a run waits for the ingest run reading the same lines (a minute each). */
const INGEST_WAITS = 8;

export type MentionChat = { id: string; name: string; kind: "p2p" | "group" };
type Input = { chatId: string; chatName: string; chatKind: "p2p" | "group"; messageIds: string[]; waited?: number };

/** Whether this message is someone (not the owner, not a bot) looking for the owner. */
function looksForOwner(app: App, chat: MentionChat, m: LarkMessage, owner: string) {
  if (m.msg_type === "system" || !m.sender?.id || m.sender.id === owner || isApp(m) || m.sender.id === app.config.lark.appId) return false;
  if (Date.now() - timeMs(m.create_time) > FRESH_MS) return false;
  return chat.kind === "p2p" ? app.config.lark.mentions.p2p : mentionIds(m).includes(owner);
}

/**
 * Queue the liaison for the messages in a captured batch that look for the owner. Call after the
 * messages are stored (their lines are what the run cites). `owner`: the owner's id as the reading app sees it.
 */
export function queueMentionPrep(app: App, chat: MentionChat, messages: LarkMessage[], owner: string | undefined) {
  const cfg = app.config.lark.mentions;
  if (!cfg.enabled || !owner) return null;
  // A watched chat has its own handler, which sees these messages already.
  if (watchRule(app, chat.id)) return null;
  const picked = messages.filter((m) => looksForOwner(app, chat, m, owner))
    .filter((m) => run(app.db, "insert or ignore into handled_messages(channel,message_id,rule,at) values(?,?,?,?)", MENTION_CHANNEL, m.message_id, chat.id, now()).changes > 0);
  if (!picked.length) return null;
  const lane = `mention:${chat.id}`;
  const ids = picked.map((m) => m.message_id);
  const waiting = queuedInLane(app, lane, "mention-prep");
  if (waiting) {
    const input = waiting.input as Input;
    updateQueuedRun(app, waiting.id, { input: { ...input, messageIds: [...new Set([...input.messageIds, ...ids])] } });
    return getRun(app, waiting.id);
  }
  const latest = Math.max(...picked.map((m) => timeMs(m.create_time)));
  const startAt = Math.max(Date.now() + 1_000, latest + cfg.delayMinutes * 60_000);
  const spaceId = one<{ space_id: string }>(app.db, "select s.space_id from lark_messages m join sources s on s.id = m.source_id where m.message_id = ? and s.deleted_at is null", ids[0])?.space_id ?? captureSpace(app, chat.id);
  const who = picked[0].sender?.name ?? "有人";
  return createRun(app, {
    kind: "mention-prep",
    spaceId,
    lane,
    notBefore: new Date(startAt).toISOString(),
    title: chat.kind === "p2p" ? `${who} 私聊找你` : `${who} 在「${chat.name}」找你`,
    input: { chatId: chat.id, chatName: chat.name, chatKind: chat.kind, messageIds: ids } satisfies Input,
  });
}

type Found = { id: string; sender: string; atMs: number; text: string; topicId: string | null; quoted: string | null; sourceId: string | null; ref: string | null };

/** The stored messages with the chat line each one is (its citation). */
function storedMessages(app: App, ids: string[]): Found[] {
  const out: Found[] = [];
  for (const id of ids) {
    const m = one<{ message_id: string; chat_id: string; thread_id: string | null; parent_id: string | null; sender_name: string; msg_type: string; content: string; create_ms: number; source_id: string | null; line: number | null }>(app.db, "select * from lark_messages where message_id = ?", id);
    if (!m) continue;
    const at = one<{ source_id: string; line: number }>(app.db, "select l.source_id, l.line from lark_message_lines l join sources s on s.id = l.source_id where l.message_id = ? and s.deleted_at is null order by (l.source_id = ?) desc, s.captured_at limit 1", id, m.source_id ?? "");
    const parent = m.parent_id ? one<{ sender_name: string; content: string }>(app.db, "select sender_name, content from lark_messages where message_id = ?", m.parent_id) : undefined;
    out.push({
      id,
      sender: m.sender_name || "?",
      atMs: m.create_ms,
      text: messageText({ content: m.content, msg_type: m.msg_type }),
      topicId: m.thread_id,
      quoted: parent ? `${parent.sender_name}：${truncate(messageText({ content: parent.content, msg_type: "text" }), 200)}` : null,
      sourceId: at?.source_id ?? null,
      ref: at ? `src:${at.source_id}#L${at.line}` : null,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** Someone else already took the message: a watch or a rule's agent handles it. */
function takenElsewhere(app: App, chatId: string, m: Found) {
  // Channel `lark` is a watch's handler (lark-watch.ts); the bots' own rows only record delivery.
  if (watchRule(app, chatId) || one(app.db, "select 1 from handled_messages where message_id = ? and channel = 'lark'", m.id)) return true;
  return !!one(app.db,
    `select 1 from rule_firings f join rules r on r.id = f.rule_id
      where f.event_key in (?, ?) and f.at >= ? and exists (select 1 from json_each(r.actions) a where json_extract(a.value, '$.type') = 'agent')`,
    `lark:${m.id}`, `chat:${chatId}`, new Date(m.atMs).toISOString());
}

/** The ingest run reading these lines, still to come or under way. */
function ingestPending(app: App, sourceIds: string[]) {
  if (!sourceIds.length) return false;
  return !!one(app.db,
    `select 1 from runs where kind = 'ingest' and status in ('queued','running')
      and exists (select 1 from json_each(runs.input, '$.sourceIds') j where j.value in (${sourceIds.map(() => "?").join(",")}))`,
    ...sourceIds);
}

/** The short reminder: who, where, what they said, with the message to open. */
function fallback(app: App, input: Input, messages: Found[], runId: string, why: string) {
  const first = messages[0];
  const where = input.chatKind === "p2p" ? "私聊" : `在「${input.chatName}」`;
  const senders = [...new Set(messages.map((m) => m.sender))];
  const title = senders.length === 1 ? `${senders[0]} ${where}找你` : `${senders.join("、")} ${where}找你`;
  const body = [
    ...messages.map((m) => `**${m.sender}**（${fmtTime(m.atMs)} UTC）：${truncate(m.text.replace(/\s+/g, " "), 300)}${m.ref ? ` [原消息](${m.ref})` : ""}`),
    "",
    `（${why}，没来得及查背景。）`,
  ].join("\n");
  try {
    return notify(app, { title, body, sourceRefs: messages.map((m) => m.ref).filter((r): r is string => !!r), runId, link: `#/runs/${runId}` });
  } catch (e) {
    // Already told by another run a moment ago (409): nothing to add.
    console.warn(`[omem] 有人找你的简短提醒没有发出（${first?.id}）：${(e as Error).message}`);
    return null;
  }
}

function task(input: Input, messages: Found[]) {
  const where = input.chatKind === "p2p" ? `和 ${messages[0]?.sender ?? "对方"} 的私聊（${input.chatId}）` : `群「${input.chatName}」（${input.chatId}）`;
  const lines = messages.map((m) => [
    `- ${m.sender}，${fmtTime(m.atMs)} UTC，飞书消息 ${m.id}${m.topicId ? `，话题 ${m.topicId}` : ""}${m.ref ? `，原件 ${m.ref}` : "（没有存进原件）"}`,
    ...(m.quoted ? [`  引用了：${m.quoted}`] : []),
    `  ${truncate(m.text, 1500).replace(/\n/g, "\n  ")}`,
  ].join("\n"));
  return `# 有人找本人\n\n${where}里有人找本人，本人到现在还没有看、没有回表情、也没有回复：\n\n${lines.join("\n")}\n\n先做功课再提醒本人，做法见角色说明。`;
}

registerHandler("mention-prep", async (ctx: RunContext) => {
  const { app } = ctx;
  const input = ctx.run.input as Input;
  const stored = storedMessages(app, input.messageIds);
  // Still the owner's to answer: not read, reacted to or answered meanwhile, and nobody else took it.
  const open: Found[] = [];
  for (const m of stored) {
    if (takenElsewhere(app, input.chatId, m)) continue;
    if (m.ref && (await ownerAlreadyHandled(app, { sourceRefs: [m.ref] }))) continue;
    open.push(m);
  }
  if (!open.length) return { quiet: true, summary: "本人已经看过或回复了，或者已经有别的处理者在管，不用提醒" };
  // The ingest run on these lines first: its items are what the liaison links to, not duplicates.
  const sources = [...new Set(open.map((m) => m.sourceId).filter((s): s is string => !!s))];
  if ((input.waited ?? 0) < INGEST_WAITS && ingestPending(app, sources)) {
    createRun(app, { kind: "mention-prep", spaceId: ctx.run.spaceId, lane: `mention:${input.chatId}`, notBefore: new Date(Date.now() + 60_000).toISOString(), title: ctx.run.title, input: { ...input, waited: (input.waited ?? 0) + 1 } });
    return { quiet: true, summary: "这几条消息的整理还没做完，一分钟后再看" };
  }
  const cfg = app.config.lark.mentions;
  const timeout = AbortSignal.timeout(cfg.timeoutMinutes * 60_000);
  try {
    const r = await runRole(app, {
      role: "liaison",
      spaceId: ctx.run.spaceId!,
      task: task(input, open),
      runId: ctx.run.id,
      signal: AbortSignal.any([ctx.signal, timeout]),
      onEvent: (e) => ctx.event(e.type, e),
      lark: { chats: [] },
    });
    run(app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
    const quiet = quietReason(app, ctx.run.id);
    if (quiet) return { quiet: true, summary: r.text.trim() || quiet };
    if (!one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", ctx.run.id)) {
      const n = fallback(app, input, open, ctx.run.id, "做功课的运行没有发出提醒");
      return { summary: `${r.text.trim()}\n\n（没有发出提醒，${n ? "已发简短提醒" : "简短提醒也没有发出"}）`.trim() };
    }
    return { summary: r.text.trim() };
  } catch (e) {
    // Cancelled by hand or by a restart (the run comes back): no reminder from here.
    if (ctx.signal.aborted && !timeout.aborted) throw e;
    const why = timeout.aborted ? `做功课超过 ${cfg.timeoutMinutes} 分钟` : `做功课失败（${truncate((e as Error).message, 120)}）`;
    // Whatever it notified before failing stands; only the silence is filled.
    if (!one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", ctx.run.id)) fallback(app, input, open, ctx.run.id, why);
    throw new Error(`${why}，已发出简短提醒`);
  }
});

/** Lines of these sources handed to the liaison lately (the ingest run leaves their notification to it). */
export function handedToLiaison(app: App, sourceIds: string[]): string[] {
  if (!sourceIds.length || !app.config.lark.mentions.enabled) return [];
  return all<{ source_id: string; line: number }>(app.db,
    `select l.source_id, l.line from handled_messages h join lark_message_lines l on l.message_id = h.message_id
      where h.channel = ? and h.at > ? and l.source_id in (${sourceIds.map(() => "?").join(",")}) order by l.source_id, l.line`,
    MENTION_CHANNEL, new Date(Date.now() - FRESH_MS).toISOString(), ...sourceIds).map((r) => `src:${r.source_id}#L${r.line}`);
}
