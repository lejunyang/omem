import type { App } from "../core/app.ts";
import { inQuietHours, notify } from "../core/notify.ts";
import { HttpError, zonedParts } from "../core/util.ts";
import { larkActing, larkActor, larkCli, LarkScopeError, onOwnerLoginMissing, OWNER_LOGIN_DOMAINS } from "./lark-cli.ts";
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
    // A colleague's grant (auth/grants.ts) lacks it: dropped, so the next try gives them a fresh link with what is needed.
    if (actor?.userId.startsWith("lark:")) {
      (await import("../auth/connections.ts")).disconnect(app, actor.userId, "lark");
      throw new HttpError(403, `对方的飞书授权少了 ${scope}：再用 identity=bot 试一次会拿到新的授权链接，发给他重新同意。`);
    }
    if (actor) {
      const { needConnection } = await import("../auth/connect-wait.ts");
      throw new HttpError(403, needConnection(app, actor.userId, actor.runId, { scopes: [scope], reason: `${reason}缺少飞书权限 ${scope}` }));
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

/** How long after a login link before another one when nothing but background capture needs the login. */
const RELOGIN_EVERY_MS = 6 * 3600_000;
/** ... and when a run is waiting on it (a rule handling an alarm, the assistant): the last link has long expired. */
const RELOGIN_WAITING_MS = 30 * 60_000;
let relogin: { done: Promise<void>; until: number } | null = null;


/**
 * The owner's login gone altogether (lark-cli reports token_missing: expired and not refreshed, or
 * removed). Capture, `/ai` in private chats and the rules' quick checks failed every minute with only
 * a line in the log. Now the owner gets one link for a full login (the same domains as setup), omem
 * finishes it in the background once confirmed (`--device-code`, which an agent's own login in its
 * shell had left out). A link lasts ten minutes: background capture asks again only after
 * RELOGIN_EVERY_MS, but a run that needs the login (a tool call: a rule handling an alarm, the
 * assistant) gets a new link once the last one is RELOGIN_WAITING_MS old — a link sent while the
 * owner was away must not leave the alarms failing for six hours. Returns what was done, for the
 * error the caller (and the agent) sees.
 */
export function watchOwnerLogin(app: App) {
  const hhmm = (ms: number) => { const p = zonedParts(ms, app.config.timezone); return `${p.hour}:${String(p.minute).padStart(2, "0")}`; };
  onOwnerLoginMissing(() => {
    if (relogin) return `已把授权链接发给本人（${hhmm(relogin.until)} 前有效），等本人确认；不要自己跑 lark-cli auth login`;
    // A link lasts ten minutes and a notification waits out the quiet hours: ask once they are over
    // (the failures keep coming every minute), not with a link that has expired by morning.
    if (inQuietHours(app)) return `现在是免打扰时段，免打扰结束（${app.config.notify.quietEnd} 点）后有运行再用到时会发授权链接`;
    // Every tool call runs as someone (auth/lark-user.ts asLarkUser); capture and polling do not.
    const waiting = !!larkActor.getStore();
    const last = Number(one<{ value: string }>(app.db, "select value from kv where key = 'lark_relogin_asked_at'")?.value ?? 0);
    const gap = waiting ? RELOGIN_WAITING_MS : RELOGIN_EVERY_MS;
    if (Date.now() - last < gap) return `${hhmm(last)} 发过的授权链接没有确认（已过期），${hhmm(last + RELOGIN_WAITING_MS)} 后再有运行用到时会重发`;
    run(app.db, "insert into kv(key,value) values('lark_relogin_asked_at', ?) on conflict(key) do update set value = excluded.value", String(Date.now()));
    const current: { done: Promise<void>; until: number } = { done: Promise.resolve(), until: Date.now() + 10 * 60_000 };
    relogin = current;
    current.done = askOwnerLogin(app, (until) => { current.until = until; })
      .catch((e) => console.warn(`[omem] 发起 lark-cli 重新登录失败：${(e as Error).message}`))
      .finally(() => { if (relogin === current) relogin = null; });
    return "已把重新登录的授权链接发给本人（10 分钟内有效），本人确认后再试；不要自己跑 lark-cli auth login";
  });
}

async function askOwnerLogin(app: App, expires: (until: number) => void) {
  const v = await larkCli(["auth", "login", "--domain", OWNER_LOGIN_DOMAINS, "--no-wait", "--json"], 60_000);
  const d = v?.data ?? v;
  const url = String(d?.verification_url ?? d?.verification_uri_complete ?? d?.verification_uri ?? "");
  const code = String(d?.device_code ?? "");
  if (!url || !code) throw new Error("lark-cli 没有返回授权链接");
  const seconds = Number(d?.expires_in) || 600;
  expires(Date.now() + seconds * 1000);
  const asked = notify(app, {
    tone: "warning",
    title: "飞书授权：lark-cli 的登录失效了",
    body: `omem 以你的身份读飞书（消息采集、私聊里的指令、规则的快速检查、读文档）要用 lark-cli 的登录，现在它没有可用的登录。\n\n在飞书里打开链接确认（${Math.round(seconds / 60)} 分钟内有效）：${url}\n\n确认后 omem 自己保存登录，不用再做别的。没来得及确认的话，之后有规则或助手用到飞书时（最快半小时后）会再发一次；也可以在运行 omem 的电脑上执行 omem setup。`,
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
