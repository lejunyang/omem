import type { App } from "../core/app.ts";
import { readLarkSecrets } from "../channels/lark-setup.ts";
import { larkActor, larkCli, setLarkCredentials } from "../channels/lark-cli.ts";
import { HttpError } from "../core/util.ts";
import { OWNER, userName } from "../core/users.ts";
import { consented } from "../rules/run-as.ts";
import { accessToken, featuresOff, staleToken } from "./connections.ts";
import { findConnection } from "./vault.ts";
import { larkCommandFeatures } from "./features.ts";
import { requirePerm } from "./permissions.ts";
import { needConnection } from "./connect-wait.ts";

/**
 * Feishu as a person (docs/v2/multi-user.md, “继续用 lark-cli”): whatever runs inside `asLarkUser`
 * calls lark-cli with that person's own token from their connection (src/auth/connections.ts). Every
 * tool call runs inside it (agents/tools.ts), so a member's run reads and writes Feishu as the member,
 * and someone who has not connected Feishu gets a clear refusal — never the owner's login in their
 * place. The owner keeps lark-cli's own login, as before.
 */
setLarkCredentials(async ({ app, userId, runId, ruleId }, args) => {
  const a = app as App;
  const authorization = () => new HttpError(403, needConnection(a, userId, ruleId ? null : runId, {
    features: larkCommandFeatures(args),
    reason: ruleId ? "没有可用的飞书个人登录（尚未连接或需要重新授权）" : "还没有连接飞书",
  }) + (ruleId ? " 本次先跳过这位成员。" : ""));
  if (ruleId && !canActOnLark(a, userId)) throw authorization();
  const token = await accessToken(a, userId, "lark").catch((error) => {
    if (ruleId && !canActOnLark(a, userId)) throw authorization();
    throw error;
  });
  if (!token) throw authorization();
  const appId = a.config.lark.appId;
  if (!appId) throw new HttpError(400, "还没有飞书机器人应用");
  return { appId, token, brand: readLarkSecrets(a.home)[appId]?.brand === "lark" ? "lark" : "feishu", rejected: () => staleToken(a, userId, "lark") };
});

/** Run `fn` as this person on Feishu. */
export const asLarkUser = <T>(app: App, userId: string, fn: () => T, runId?: string | null): T => larkActor.run({ app, userId, runId }, fn);

export type RuleLarkUser = { userId: string; ruleId: string; runId: string };

/** Also used by a saved crawl, so it can never resume under the owner's credentials. */
export function asRuleLarkUser<T>(app: App, actor: RuleLarkUser, fn: () => T, options: {
  citationPositionsOnly?: boolean;
  feature?: "docs";
  afterWrite?: (args: string[]) => void;
} = {}): T {
  const feature = options.citationPositionsOnly ? "messages" : options.feature;
  const check = () => {
    if (!consented(app, actor.ruleId, actor.userId)) throw new HttpError(403, `${userName(app, actor.userId)}已撤回同意或账号不可用：跳过这位成员`);
    requirePerm(app, actor.userId, "connector.use");
    if (feature && featuresOff(app, actor.userId, "lark").includes(feature))
      throw new HttpError(403, `当前成员在账号页关掉了「${feature === "messages" ? "群聊消息" : "文档与知识库"}」`);
  };
  const beforeCall = (args: string[]) => {
    check();
    if (!options.citationPositionsOnly) return;
    if (!(args[0] === "im" && args[1] === "+messages-mget"))
      throw new HttpError(403, "机器人发送只允许用个人登录补读引用的消息位置");
  };
  if (!options.citationPositionsOnly) check();
  return larkActor.run({ app, ...actor, beforeCall, afterWrite: options.afterWrite }, fn);
}

/** One lark-cli call as this person. */
export const larkCliAs = (app: App, userId: string, args: string[], timeoutMs?: number, cwd?: string): Promise<any> => asLarkUser(app, userId, () => larkCli(args, timeoutMs, cwd));

/** Whether this person may use Feishu as themselves now: the owner always (lark-cli's login), others with a working connection. */
export function canActOnLark(app: App, userId: string) {
  if (userId === OWNER) return true;
  const c = findConnection(app, userId, "lark");
  return !!c && c.status === "active";
}
