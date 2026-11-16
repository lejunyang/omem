import type { App } from "../core/app.ts";
import { inQuietHours, notify } from "../core/notify.ts";
import { HttpError } from "../core/util.ts";
import { larkActing, larkCli, LarkScopeError, onOwnerLoginMissing, OWNER_LOGIN_DOMAINS } from "./lark-cli.ts";
import { one, run } from "../core/db.ts";

/**
 * The owner's lark-cli login (user identity) and what it may do. lark-cli has its own app and
 * the owner grants it scopes with a device-flow login. When a call fails for a missing scope,
 * omem starts a login for just that scope (`auth login --scope … --no-wait`), sends the owner
 * the link, and finishes the login in the background once the owner has confirmed it.
 */

/** What omem's features need from the owner's login; each entry is satisfied by any one of its scopes. */
export const USER_FEATURES: Record<string, { label: string; anyOf: string[] }[]> = {
  "wiki-read": [
    { label: "读知识库节点和子节点", anyOf: ["wiki:node:retrieve", "wiki:wiki:readonly", "wiki:wiki"] },
    { label: "读知识库信息", anyOf: ["wiki:space:read", "wiki:wiki:readonly", "wiki:wiki"] },
    { label: "列出能看到的知识库", anyOf: ["wiki:space:retrieve", "wiki:wiki:readonly", "wiki:wiki"] },
  ],
  "doc-write": [
    { label: "新建文档", anyOf: ["docx:document:create", "docx:document"] },
    { label: "编辑文档", anyOf: ["docx:document", "docx:document:write_only"] },
    { label: "在知识库新建节点", anyOf: ["wiki:node:create", "wiki:wiki"] },
    { label: "移动知识库节点", anyOf: ["wiki:node:move", "wiki:wiki"] },
  ],
};

type Status = { scopes: Set<string> | null; openId: string | null; name: string | null };
let cached: { at: number; status: Status } | null = null;

/** The owner's lark-cli login: who it is and its scopes (null when they cannot be read). Cached a few minutes. */
async function status(fresh = false): Promise<Status> {
  if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.status;
  let st: Status = { scopes: null, openId: null, name: null };
  try {
    const v = await larkCli(["auth", "status", "--json"], 30_000);
    const user = v?.identities?.user ?? v?.data?.identities?.user ?? v?.user;
    const raw = user?.scope ?? user?.scopes;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : null;
    st = { scopes: list ? new Set(list.filter(Boolean)) : null, openId: user?.openId ?? user?.open_id ?? null, name: user?.userName ?? user?.name ?? null };
  } catch {}
  cached = { at: Date.now(), status: st };
  return st;
}

/** Scopes the owner's lark-cli login has; null when it cannot be read (not logged in, old lark-cli). */
export async function userScopes(fresh = false) {
  return (await status(fresh)).scopes;
}

/** The owner as lark-cli's app knows them (open_id in that app). */
export async function cliUser() {
  const s = await status();
  return s.openId ? { openId: s.openId, name: s.name } : null;
}

/** Which needs of these features the login lacks (empty when all are there, or when scopes cannot be read: `unknown`). */
export async function missingUserScopes(features: string[]) {
  const have = await userScopes(true);
  const needs = features.flatMap((f) => USER_FEATURES[f] ?? []);
  if (!have) return { unknown: true, missing: [] as typeof needs };
  return { unknown: false, missing: needs.filter((n) => !n.anyOf.some((s) => have.has(s))) };
}

type Pending = { url: string; until: number };
const pending = new Map<string, Pending>();

/**
 * Start a login for these scopes and tell the owner where to confirm it. A login already waiting for
 * the same scopes is reused while it is valid, so a run that hits the gap twice sends one link.
 */
export async function requestUserScopes(app: App, scopes: string[], reason: string): Promise<{ url: string; reused: boolean }> {
  const key = [...new Set(scopes)].sort().join(" ");
  const open = pending.get(key);
  if (open && open.until > Date.now()) return { url: open.url, reused: true };
  const v = await larkCli(["auth", "login", "--scope", key, "--no-wait", "--json"], 60_000);
  const d = v?.data ?? v;
  const url = String(d?.verification_url ?? d?.verification_uri_complete ?? d?.verification_uri ?? "");
  const code = String(d?.device_code ?? "");
  if (!url || !code) throw new Error("lark-cli 没有返回授权链接");
  const seconds = Number(d?.expires_in) || 600;
  pending.set(key, { url, until: Date.now() + seconds * 1000 });
  const asked = notify(app, {
    tone: "warning",
    title: "飞书授权：需要补一项权限",
    body: `${reason}需要你在 lark-cli 的登录里授权：${key}\n\n在飞书里打开链接确认（${Math.round(seconds / 60)} 分钟内有效）：${url}\n\n确认后 omem 会自动完成登录，之后重试即可。`,
    urgency: "normal",
  });
  // Polls until the owner confirms (or the code expires); then the new scopes are in the login.
  void larkCli(["auth", "login", "--device-code", code, "--json"], seconds * 1000 + 30_000)
    .then(() => {
      cached = null;
      notify(app, { title: "飞书授权已完成", body: `lark-cli 已获得：${key}`, tone: "done", replaces: asked.id });
    })
    .catch((e) => console.warn(`[omem] 飞书授权没有完成（${key}）：${(e as Error).message}`))
    .finally(() => pending.delete(key));
  return { url, reused: false };
}

