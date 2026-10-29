import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { larkCli } from "./lark-cli.ts";

/**
 * Connecting the Feishu bot. The bot is a self-built app with bot capability,
 * events over the SDK long connection (WebSocket, no public callback URL) and
 * card callbacks. The official SDK's `registerApp` runs the device flow: the
 * owner scans a QR code (or opens the link), confirms the app and the listed
 * permissions in Feishu, and the SDK returns the App ID, the App Secret and the
 * scanner's open_id. That covers both creating a new app and updating an
 * existing one with what omem needs — nobody copies a secret by hand.
 *
 * The secret is stored in `<home>/secrets/lark.json` (owner-only); config.json
 * keeps only the App ID. The env var named by `lark.appSecretEnv` still wins.
 */

/** What the bot needs. Messaging, cards, documents, calendar, tasks and meetings; no chat administration or ACL changes. */
export const LARK_BOT_ADDONS = {
  preset: false,
  scopes: {
    tenant: [
      "im:message",
      "im:message:send_as_bot",
      "im:message:update",
      "im:message:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_msg",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message.pins:read",
      "im:message:recall",
      "im:message.urgent",
      "im:resource",
      "im:chat:read",
      "im:chat.members:read",
      "contact:user.base:readonly",
      "contact:contact.base:readonly",
      // To @ people seen in captured messages: user_id (tenant-wide, unlike open_id), email, and email → user_id.
      "contact:user.employee_id:readonly",
      "contact:user.email:readonly",
      "contact:user.id:readonly",
      "application:bot.basic_info:read",
      "cardkit:card:read",
      "cardkit:card:write",
      "docx:document:readonly",
      "docx:document:create",
      "docx:document:write_only",
      "docs:document.content:read",
      "docs:document.comment:read",
      "docs:document.comment:create",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "wiki:wiki:readonly",
      "wiki:node:read",
      "sheets:spreadsheet:read",
      "calendar:calendar:read",
      "calendar:calendar.event:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "task:task:read",
      "task:task:write",
      "task:tasklist:read",
      "vc:meeting.meetingevent:read",
      // Rules that bring the bot into the owner's meetings (lark-meetings.ts).
      "vc:meeting.bot.join:write",
      "vc:meeting.message:write",
    ],
    // User identity: what personal capture through lark-cli reads (only if lark-cli is pointed at this same app).
    user: [
      "offline_access",
      "im:chat:read",
      "im:message:readonly",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:resource",
      "search:message",
      "contact:user.base:readonly",
      "docx:document:readonly",
      "docs:document.content:read",
      "drive:file:download",
      "wiki:node:read",
      "calendar:calendar:read",
      "calendar:calendar.event:read",
      "minutes:minutes:readonly",
      "minutes:minutes.search:read",
      "minutes:minutes.artifacts:read",
      "vc:note:read",
      // Knowing when the owner joins a meeting, and reading what is said there (lark-meetings.ts).
      "vc:meeting.meetingevent:read",
    ],
  },
  events: {
    items: {
      tenant: [
        "im.message.receive_v1",
        "im.chat.member.bot.added_v1",
        "im.chat.member.bot.deleted_v1",
        "im.message.reaction.created_v1",
        "im.message.reaction.deleted_v1",
      ],
    },
  },
  callbacks: { items: ["card.action.trigger"] },
};

export type LarkAppCredentials = { appId: string; appSecret: string; ownerOpenId?: string; brand?: "feishu" | "lark"; name?: string };

// ---- secret file ------------------------------------------------------------

const secretFile = (home: string) => join(home, "secrets", "lark.json");

export function readLarkSecrets(home: string): Record<string, { appSecret: string; brand?: string; name?: string }> {
  try {
    return JSON.parse(readFileSync(secretFile(home), "utf8"));
  } catch {
    return {};
  }
}

