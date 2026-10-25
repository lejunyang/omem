import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which Feishu bot the current work speaks as: "main" (lark.appId) or the id of one of lark.bots.
 * A bot's event handling runs inside it, so replies, cards, reactions and lookups go out through
 * that bot without passing it everywhere. Work not started by a message (runs, notifications,
 * listeners) sets it from what it belongs to (a conversation's channel, a card's sender).
 */
export const botContext = new AsyncLocalStorage<string>();

export function withBot<T>(bot: string | null | undefined, fn: () => T): T {
  return botContext.run(bot || "main", fn);
}
export function currentBot(): string {
  return botContext.getStore() ?? "main";
}
/** The bot a conversation belongs to, from its channel (`lark` → main, `lark:<id>` → that bot). */
export function botOfChannel(channel: string | null | undefined): string {
  return channel?.startsWith("lark:") ? channel.slice(5) : "main";
}
