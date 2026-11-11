import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { addRunEvent, cancelRun, getRun, setRunOutput, type Run, type RunContext } from "./runs.ts";
import { mayStayQuiet, quietReason } from "./quiet.ts";
import { addScope, chatName, conclusionOf, relatedNote, scopeOf } from "./run-scope.ts";
import { candidatesNote, itemPlacesNote, linkRunPlaces, placeView } from "../items/places.ts";

/**
 * Runs that know about each other and about the owner (docs/v2/awareness.md). Four pieces, all
 * decided by the host from what it already records (run_scope, lark_messages, messages, items):
 *
 * - awarenessNote: what a run is told when it starts — the other runs working on the same chat,
 *   message or item (run-scope.ts), the other places the items of its conversation go on in, and
 *   candidates for an item when none is linked yet (items/places.ts).
 * - ownerMoves: what the owner said inside a run's scope since it was queued — in its chat and topic,
 *   in reply to the messages that started it, or in another conversation linked to an item it touched.
 * - Before a background run (one nobody waits on, quiet.ts mayStayQuiet) posts — notify, a Feishu
 *   message or card, a reply to the asker, its final answer — those words go back to it once
 *   (preSendCheck, recheckAnswer); after that it posts what it decides. The notification gate's signals
 *   (the triggering message read or reacted to, notify-gate.ts) are part of the same check, and a
 *   notification from a run that went through it is not gated again when it is pushed.
 * - While a background run works, the owner's new words in its scope come with its next tool result,
 *   each once (ownerNews); a run the owner takes over is stopped with what it had found (takeOverRun).
 */

/** Tools that post where someone reads it. (A meeting's live answers are left alone: holding them back would make them late.) */
const SENDS = new Set(["notify", "lark_send", "lark_card", "lark_send_file", "reply_to_asker"]);
/**
 * The background work this applies to: conversation turns and Agent runs nobody waits on (wake-ups,
 * watched groups, rules, handlings of someone looking for the owner), and the roles that tell the
 * owner things by themselves. Not coding, reviews, Wiki or memory work: they do not post to the owner.
 */
const BACKGROUND_KINDS = new Set(["ask", "agent", "heartbeat", "ingest", "brief", "item-settle"]);

type Aware = { seen?: string[]; recheckedAt?: string; recheck?: { by: string; lines: number } };
const awareOf = (r: Run) => (r.output.awareness ?? {}) as Aware;

function setAware(app: App, runId: string, patch: Aware) {
  const cur = awareOf(getRun(app, runId));
  setRunOutput(app, runId, { awareness: { ...cur, ...patch, seen: [...new Set([...(cur.seen ?? []), ...(patch.seen ?? [])])] } });
}

/** A run nobody waits on (a wake-up, a watched group's batch, a rule's agent, a handling of someone looking for the owner, the heartbeat…). */
export function isBackground(app: App, r: Run) {
  try {
    return BACKGROUND_KINDS.has(r.kind) && mayStayQuiet(app, r);
  } catch {
    return false;
  }
}

// ---- what a run is told when it starts --------------------------------------------------------------

/**
 * The run's awareness sections (related runs, the item's other places, candidates), separated from
 * the task by a rule; "" when there is nothing. Never fails a run.
 */
export function awarenessNote(app: App, runId: string | null | undefined): string {
  if (!runId) return "";
  try {
    const r = getRun(app, runId);
    const userId = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", runId)?.user_id ?? OWNER;
    const parts = [
      relatedNote(app, runId),
      itemPlacesNote(app, runId, userId),
      r.kind === "ask" || r.kind === "agent" ? candidatesNote(app, runId, userId) : "",
    ].filter(Boolean);
    return parts.length ? `\n\n---\n\n${parts.join("\n\n")}` : "";
  } catch (e) {
    console.warn(`[omem] 运行 ${runId} 的相关工作说明没能生成：${(e as Error).message}`);
    return "";
  }
}

// ---- the owner's words in a run's scope -------------------------------------------------------------

export type OwnerMove = { key: string; at: string; where: string; text: string; why: "chat" | "reply" | "item" | "conversation" };

