import type { App } from "../core/app.ts";
import { notify } from "../core/notify.ts";
import { HttpError } from "../core/util.ts";
import { larkCli, LarkScopeError } from "./lark-cli.ts";

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
  notify(app, {
    title: "飞书授权：需要补一项权限",
    body: `${reason}需要你在 lark-cli 的登录里授权：${key}\n\n在飞书里打开链接确认（${Math.round(seconds / 60)} 分钟内有效）：${url}\n\n确认后 omem 会自动完成登录，之后重试即可。`,
    urgency: "normal",
  });
  // Polls until the owner confirms (or the code expires); then the new scopes are in the login.
  void larkCli(["auth", "login", "--device-code", code, "--json"], seconds * 1000 + 30_000)
    .then(() => {
      cached = null;
      notify(app, { title: "飞书授权已完成", body: `lark-cli 已获得：${key}`, urgency: "silent" });
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
    let link = "";
    try {
      link = (await requestUserScopes(app, [scope], reason)).url;
    } catch (x) {
      throw new HttpError(403, `缺少飞书权限 ${e.scopes.join(" 或 ")}，发起授权也失败了：${(x as Error).message}。请在运行 omem 的电脑上执行 lark-cli auth login --scope "${scope}"`);
    }
    throw new HttpError(403, `缺少飞书权限 ${e.scopes.join(" 或 ")}。已把授权链接发给本人（${link}）；本人确认后再试，不要换别的方式绕过。`);
  }
}

/** Tests: forget the cached scopes and waiting logins. */
export function resetLarkAuthForTests() {
  cached = null;
  pending.clear();
}
