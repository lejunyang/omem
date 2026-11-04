import type { App } from "../core/app.ts";
import { readLarkSecrets } from "../channels/lark-setup.ts";
import { larkActor, larkCli, setLarkCredentials } from "../channels/lark-cli.ts";
import { HttpError } from "../core/util.ts";
import { OWNER, userName } from "../core/users.ts";
import { accessToken, staleToken } from "./connections.ts";
import { findConnection } from "./vault.ts";

/**
 * Feishu as a person (docs/v2/multi-user.md, “继续用 lark-cli”): whatever runs inside `asLarkUser`
 * calls lark-cli with that person's own token from their connection (src/auth/connections.ts). Every
 * tool call runs inside it (agents/tools.ts), so a member's run reads and writes Feishu as the member,
 * and someone who has not connected Feishu gets a clear refusal — never the owner's login in their
 * place. The owner keeps lark-cli's own login, as before.
 */
setLarkCredentials(async ({ app, userId }) => {
  const a = app as App;
  const token = await accessToken(a, userId, "lark");
  if (!token) throw new HttpError(403, `${userName(a, userId)}还没有连接飞书：在 omem 的账号页连接飞书后再试`);
  const appId = a.config.lark.appId;
  if (!appId) throw new HttpError(400, "还没有飞书机器人应用");
  return { appId, token, brand: readLarkSecrets(a.home)[appId]?.brand === "lark" ? "lark" : "feishu", rejected: () => staleToken(a, userId, "lark") };
});

/** Run `fn` as this person on Feishu. */
export const asLarkUser = <T>(app: App, userId: string, fn: () => T): T => larkActor.run({ app, userId }, fn);

/** One lark-cli call as this person. */
export const larkCliAs = (app: App, userId: string, args: string[], timeoutMs?: number, cwd?: string): Promise<any> => asLarkUser(app, userId, () => larkCli(args, timeoutMs, cwd));

/** Whether this person may use Feishu as themselves now: the owner always (lark-cli's login), others with a working connection. */
export function canActOnLark(app: App, userId: string) {
  if (userId === OWNER) return true;
  const c = findConnection(app, userId, "lark");
  return !!c && c.status === "active";
}