const WHY: Record<OwnerMove["why"], string> = { chat: "同一个会话", reply: "回复了触发你的消息", item: "同一件事项的另一个会话", conversation: "同一个会话" };

/**
 * What the owner (the person the run works for) said in the run's scope after it was queued, oldest
 * first, without what it has already been shown: Feishu lines in its chat and topic or in reply to the
 * messages that started it, and words in its conversations or in conversations and chats linked to an
 * item it touched. The run's own posts (as the bot, or as the owner for a reply to the asker) and the
 * messages it answers are not counted.
 */
export function ownerMoves(app: App, runId: string): OwnerMove[] {
  const r = getRun(app, runId);
  const userId = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", runId)?.user_id ?? OWNER;
  const since = r.createdAt;
  const sinceMs = Date.parse(since);
  const keys = scopeOf(app, runId);
  const triggers = keys.filter((k) => k.kind === "message").map((k) => k.key);
  const chats = keys.filter((k) => k.kind === "chat");
  const convs = new Map<string, OwnerMove["why"]>(keys.filter((k) => k.kind === "conversation").map((k) => [k.key, "conversation"]));
  const itemChats = new Set<string>();
  for (const item of keys.filter((k) => k.kind === "item")) {
    for (const m of all<{ kind: string; ref: string }>(app.db, "select kind, ref from item_materials where item_id = ? and kind in ('conversation','source')", item.key)) {
      if (m.kind === "conversation") { if (!convs.has(m.ref)) convs.set(m.ref, "item"); continue; }
      const uri = one<{ uri: string }>(app.db, "select uri from sources where id = ? and kind = 'chat'", m.ref)?.uri;
      if (uri?.startsWith("lark:oc_")) itemChats.add(uri.slice(5));
    }
  }
  const seen = new Set(awareOf(r).seen ?? []);
  const own = new Set<string>([
    ...triggers,
    ...all<{ message_id: string }>(app.db, "select message_id from lark_sent where run_id = ?", runId).map((x) => x.message_id),
    ...[(r.output.mentionReply as { messageId?: string | null } | undefined)?.messageId].filter((x): x is string => !!x),
  ]);
  const out: OwnerMove[] = [];
  const add = (m: OwnerMove) => { if (!seen.has(m.key) && !out.some((x) => x.key === m.key)) out.push(m); };
  const chatIds = [...new Set([...chats.map((c) => c.key), ...itemChats])];
  if (chatIds.length || triggers.length) {
    const rows = all<{ message_id: string; chat_id: string; thread_id: string | null; parent_id: string | null; content: string; create_ms: number }>(app.db,
      `select message_id, chat_id, thread_id, parent_id, content, create_ms from lark_messages
        where sender_kind = 'owner' and create_ms > ?
          and (chat_id in (${chatIds.map(() => "?").join(",") || "''"}) or parent_id in (${triggers.map(() => "?").join(",") || "''"}))
        order by create_ms limit 50`,
      sinceMs, ...chatIds, ...triggers);
    for (const m of rows) {
      if (own.has(m.message_id)) continue;
      let why: OwnerMove["why"] | null = m.parent_id && triggers.includes(m.parent_id) ? "reply" : null;
      if (!why) {
        const mine = chats.filter((c) => c.key === m.chat_id);
        // Topics count only when both sides have one: many captured lines carry no topic.
        if (mine.some((c) => !c.topic || !m.thread_id || c.topic === m.thread_id)) why = "chat";
        else if (itemChats.has(m.chat_id)) why = "item";
      }
      if (!why) continue;
      add({ key: `lark:${m.message_id}`, at: new Date(m.create_ms).toISOString(), where: `飞书「${truncate(chatName(app, m.chat_id), 30)}」${m.thread_id ? "的话题" : ""}`, text: truncate(m.content.replace(/\s+/g, " "), 300), why });
    }
  }
  if (convs.size) {
    const ids = [...convs.keys()];
    const inputIds = new Set((r.input.messageIds as string[] | undefined) ?? []);
    const rows = all<{ id: string; conversation_id: string; text: string; created_at: string; ext: string | null; title: string }>(app.db,
      `select m.id, m.conversation_id, m.text, m.created_at, json_extract(m.meta, '$.externalId') ext, c.title from messages m join conversations c on c.id = m.conversation_id
        where m.conversation_id in (${ids.map(() => "?").join(",")}) and m.role = 'user' and m.created_at > ? and coalesce(m.run_id, '') != ?
          and c.user_id = ? and coalesce(json_extract(m.meta, '$.userId'), 'owner') = ?
          and json_extract(m.meta, '$.speaker') is null and json_extract(m.meta, '$.asker') is null and json_extract(m.meta, '$.wake') is null
          and json_extract(m.meta, '$.command') is null and json_extract(m.meta, '$.agentReport') is null and json_extract(m.meta, '$.codeResult') is null
        order by m.created_at limit 50`,
      ...ids, since, runId, userId, userId);
    for (const m of rows) {
      if (inputIds.has(m.id) || (m.ext && own.has(m.ext))) continue;
      add({ key: m.ext ? `lark:${m.ext}` : `msg:${m.id}`, at: m.created_at, where: `会话「${truncate(m.title || m.conversation_id, 30)}」（${m.conversation_id}）`, text: truncate(m.text.replace(/\s+/g, " "), 300), why: convs.get(m.conversation_id)! });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const stamp = (app: App, iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const moveLines = (app: App, moves: OwnerMove[]) => moves.map((m) => `- ${stamp(app, m.at)} ${m.where}（${WHY[m.why]}，${m.key.replace(/^lark:/, "飞书消息 ").replace(/^msg:/, "msg:")}）：${m.text}`).join("\n");

/** The notification gate's signals on what started the run or what it cites: the owner already read, reacted to or answered it. */
async function alreadySeen(app: App, refs: string[]): Promise<boolean> {
  if (!refs.length || !app.config.notify.onlyUnread) return false;
  try {
    const { ownerAlreadyHandled } = await import("../channels/notify-gate.ts");
    return await ownerAlreadyHandled(app, { sourceRefs: refs });
  } catch {
    return false;
  }
}

function recheckText(app: App, r: Run, moves: OwnerMove[], seenRefs: boolean, what: string) {
  return [
    `本人在你这次工作开始（${stamp(app, r.createdAt)}）之后说了话，${what}先没有发出：`,
    ...(moves.length ? ["", moveLines(app, moves)] : []),
    ...(seenRefs ? ["", "另外，引用的那几条消息本人已经看过（已读、回了表情，或之后在同一个会话里回复过）。"] : []),
    "",
    "对照这些看你的结论还成立吗：",
    "- 还要说：按本人说的改写（并进本人补充的，去掉本人已经知道或已经办了的），再发；",
    "- 本人已经处理了、或者已经不用再说：调用 stay_quiet（写一句原因）结束。",
    "这次复核每次运行只有一次，之后再发不会再拦。",
  ].join("\n");
}

/**
 * Before a background run posts (SENDS): when the owner spoke in its scope since it was queued, or
 * already read or answered what a notification cites, the call is not made and those words go back
 * to the run — once per run. Null: go ahead.
 */
export async function preSendCheck(app: App, runId: string | null | undefined, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean } | null> {
  if (!runId || !SENDS.has(name)) return null;
  let r: Run;
  try { r = getRun(app, runId); } catch { return null; }
  if (r.status !== "running" || awareOf(r).recheckedAt || !isBackground(app, r)) return null;
  const moves = ownerMoves(app, runId);
  const refs = name === "notify" && Array.isArray(args.source_refs) ? (args.source_refs as string[]) : [];
  const seenRefs = await alreadySeen(app, refs);
  if (!moves.length && !seenRefs) return null;
  setAware(app, runId, { seen: moves.map((m) => m.key), recheckedAt: now(), recheck: { by: name, lines: moves.length } });
  addRunEvent(app, runId, "status", { text: `发出前复核：本人在这次运行开始之后${moves.length ? `说了 ${moves.length} 句相关的话` : "已经看过引用的消息"}，${name} 先不发，交回给它再看一遍` });
  return { text: recheckText(app, r, moves, seenRefs, `这次 ${name} `), isError: false };
}

/**
 * The same check on a background run's final answer, which the host posts after the turn: when it
 * applies, `rerun` gets one more turn with the owner's words and the draft, and its answer (or its
 * stay_quiet) replaces the draft. `task` is the run's task, for a turn that cannot continue the session.
 */
export async function recheckAnswer(ctx: Pick<RunContext, "app" | "run" | "event">, draft: string, rerun: (prompt: string) => Promise<string>, task?: string): Promise<string> {
  const { app } = ctx;
  const runId = ctx.run.id;
  let r: Run;
  try { r = getRun(app, runId); } catch { return draft; }
  if (awareOf(r).recheckedAt || quietReason(app, runId) || !isBackground(app, r)) return draft;
  const moves = ownerMoves(app, runId);
  const refs = ((r.input.mention as { refs?: string[] } | undefined)?.refs) ?? [];
  const seenRefs = await alreadySeen(app, refs);
  if (!moves.length && !seenRefs) return draft;
  setAware(app, runId, { seen: moves.map((m) => m.key), recheckedAt: now(), recheck: { by: "answer", lines: moves.length } });
  ctx.event("status", { text: `发出前复核：本人在这次运行开始之后${moves.length ? `说了 ${moves.length} 句相关的话` : "已经看过触发的消息"}，回答先不发，再过一轮` });
  const prompt = [
    "# 发出前复核",
    "",
    recheckText(app, r, moves, seenRefs, "你这一轮的回答"),
    "",
    "你准备发出的回答：",
    "",
    "<<<",
    truncate(draft, 4000),
    ">>>",
    ...(task ? ["", "这次任务的原文（供对照）：", "", truncate(task, 2000)] : []),
    "",
    "还要说就直接写出最终的回答（它会代替上面那份发出），不要提到这次复核。",
  ].join("\n");
  try {
    const text = await rerun(prompt);
    if (quietReason(app, runId)) return text;
    return text.trim() || draft;
  } catch (e) {
    ctx.event("status", { text: `复核那一轮出错（${truncate((e as Error).message, 120)}），按原来的回答发出` });
    return draft;
  }
}

/**
 * What the owner said in a running background run's scope since it last heard, for the end of its
 * next tool result; each message once. "" when nothing new.
 */
export function ownerNews(app: App, runId: string | null | undefined): string {
  if (!runId) return "";
  let r: Run;
  try { r = getRun(app, runId); } catch { return ""; }
  if (r.status !== "running" || !isBackground(app, r)) return "";
  const moves = ownerMoves(app, runId);
  if (!moves.length) return "";
  setAware(app, runId, { seen: moves.map((m) => m.key) });
  addRunEvent(app, runId, "status", { text: `本人在这次运行的范围里说了 ${moves.length} 句话，附在工具结果后交给它` });
  return [
    "",
    "---",
    "# 本人刚说了（和你在办的事有关）",
    "",
    moveLines(app, moves),
    "",
    "这是你工作期间本人说的：结合它接着做；本人已经处理了的不要再提醒，已经不用做了就调用 stay_quiet 结束。",
  ].join("\n");
}

/**
 * The notification came from a run that already went through the check before it posted: the push
 * does not gate it a second time (lark-bot.ts), it posts what the run decided.
 */
export function checkedBeforeSend(app: App, runId: string | null | undefined): boolean {
  if (!runId) return false;
  return !!one(app.db, "select 1 from runs where id = ? and json_extract(output, '$.awareness.recheckedAt') is not null", runId);
}

// ---- tools the host watches ----------------------------------------------------------------------

/** The item ids an item tool call names or made. */
function itemsOfCall(name: string, args: Record<string, unknown>, text: string): string[] {
  if (name === "read_item" || name === "propose_item_update") return [args.item_id].filter((x): x is string => typeof x === "string");
  if (name === "upsert_item") return [typeof args.id === "string" ? args.id : /事项 ([A-Za-z0-9_-]+)：/.exec(text)?.[1]].filter((x): x is string => !!x);
  if (name === "settle_items") return ((args.verdicts as { item_id?: string }[] | undefined) ?? []).map((v) => v.item_id).filter((x): x is string => typeof x === "string");
  if (name === "notify") return [args.entity_id].filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * After a tool call succeeded: an item it read or wrote joins the run's scope; an item it wrote is
 * linked to the run's places (items/places.ts). Returns a line for the tool's result, or "".
 */
export function afterToolCall(app: App, runId: string | null | undefined, userId: string | undefined, name: string, args: Record<string, unknown>, text: string): string {
  if (!runId) return "";
  try {
    const ids = itemsOfCall(name, args, text);
    if (!ids.length || !one(app.db, "select 1 from runs where id = ?", runId)) return "";
    for (const id of ids) addScope(app, runId, "item", id);
    if (name !== "upsert_item") return "";
    const linked = linkRunPlaces(app, runId, ids[0], userId ?? OWNER);
    const names = linked.flatMap((p) => placeView(app, p)?.title ?? []);
    return names.length ? `\n已把这件事关联到${names.map((n) => `「${truncate(n, 30)}」`).join("、")}：之后在这些地方工作的运行会看到它在别处的进展。不是同一件事就用 materials_remove 取消。` : "";
  } catch (e) {
    console.warn(`[omem] 记录工具 ${name} 碰过的事项失败：${(e as Error).message}`);
    return "";
  }
}

// ---- taking over ---------------------------------------------------------------------------------

/**
 * The owner asked about the same thing a background run is working on: stop that run and hand over
 * what it had — its latest text, the working files it wrote, the items it touched, what it posted.
 * Only the same person's background runs; coding and reviews are stopped with stop_code_run.
 */
export function takeOverRun(app: App, by: { runId: string | null; userId?: string }, id: string): string {
  const r = getRun(app, id);
  const userId = by.userId ?? OWNER;
  if ((one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", id)?.user_id ?? OWNER) !== userId) throw new HttpError(403, "只能接手自己的运行");
  if (id === by.runId) throw new HttpError(400, "不能接手自己这一轮");
  if (r.kind === "code" || r.kind === "review") throw new HttpError(400, "编码交办和评审用 stop_code_run 停下");
  if (!isBackground(app, r)) throw new HttpError(400, "这个运行在回答别人的消息，不是后台工作，不能接手");
  const wasRunning = r.status === "queued" || r.status === "running";
  if (wasRunning) {
    setRunOutput(app, id, { takenOverBy: by.runId ?? "owner" });
    addRunEvent(app, id, "status", { text: `本人${by.runId ? `在运行 ${by.runId} 里` : ""}接手了这件事，这一轮停下` });
    cancelRun(app, id);
  }
  const texts = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'text' order by seq desc limit 3", id).map((e) => String(json<{ text?: string }>(e.data, {}).text ?? "")).reverse().join("").trim();
  const writes = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'tool-write' order by seq", id).map((e) => json<{ name?: string; args?: Record<string, unknown>; result?: string }>(e.data, {}));
  const files = writes.filter((w) => w.name === "write_file").map((w) => `- ${String(w.args?.path ?? w.args?.title ?? "")}：${truncate(String(w.result ?? ""), 120)}`);
  const posted = writes.filter((w) => w.name && SENDS.has(w.name)).map((w) => `- ${w.name}：${truncate(String(w.args?.title ?? w.args?.text ?? w.args?.markdown ?? ""), 120)}`);
  const items = scopeOf(app, id).filter((k) => k.kind === "item").map((k) => {
    const it = one<{ title: string; status: string }>(app.db, "select title, status from items where id = ?", k.key);
    return it ? `- ${k.key}「${truncate(it.title, 60)}」[${it.status}]` : "";
  }).filter(Boolean);
  const done = conclusionOf(getRun(app, id).output, r.status === "failed" ? r.error : null);
  return [
    `${wasRunning ? "已停下" : "这个运行已经结束了："}${id}「${r.title}」。它已经做到的：`,
    ...(texts ? ["", "最后写的文字：", truncate(texts, 3000)] : done ? ["", `结论：${done}`] : ["", "（还没有写出文字）"]),
    ...(files.length ? ["", "写过的工作文件（read_source 读全文）：", ...files] : []),
    ...(items.length ? ["", "碰过的事项：", ...items] : []),
    ...(posted.length ? ["", "已经发出的：", ...posted] : []),
    "",
    "接着它做，不用从头查；它的完整过程用 read_run 看。",
  ].join("\n");
}