export function saveLarkSecret(home: string, c: LarkAppCredentials) {
  const dir = join(home, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const all = readLarkSecrets(home);
  all[c.appId] = { appSecret: c.appSecret, brand: c.brand, name: c.name };
  writeFileSync(secretFile(home), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(secretFile(home), 0o600);
  } catch {}
}

/** App Secret for the configured bot: environment variable first, then the secret file. */
export function larkAppSecret(home: string, appId: string | undefined, env: string) {
  if (process.env[env]) return process.env[env];
  if (!appId) return undefined;
  return readLarkSecrets(home)[appId]?.appSecret;
}

// ---- what is already on this machine ----------------------------------------

export type LarkCliState = {
  installed: boolean;
  appId?: string;
  brand?: string;
  user?: { openId?: string; name?: string; ok: boolean; message?: string };
  bot?: { ok: boolean; message?: string };
  error?: string;
};

/** lark-cli's current app and login state (read-only; never prints the secret). */
export async function larkCliState(): Promise<LarkCliState> {
  try {
    const s = await larkCli(["auth", "status"], 30_000);
    const ids = s.identities ?? {};
    return {
      installed: true,
      appId: s.appId,
      brand: s.brand,
      user: ids.user ? { openId: ids.user.openId, name: ids.user.userName, ok: !!ids.user.available, message: ids.user.message } : undefined,
      bot: ids.bot ? { ok: !!ids.bot.available, message: ids.bot.message } : undefined,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/未安装 @larksuite\/cli/.test(msg)) return { installed: false, error: msg };
    // No app configured yet is a normal first-run state.
    return { installed: true, error: msg };
  }
}

export type KnownApp = { appId: string; name?: string; source: "omem" | "lark-cli"; hasSecret: boolean };

/** Apps omem could bind: the ones it already holds secrets for, and the apps lark-cli is configured with. */
export async function knownLarkApps(home: string, configuredAppId?: string): Promise<KnownApp[]> {
  const out = new Map<string, KnownApp>();
  for (const [appId, v] of Object.entries(readLarkSecrets(home))) out.set(appId, { appId, name: v.name, source: "omem", hasSecret: true });
  if (configuredAppId && !out.has(configuredAppId)) out.set(configuredAppId, { appId: configuredAppId, source: "omem", hasSecret: false });
  try {
    const profiles = (await larkCli(["profile", "list"], 20_000)) as unknown;
    for (const p of Array.isArray(profiles) ? (profiles as { appId?: string; name?: string }[]) : [])
      if (p.appId && !out.has(p.appId)) out.set(p.appId, { appId: p.appId, name: p.name !== p.appId ? p.name : undefined, source: "lark-cli", hasSecret: false });
  } catch {}
  return [...out.values()];
}

// ---- registration -------------------------------------------------------------

let registerOverride: typeof lark.registerApp | null = null;
/** Tests: replace the SDK's device-flow registration. */
export function setRegisterAppForTests(fn: typeof lark.registerApp | null) {
  registerOverride = fn;
}

/**
 * Create a new bot app (`appId` omitted) or update an existing one with omem's
 * permissions, events and callbacks. Resolves after the owner confirms in Feishu.
 */
export async function registerLarkBot(opts: {
  appId?: string;
  name?: string;
  onQr: (url: string, expiresInSeconds: number) => void;
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
}): Promise<LarkAppCredentials> {
  const register = registerOverride ?? lark.registerApp;
  const r = await register({
    source: "omem",
    createOnly: !opts.appId,
    appId: opts.appId,
    appPreset: opts.appId ? undefined : { name: opts.name ?? "omem 助理", desc: "个人记忆与助理：私聊指挥、群聊记录、通知与卡片。" },
    addons: LARK_BOT_ADDONS,
    signal: opts.signal,
    onQRCodeReady: ({ url, expireIn }) => opts.onQr(url, expireIn),
    onStatusChange: ({ status }) => opts.onStatus?.(status),
  });
  if (!/^cli_[A-Za-z0-9]+$/.test(r.client_id) || !r.client_secret) throw new Error("飞书没有返回有效的应用凭据");
  if (opts.appId && r.client_id !== opts.appId) throw new Error(`授权的是另一个应用（${r.client_id}），不是 ${opts.appId}`);
  return { appId: r.client_id, appSecret: r.client_secret, ownerOpenId: r.user_info?.open_id, brand: r.user_info?.tenant_brand };
}

// ---- verification --------------------------------------------------------------

/**
 * Events and callbacks omem's code handles (lark-bot.ts). `optional`: only some features need it
 * (meeting rules); the rest the bot needs for answering, cards and reaction feedback.
 */
export const LARK_BOT_EVENTS: { name: string; label: string; optional?: boolean }[] = [
  { name: "im.message.receive_v1", label: "收消息（私聊、群里 @ 和群消息）" },
  { name: "im.message.reaction.created_v1", label: "有人加表情（回答的反馈）" },
  { name: "im.message.reaction.deleted_v1", label: "有人取消表情" },
  { name: "vc.bot.meeting_invited_v1", label: "机器人被邀请入会（会议规则）", optional: true },
];
export const LARK_BOT_CALLBACKS = [{ name: "card.action.trigger", label: "卡片按钮和表单" }];

/**
 * `scopesUnknown`: the app's granted permissions could not be read, so `missingScopes` may be incomplete.
 * `events` / `callbacks`: what the application info says the app subscribes to (null: not readable);
 * `publishedEvents`: the events of the version online, when that version could be read.
 */
export type LarkCheck = {
  botName?: string;
  botOpenId?: string;
  missingScopes: string[];
  scopesUnknown?: boolean;
  error?: string;
  events?: string[] | null;
  publishedEvents?: string[] | null;
  eventMode?: string | null;
  callbacks?: string[] | null;
  callbackMode?: string | null;
};

type AppInfo = {
  code?: number;
  data?: {
    app?: {
      scopes?: { scope: string }[];
      online_version_id?: string;
      event?: { subscription_type?: string; subscribed_events?: string[] };
      callback?: { callback_type?: string; subscribed_callbacks?: string[] };
      callback_info?: { callback_type?: string; subscribed_callbacks?: string[] };
    };
  };
};

/** The developer console page that asks for these permissions on this app (the owner opens it and applies). */
export function larkScopeLink(appId: string, scopes: string[], brand?: string, tokenType: "tenant" | "user" = "tenant") {
  const host = brand === "lark" ? "open.larksuite.com" : "open.feishu.cn";
  // Scope names are [a-z:._] only; Feishu's own links write them as they are.
  return `https://${host}/app/${appId}/auth?q=${scopes.join(",")}&op_from=openapi&token_type=${tokenType}`;
}

/** The developer console page where an app subscribes to events. */
export function larkEventLink(appId: string, brand?: string) {
  return `https://${brand === "lark" ? "open.larksuite.com" : "open.feishu.cn"}/app/${appId}/event`;
}

/** The permissions granted to an app (tenant token → application info); null when they cannot be read. */
export async function larkAppScopes(appId: string, appSecret: string, request: typeof fetch = fetch): Promise<Set<string> | null> {
  const base = "https://open.feishu.cn/open-apis";
  try {
    const t = (await (
      await request(`${base}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(15_000) })
    ).json()) as { code?: number; tenant_access_token?: string };
    if (t.code !== 0 || !t.tenant_access_token) return null;
    const app = (await (await request(`${base}/application/v6/applications/${appId}?lang=zh_cn`, { headers: { authorization: `Bearer ${t.tenant_access_token}` }, signal: AbortSignal.timeout(15_000) })).json()) as { code?: number; data?: { app?: { scopes?: { scope: string }[] } } };
    const have = new Set((app.data?.app?.scopes ?? []).map((s) => s.scope));
    return app.code === 0 && have.size ? have : null;
  } catch {
    return null;
  }
}

/** Get a tenant token and read the bot's info and granted scopes. Does not send anything. */
export async function checkLarkApp(appId: string, appSecret: string, request: typeof fetch = fetch): Promise<LarkCheck> {
  const base = "https://open.feishu.cn/open-apis";
  try {
    const t = (await (
      await request(`${base}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(15_000) })
    ).json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (t.code !== 0 || !t.tenant_access_token) return { missingScopes: [], error: `App Secret 不对或应用不可用（${t.code}：${t.msg ?? ""}）` };
    const headers = { authorization: `Bearer ${t.tenant_access_token}` };
    const bot = (await (await request(`${base}/bot/v3/info`, { headers, signal: AbortSignal.timeout(15_000) })).json()) as { code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } };
    if (bot.code !== 0) return { missingScopes: [], error: `应用没有开启机器人能力（${bot.code}：${bot.msg ?? ""}）` };
    let missing: string[] = [];
    let unknown = true;
    const subs: Pick<LarkCheck, "events" | "publishedEvents" | "eventMode" | "callbacks" | "callbackMode"> = { events: null, publishedEvents: null, eventMode: null, callbacks: null, callbackMode: null };
    try {
      // Application info (application v6, the app reading itself): granted scopes, and the event and
      // callback subscriptions as the SDK's types describe them (app.event.subscribed_events, app.callback).
      const app = (await (await request(`${base}/application/v6/applications/${appId}?lang=zh_cn`, { headers, signal: AbortSignal.timeout(15_000) })).json()) as AppInfo;
      const info = app.code === 0 ? app.data?.app : undefined;
      const have = new Set((info?.scopes ?? []).map((s) => s.scope));
      if (have.size) {
        missing = LARK_BOT_ADDONS.scopes.tenant.filter((s) => !have.has(s));
        unknown = false;
      }
      if (Array.isArray(info?.event?.subscribed_events)) subs.events = info.event.subscribed_events;
      subs.eventMode = info?.event?.subscription_type ?? null;
      const cb = info?.callback ?? info?.callback_info;
      if (Array.isArray(cb?.subscribed_callbacks)) subs.callbacks = cb.subscribed_callbacks;
      subs.callbackMode = cb?.callback_type ?? null;
      // The version online is what Feishu delivers; a subscription added since needs a new version.
      if (info?.online_version_id) {
        try {
          const v = (await (await request(`${base}/application/v6/applications/${appId}/app_versions/${info.online_version_id}?lang=zh_cn`, { headers, signal: AbortSignal.timeout(15_000) })).json()) as { code?: number; data?: { app_version?: { events?: string[] } } };
          const ev = v.code === 0 ? v.data?.app_version?.events : undefined;
          if (Array.isArray(ev) && ev.every((e) => typeof e === "string" && e.includes("."))) subs.publishedEvents = ev;
        } catch {}
      }
    } catch {}
    return { botName: bot.bot?.app_name, botOpenId: bot.bot?.open_id, missingScopes: missing, ...(unknown ? { scopesUnknown: true } : {}), ...subs };
  } catch (e) {
    return { missingScopes: [], error: `连不上飞书开放平台：${(e as Error).message}` };
  }
}

export function larkSecretsExist(home: string) {
  return existsSync(secretFile(home));
}
