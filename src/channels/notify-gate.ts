import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { readMessageIds } from "./lark-read.ts";
import { larkCli } from "./lark-cli.ts";
import { ownerReactionsSeen } from "./lark-feedback.ts";

/**
 * Decide whether a notification should actually ping the owner.
 *
 * The agent writes notifications from chat *sources* (`src:<id>#L2-L4`), not
 * from message ids, so earlier logic that only matched `msg:<id>` almost never
 * suppressed anything. This resolves the cited chat lines back to their Feishu
 * message ids and treats the owner as already on top of it when ANY of:
 *
 * 1. every triggering message is read;
 * 2. the owner reacted to one of them (OK/DONE/… — answers without typing);
 * 3. the owner replied in the same chat/topic after the triggering message.
 *
 * Unknown read state (deleted/uncaptured messages, lark-cli unavailable) does not suppress.
 */
export type NotificationLike = {
  sourceRefs?: string[];
  urgency?: string;
  scheduled?: boolean;
};

type ChatLine = { sourceId: string; chatId: string; topicId: string | null; messageId: string | null; atMs: number; self: boolean };

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:[^\]]*?话题 (omt_[\w-]+))?\]\s*(.*?):\s*[\s\S]*?\(om_([\w-]+)\)\s*$/;

function parseChatLine(sourceId: string, chatId: string, line: string): ChatLine | null {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  const [, ymdhm, topic, sender, mid] = m;
  // Chat lines are written in UTC (lark-messages fmtTime).
  const atMs = Date.parse(ymdhm.replace(" ", "T") + ":00Z");
  if (Number.isNaN(atMs)) return null;
  return { sourceId, chatId, topicId: topic ?? null, self: /（本人）/.test(sender), messageId: mid ? `om_${mid}` : null, atMs };
}

/** Resolve one `src:<id>#La-Lb` chat reference into its parsed lines. */
function refChatLines(app: App, ref: string): ChatLine[] {
  const m = /^src:([A-Za-z0-9_-]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref);
  if (!m) return [];
  const row = one<{ kind: string; uri: string; text: string }>(app.db, "select kind, uri, text from sources where id=? and deleted_at is null", m[1]);
  if (!row || row.kind !== "chat" || !row.uri.startsWith("lark:oc_")) return [];
  const chatId = row.uri.slice("lark:".length);
  const lines = row.text.split("\n");
  const from = m[2] ? Math.max(1, Number(m[2])) : 1;
  const to = m[3] ? Number(m[3]) : Math.min(lines.length, from + 2);
  return lines.slice(from - 1, to).map((l) => parseChatLine(m[1], chatId, l)).filter((x): x is ChatLine => !!x);
}

export async function ownerAlreadyHandled(app: App, n: NotificationLike): Promise<boolean> {
  const refs = n.sourceRefs ?? [];
  const triggers = refs.length ? refs.flatMap((r) => refChatLines(app, r)) : [];

  // The strongest, timing-independent signal: the owner sent a message in the
  // same chat/topic after the trigger. Works even when the trigger message is
  // not resolvable (so fall back to "this chat, recent" when refs resolve to none).
  if (triggers.length) {
    for (const h of triggers) {
      if (ownerRepliedAfter(app, h.chatId, h.topicId, h.atMs)) return true;
    }
  } else if (refs.length) {
    for (const ref of refs) {
      const chat = chatOfRef(app, ref);
      if (chat && ownerRepliedRecently(app, chat, 30 * 60_000)) return true;
    }
  }

  // Read status + reactions require concrete trigger message ids.
  if (!triggers.length) return false;
  const ids = triggers.map((h) => h.messageId).filter((x): x is string => !!x);
  const read = ids.length ? await readMessageIds(app, ids) : new Set<string>();
  if (ids.length && triggers.every((h) => h.messageId && read.has(h.messageId))) return true;
  for (const h of triggers) {
    if (h.messageId && (await ownerReacted(app, h.messageId))) return true;
  }
  return false;
}

/** The chat id behind a src: chat reference, when it resolves. */
function chatOfRef(app: App, ref: string): string | null {
  const m = /^src:([A-Za-z0-9_-]+)/.exec(ref);
  if (!m) return null;
  const row = one<{ kind: string; uri: string }>(app.db, "select kind, uri from sources where id=? and deleted_at is null", m[1]);
  return row && row.kind === "chat" && row.uri.startsWith("lark:oc_") ? row.uri.slice("lark:".length) : null;
}

let cliOwner: { at: number; id: string | undefined } | null = null;
async function ownerReacted(app: App, messageId: string): Promise<boolean> {
  return ((await ownerReactions(app, messageId)) ?? []).length > 0;
}

/**
 * The emoji types the owner put on a message (e.g. DONE, OK); null when it cannot be read.
 * Reactions the bots' events already delivered (lark-feedback.ts) come first; lark-cli is asked only
 * when they have none for this message (the bot is not in that chat, or the events are off).
 */
