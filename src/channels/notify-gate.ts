import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { unreadMessageIds } from "./lark-read.ts";
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
 * Unknown (deleted/uncaptured) messages count as unread and do not suppress.
 */
export type NotificationLike = {
  sourceRefs?: string[];
  urgency?: string;
  scheduled?: boolean;
};

type ChatLine = { sourceId: string; chatId: string; topicId: string | null; messageId: string | null; atMs: number; self: boolean };

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:[^]]*?话题 (omt_[\w-]+))?\]\s*(.*?):\s*[\s\S]*?\((om|omt)_([\w-]+)\)\s*$/;

function parseChatLine(sourceId: string, chatId: string, line: string): ChatLine | null {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  const [, ymdhm, topic, sender, , , mid] = m;
  const atMs = Date.parse(ymdhm.replace(" ", "T") + "+08:00");
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
  const hits = (n.sourceRefs ?? []).flatMap((r) => refChatLines(app, r));
  if (!hits.length) return false;

  // 1) Read status (batch; cached in lark-read).
  const ids = hits.map((h) => h.messageId).filter((x): x is string => !!x);
  const unread = ids.length ? await unreadMessageIds(app, ids) : new Set<string>();
  if (ids.length && hits.every((h) => h.messageId && !unread.has(h.messageId))) return true;

  // 2) Owner reaction on one of the triggering messages (OK emoji counts as handled).
  for (const h of hits) {
    if (h.messageId && (await ownerReacted(app, h.messageId))) return true;
  }

  // 3) Owner replied later in the same chat (same topic when the trigger is in one).
  for (const h of hits) {
    if (ownerRepliedAfter(app, h.chatId, h.topicId, h.atMs)) return true;
  }
  return false;
}

async function ownerReacted(app: App, messageId: string): Promise<boolean> {
  const owner = (app.config.lark as { ownerOpenId?: string } | undefined)?.ownerOpenId;
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
    if (topicId && p.topicId !== topicId) continue;
    return true;
  }
  return false;
}
