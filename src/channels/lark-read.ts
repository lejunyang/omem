import type { App } from "../core/app.ts";
import { larkCli } from "./lark-cli.ts";

/**
 * Whether the owner has read Feishu messages, via the personal (user) lark-cli
 * token and `im +messages-read-status`. Batched (up to 50 ids) and cached
 * briefly so a notification decision never waits on more than one call.
 *
 * Returns the ids KNOWN to be read (`is_read: true`). Unknown ids (deleted,
 * chats the token can no longer see, field missing, API unavailable) are not in
 * the set: a reminder is never suppressed on a guess.
 */
const cache = new Map<string, { at: number; read: boolean | null }>();
const TTL = 60_000;

export async function readMessageIds(app: App, ids: string[]): Promise<Set<string>> {
  const now = Date.now();
  const fresh = ids.filter((id) => {
    const c = cache.get(id);
    return !c || now - c.at > TTL;
  });
  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50);
    try {
      const v = await larkCli(["im", "+messages-read-status", "--message-ids", batch.join(","), "--as", "user", "--format", "json"], 30_000);
      // Shape: { data: { items?: { message_id, is_read }[] } } across CLI versions; tolerate either casing.
      const items: any[] = v?.data?.items ?? v?.data?.readable_items ?? v?.items ?? [];
      const state = new Map<string, boolean>();
      for (const it of items) {
        const flag = it.is_read ?? it.read;
        if (typeof flag === "boolean") state.set(String(it.message_id ?? it.messageId ?? ""), flag);
      }
      for (const id of batch) cache.set(id, { at: now, read: state.get(id) ?? null });
    } catch {
      // No permission / CLI logged out / network: unknown, retried soon.
      for (const id of batch) cache.set(id, { at: now - TTL + 5_000, read: null });
    }
  }
  return new Set(ids.filter((id) => cache.get(id)?.read === true));
}