export async function ownerReactions(app: App, messageId: string): Promise<string[] | null> {
  const seen = ownerReactionsSeen(app, messageId);
  if (seen) return seen;
  // Reactions are read with lark-cli, whose ids belong to its own app: compare with the owner as it sees them.
  if (!cliOwner || Date.now() - cliOwner.at > 3600_000) cliOwner = { at: Date.now(), id: await (await import("./lark-personal.ts")).ownerOpenId() };
  const owner = cliOwner.id;
  if (!owner) return null;
  try {
    const v = await larkCli(["im", "+messages-mget", "--message-ids", messageId, "--as", "user", "--format", "json"], 30_000);
    return reactionsBy(v, messageId, owner);
  } catch {
    return null;
  }
}

/**
 * The emoji types `person` put on a message, from lark-cli's `+messages-mget` output:
 * `data.messages[].reactions = { counts: [{ reaction_type, count }], details: [{ emoji_type, operator: { operator_id, operator_type } }] }`
 * (checked against the real CLI; a message without reactions has no `reactions`). The older
 * array form with `operators` is still read.
 */
export function reactionsBy(v: any, messageId: string, person: string): string[] {
  const list: any[] = v?.data?.messages ?? v?.data?.items ?? v?.messages ?? v?.items ?? [];
  const msg = list.find((m) => m?.message_id === messageId) ?? (list.length === 1 ? list[0] : undefined);
  const r = msg?.reactions ?? msg?.body?.reactions;
  if (!r) return [];
  if (Array.isArray(r?.details)) {
    return r.details
      .filter((d: any) => (d.operator?.operator_id ?? d.operator_id) === person)
      .map((d: any) => String(d.emoji_type ?? d.reaction_type?.emoji_type ?? "?"));
  }
  const arr: any[] = Array.isArray(r) ? r : [];
  return arr
    .filter((x) => {
      const operators: any[] = x.operators ?? x.users ?? x.operator_ids ?? [];
      return operators.some((o) => o.open_id === person || o.user_id === person || o.operator_id === person);
    })
    .map((x) => String(x.reaction_type?.emoji_type ?? x.emoji_type ?? x.type ?? "?"));
}

export type OwnerFollowUp = {
  /** The cited chat messages that started the item. */
  triggers: { messageId: string | null; atMs: number; sourceId: string }[];
  /** What the owner said afterwards in the same chat (and topic), oldest first, with a citation. */
  lines: { atMs: number; text: string; ref: string }[];
  /** The newest owner line, including any cut off by the limit. */
  latestMs: number;
};

/**
 * What the owner did after the chat messages an item cites: their later lines in the same
 * chat/topic. Used to tell whether an item has been dealt with (src/items/expiry.ts).
 */
export function ownerFollowUp(app: App, refs: string[], limit = 6): OwnerFollowUp {
  // A cited range can include the owner's own reply; that is the follow-up, not the trigger.
  const cited = refs.flatMap((r) => refChatLines(app, r));
  const triggers = cited.some((t) => !t.self) ? cited.filter((t) => !t.self) : cited;
  const out: OwnerFollowUp = { triggers: triggers.map((t) => ({ messageId: t.messageId, atMs: t.atMs, sourceId: t.sourceId })), lines: [], latestMs: 0 };
  const seen = new Set<string>();
  for (const t of triggers) {
    if (seen.has(`${t.chatId}#${t.topicId ?? ""}`)) continue;
    seen.add(`${t.chatId}#${t.topicId ?? ""}`);
    const after = Math.max(...triggers.filter((x) => x.chatId === t.chatId).map((x) => x.atMs));
    const row = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ? and deleted_at is null", `lark:${t.chatId}`);
    if (!row) continue;
    row.text.split("\n").forEach((line, i) => {
      const p = parseChatLine(row.id, t.chatId, line);
      if (!p || !p.self || p.atMs <= after) return;
      if (t.topicId && p.topicId && p.topicId !== t.topicId) return;
      out.lines.push({ atMs: p.atMs, text: line.trim().slice(0, 300), ref: `src:${row.id}#L${i + 1}` });
    });
  }
  out.lines.sort((a, b) => a.atMs - b.atMs);
  out.latestMs = out.lines.at(-1)?.atMs ?? 0;
  out.lines = out.lines.slice(0, limit);
  return out;
}

/**
 * A later owner line in the same chat — and same topic when the trigger is in
 * one — means the owner is actively handling it. Uses already-captured lines.
 */
function ownerRepliedAfter(app: App, chatId: string, topicId: string | null, afterMs: number): boolean {
  const row = one<{ text: string }>(app.db, "select text from sources where uri = ? and deleted_at is null", `lark:${chatId}`);
  if (!row) return false;
  for (const line of row.text.split("\n")) {
    const p = parseChatLine("", chatId, line);
    if (!p || p.atMs <= afterMs || !p.self) continue;
    // Only require topic equality when BOTH sides carry one; many captured group
    // replies omit the topic tag and would otherwise look like different threads.
    if (topicId && p.topicId && p.topicId !== topicId) continue;
    return true;
  }
  return false;
}

/** Owner spoke in the chat within `windowMs` before now (fallback when no trigger time). */
function ownerRepliedRecently(app: App, chatId: string, windowMs: number): boolean {
  const row = one<{ text: string }>(app.db, "select text from sources where uri = ? and deleted_at is null", `lark:${chatId}`);
  if (!row) return false;
  const cutoff = Date.now() - windowMs;
  for (const line of row.text.split("\n")) {
    const p = parseChatLine("", chatId, line);
    if (p && p.self && p.atMs >= cutoff) return true;
  }
  return false;
}
