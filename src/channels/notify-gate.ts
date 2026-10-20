import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { readMessageIds } from "./lark-read.ts";
import { larkCli } from "./lark-cli.ts";

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
  // Reactions are read with lark-cli, whose ids belong to its own app: compare with the owner as it sees them.
  if (!cliOwner || Date.now() - cliOwner.at > 3600_000) cliOwner = { at: Date.now(), id: await (await import("./lark-personal.ts")).ownerOpenId() };
  const owner = cliOwner.id;
  if (!owner) return false;
  try {
    const v = await larkCli(["im", "+messages-mget", "--message-ids", messageId, "--as", "user", "--format", "json"], 30_000);
    const items: any[] = v?.data?.items ?? v?.items ?? [];
    const reactions: any[] = items[0]?.reactions ?? items[0]?.body?.reactions ?? [];
    return reactions.some((r) => {
      const operators: any[] = r.operators ?? r.users ?? r.operator_ids ?? [];
      return operators.some((o) => o.open_id === owner || o.user_id === owner);
    });
  } catch {
    return false;
  }
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