/**
 * Run a lark-cli call as the owner; a missing scope becomes a login link for the owner and an error
 * the agent can act on (wait, tell the owner) instead of an opaque failure.
 */
export async function asOwner<T>(app: App, reason: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof LarkScopeError)) throw e;
    // Any one of the listed scopes is enough: ask for the first (the narrowest lark-cli names).
    const scope = e.scopes[0];
    // Someone else's connection (src/auth/lark-user.ts): they authorize the scope on their own connection, from the account page.
    const actor = larkActing();
    if (actor) {
      const { userName } = await import("../core/users.ts");
      notify(app, { userId: actor.userId, tone: "warning", title: "飞书授权：需要补一项权限", body: `${reason}需要你给 omem 授权：${scope}。在账号页点“授权”，在飞书里确认后再试。`, link: `#/account?connect=lark&scopes=${encodeURIComponent(scope)}`, urgency: "normal" });
      throw new HttpError(403, `缺少飞书权限 ${e.scopes.join(" 或 ")}。已把授权链接发给 ${userName(app, actor.userId)}；对方授权后再试，不要换别的方式绕过。`);
    }
    let link = "";
    try {
      link = (await requestUserScopes(app, [scope], reason)).url;
    } catch (x) {
      throw new HttpError(403, `缺少飞书权限 ${e.scopes.join(" 或 ")}，发起授权也失败了：${(x as Error).message}。请在运行 omem 的电脑上执行 lark-cli auth login --scope "${scope}"`);
    }
    throw new HttpError(403, `缺少飞书权限 ${e.scopes.join(" 或 ")}。已把授权链接发给本人（${link}）；本人确认后再试，不要换别的方式绕过。`);
  }
}

/** How long after a login link before another one when the owner has not confirmed it. */
const RELOGIN_EVERY_MS = 6 * 3600_000;
let relogin: Promise<void> | null = null;

/**
 * The owner's login gone altogether (lark-cli reports token_missing: expired and not refreshed, or
 * removed). Capture, `/ai` in private chats and the rules' quick checks failed every minute with only
 * a line in the log. Now the owner gets one link for a full login (the same domains as setup), omem
 * finishes it in the background once confirmed (`--device-code`, which an agent's own login in its
 * shell had left out), and asks again only after RELOGIN_EVERY_MS.
 */
export function watchOwnerLogin(app: App) {
  onOwnerLoginMissing(() => {
    // A link lasts ten minutes and a notification waits out the quiet hours: ask once they are over
    // (the failures keep coming every minute), not with a link that has expired by morning.
    if (relogin || inQuietHours(app)) return;
    const last = Number(one<{ value: string }>(app.db, "select value from kv where key = 'lark_relogin_asked_at'")?.value ?? 0);
    if (Date.now() - last < RELOGIN_EVERY_MS) return;
    run(app.db, "insert into kv(key,value) values('lark_relogin_asked_at', ?) on conflict(key) do update set value = excluded.value", String(Date.now()));
    relogin = askOwnerLogin(app)
      .catch((e) => console.warn(`[omem] 发起 lark-cli 重新登录失败：${(e as Error).message}`))
      .finally(() => { relogin = null; });
  });
}

async function askOwnerLogin(app: App) {
  const v = await larkCli(["auth", "login", "--domain", OWNER_LOGIN_DOMAINS, "--no-wait", "--json"], 60_000);
  const d = v?.data ?? v;
  const url = String(d?.verification_url ?? d?.verification_uri_complete ?? d?.verification_uri ?? "");
  const code = String(d?.device_code ?? "");
  if (!url || !code) throw new Error("lark-cli 没有返回授权链接");
  const seconds = Number(d?.expires_in) || 600;
  const asked = notify(app, {
    tone: "warning",
    title: "飞书授权：lark-cli 的登录失效了",
    body: `omem 以你的身份读飞书（消息采集、私聊里的指令、规则的快速检查、读文档）要用 lark-cli 的登录，现在它没有可用的登录。\n\n在飞书里打开链接确认（${Math.round(seconds / 60)} 分钟内有效）：${url}\n\n确认后 omem 自己保存登录，不用再做别的。没来得及确认的话 ${RELOGIN_EVERY_MS / 3600_000} 小时后会再发一次；也可以在运行 omem 的电脑上执行 omem setup。`,
    urgency: "normal",
  });
  await larkCli(["auth", "login", "--device-code", code, "--json"], seconds * 1000 + 30_000);
  cached = null;
  run(app.db, "delete from kv where key = 'lark_relogin_asked_at'");
  notify(app, { title: "飞书授权已完成", body: "lark-cli 已重新登录，采集和指令会照常进行。", tone: "done", replaces: asked.id });
}

/** Tests: forget the cached scopes and waiting logins. */
export function resetLarkAuthForTests() {
  cached = null;
  pending.clear();
  relogin = null;
}
