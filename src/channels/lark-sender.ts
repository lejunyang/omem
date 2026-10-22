import type * as lark from "@larksuiteoapi/node-sdk";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { resolveIdentity, userName } from "../core/users.ts";
import { larkCli } from "./lark-cli.ts";
import { isApp, type LarkMessage } from "./lark-messages.ts";
import { rememberPerson } from "./lark-people.ts";

/** Event open_ids belong to the bot. A read-only CLI lookup supplies a name, never an open_id. */
export function larkSenderNames(app: App, client: lark.Client) {
  const names = new Map<string, { name: string; until: number }>();
  return async (openId: string, message?: { id: string; chatId: string; fromApp: boolean }) => {
    if (!openId) return "?";
    const known = resolveIdentity(app, "lark", openId);
    if (known) return userName(app, known);
    const cached = names.get(openId);
    if (cached && cached.until > Date.now()) return cached.name;
    let name: string | undefined;
    try {
      if (message?.fromApp) {
        // Contact APIs cannot resolve bots. Match the exact message and chat before learning its name.
        const v = await larkCli(["im", "+messages-mget", "--message-ids", message.id, "--no-reactions", "--as", "user", "--format", "json"], 20_000);
        const messages = (v.data?.messages ?? []) as LarkMessage[];
        name = messages.find(m => m.message_id === message.id && m.chat_id === message.chatId && isApp(m))?.sender?.name;
      } else {
        const r = await client.contact.user.get({ path: { user_id: openId }, params: { user_id_type: "open_id" } });
        if (!r.code) name = r.data?.user?.name;
      }
    } catch { /* Missing names remain retryable on the next message. */ }
    if (name?.trim()) {
      names.set(openId, { name, until: Date.now() + 10 * 60_000 });
      if (message?.fromApp && openId.startsWith("ou_")) rememberPerson(app, { botOpenId: openId, name });
      return name;
    }
    const saved = one<{ name: string }>(app.db, "select name from lark_people where bot_open_id = ? and name != ''", openId)?.name;
    return saved || openId;
  };
}
