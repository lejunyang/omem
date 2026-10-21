import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../core/config.ts";
import { agentRunError, replyFromSegments, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";

/**
 * Doubao as a model backend, through the Doubao OpenAPI (Managed Agent: sessions, events,
 * per-reply SSE stream). It runs in Doubao's cloud: no local process, no omem MCP tools —
 * what the model knows is what the prompt carries, so it suits answering and writing, not
 * investigating with omem's tools.
 *
 * Auth is a user access token from a Feishu app that has the doubao:* user scopes (the user
 * authorizes once by device code). Apps differ: lark-cli's app, omem's own bot app, … Each one
 * the owner may use is checked for the scopes (`doubaoApps`), and the token is kept per app in
 * `<home>/secrets/doubao.json` (owner-only), refreshed with the refresh token.
 */

export const DOUBAO_BASE = "https://open.doubao.com/open-apis/agent";
const FEISHU = "https://open.feishu.cn/open-apis";
const ACCOUNTS = "https://accounts.feishu.cn";
/** What a chat turn needs. offline_access gives the refresh token. */
export const DOUBAO_SCOPES = [
  "doubao:session:write",
  "doubao:session:read",
  "doubao:session.event:write",
  "doubao:session.event:read",
  "doubao:session.message:read",
  "doubao:session.message.stream:read",
  "doubao:session.artifact:read",
  "doubao:file:write",
];
const REQUIRED = ["doubao:session:write", "doubao:session.event:write", "doubao:session.message.stream:read"];

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...a) => fetch(...a);
/** Tests: answer HTTP calls without the network. */
export function setDoubaoFetchForTests(f: FetchLike | null) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

// ---- tokens --------------------------------------------------------------------------------

export type DoubaoToken = { appId: string; accessToken: string; refreshToken?: string; expiresAt: string; refreshExpiresAt?: string; scope?: string; savedAt: string };
const tokenFile = (home: string) => join(home, "secrets", "doubao.json");

export function readDoubaoTokens(home: string): Record<string, DoubaoToken> {
  try {
    const v = JSON.parse(readFileSync(tokenFile(home), "utf8"));
    // The first version kept one token at the top level.
    if (v && typeof v.accessToken === "string" && typeof v.appId === "string") return { [v.appId]: v };
    return v ?? {};
  } catch {
    return {};
  }
}

export function saveDoubaoToken(home: string, t: DoubaoToken) {
  const dir = join(home, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = readDoubaoTokens(home);
  all[t.appId] = t;
  writeFileSync(tokenFile(home), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tokenFile(home), 0o600);
  } catch {}
}

function tokenFrom(appId: string, t: { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string }): DoubaoToken {
  const now = Date.now();
  return {
    appId,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(now + (t.expires_in ?? 7200) * 1000).toISOString(),
    refreshExpiresAt: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : undefined,
    scope: t.scope,
    savedAt: new Date(now).toISOString(),
  };
}

/** App credentials omem can use for the OAuth calls: its bot (and any app it keeps a secret for). */
export type DoubaoApp = { appId: string; secret: string; name?: string };

async function oauthToken(app: DoubaoApp, body: Record<string, string>) {
  const r = await fetchImpl(`${FEISHU}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: app.appId, client_secret: app.secret, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  return (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string; error_description?: string; code?: number; msg?: string };
}

/** A usable access token for this app, refreshed when it is about to expire; null when the owner must authorize again. */
export async function doubaoAccessToken(home: string, app: DoubaoApp): Promise<string | null> {
  const t = readDoubaoTokens(home)[app.appId];
  if (!t) return null;
  if (Date.parse(t.expiresAt) - Date.now() > 5 * 60_000) return t.accessToken;
  if (!t.refreshToken || (t.refreshExpiresAt && Date.parse(t.refreshExpiresAt) < Date.now())) return null;
  const r = await oauthToken(app, { grant_type: "refresh_token", refresh_token: t.refreshToken });
  if (!r.access_token) return null;
  const next = tokenFrom(app.appId, r as { access_token: string });
  // Feishu may not return a new refresh token on every refresh.
  if (!next.refreshToken) Object.assign(next, { refreshToken: t.refreshToken, refreshExpiresAt: t.refreshExpiresAt });
  saveDoubaoToken(home, next);
  return next.accessToken;
}

/**
 * Device-code authorization (RFC 8628) as the owner, for the doubao scopes on one app.
 * `onCode` gets the link to open in Feishu; resolves once the owner confirms (or rejects on expiry).
 */
export async function authorizeDoubao(home: string, app: DoubaoApp, onCode: (url: string, userCode: string, expiresIn: number) => void, signal?: AbortSignal): Promise<DoubaoToken> {
  const basic = "Basic " + Buffer.from(`${app.appId}:${app.secret}`).toString("base64");
  const r = await fetchImpl(`${ACCOUNTS}/oauth/v1/device_authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
    body: new URLSearchParams({ client_id: app.appId, scope: [...DOUBAO_SCOPES, "offline_access"].join(" ") }),
    signal: AbortSignal.timeout(20_000),
  });
  const d = (await r.json()) as { device_code?: string; user_code?: string; verification_uri_complete?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
  if (!d.device_code) throw new Error(`飞书没有发起授权：${d.error_description ?? d.error ?? r.status}`);
  onCode(d.verification_uri_complete ?? d.verification_uri ?? "", d.user_code ?? "", d.expires_in ?? 600);
  let interval = (d.interval ?? 5) * 1000;
  const until = Date.now() + (d.expires_in ?? 600) * 1000;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, interval));
    if (signal?.aborted) throw new Error("CANCELLED");
    const t = await oauthToken(app, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code });
    if (t.access_token) {
      const tok = tokenFrom(app.appId, t as { access_token: string });
      saveDoubaoToken(home, tok);
      return tok;
    }
    if (t.error === "slow_down") interval += 5000;
    else if (t.error && t.error !== "authorization_pending") throw new Error(`授权没有完成：${t.error_description ?? t.error}`);
  }
  throw new Error("授权链接已过期，请重新发起");
}

// ---- which app may use it --------------------------------------------------------------------

export type DoubaoAppStatus = {
  appId: string;
  name?: string;
  /** Doubao user scopes the app has been granted in the developer console. */
  granted: string[];
  missing: string[];
  /** Whether this omem holds a user token for it, and whether that token still works. */
  authorized: boolean;
  tokenScope?: string;
  error?: string;
};

/** Check one app: its granted doubao scopes (tenant token → application info) and the saved user token. */
export async function checkDoubaoApp(home: string, app: DoubaoApp): Promise<DoubaoAppStatus> {
  const out: DoubaoAppStatus = { appId: app.appId, name: app.name, granted: [], missing: [...REQUIRED], authorized: false };
  try {
    const t = (await (await fetchImpl(`${FEISHU}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: app.appId, app_secret: app.secret }), signal: AbortSignal.timeout(15_000) })).json()) as { tenant_access_token?: string; code?: number; msg?: string };
    if (!t.tenant_access_token) return { ...out, error: `应用凭据不可用（${t.code}：${t.msg ?? ""}）` };
    const info = (await (await fetchImpl(`${FEISHU}/application/v6/applications/${app.appId}?lang=zh_cn`, { headers: { authorization: `Bearer ${t.tenant_access_token}` }, signal: AbortSignal.timeout(15_000) })).json()) as { code?: number; data?: { app?: { app_name?: string; scopes?: { scope: string; token_types?: string[] }[] } } };
    const scopes = info.data?.app?.scopes ?? [];
    out.name ??= info.data?.app?.app_name;
    out.granted = scopes.filter((s) => s.scope.startsWith("doubao:") && (!s.token_types || s.token_types.includes("user"))).map((s) => s.scope);
    out.missing = REQUIRED.filter((s) => !out.granted.includes(s));
  } catch (e) {
    out.error = `连不上飞书开放平台：${(e as Error).message}`;
  }
  const saved = readDoubaoTokens(home)[app.appId];
  if (saved) {
    out.tokenScope = saved.scope;
    try {
      const token = await doubaoAccessToken(home, app);
      if (token) {
        const r = await fetchImpl(`${DOUBAO_BASE}/v1/sessions?page_size=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        const v = (await r.json().catch(() => ({}))) as { code?: number; msg?: string };
        out.authorized = r.ok && v.code === 0;
        if (!out.authorized) out.error = `豆包接口拒绝了授权（${v.code ?? r.status}：${v.msg ?? ""}）`;
      }
    } catch (e) {
      out.error = `豆包接口不可用：${(e as Error).message}`;
    }
  }
  return out;
}

// ---- API -----------------------------------------------------------------------------------

type Envelope<T> = { code: number; msg: string; data: T };
type Message = { id: string; role: "user" | "assistant"; status: string; reply_id?: string; items?: Item[] };
type Item = { id: string; type: string; seq?: number; text?: string; summary?: { text: string }[]; artifact_type?: string; name?: string; document?: { url?: string }; file?: { url?: string }; link?: { url?: string }; image?: { url?: string } };

async function api<T>(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetchImpl(`${DOUBAO_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const v = (await r.json().catch(() => null)) as Envelope<T> | null;
  if (!v || v.code !== 0) {
    const code = v?.code ?? r.status;
    const msg = `豆包接口 ${method} ${path.replace(/\/\d{6,}/g, "/…")}：${code} ${v?.msg ?? r.statusText}`;
    if (code === 429001 || r.status === 429) throw agentRunError(msg, "rate-limit");
    if (code === 401001 || r.status === 401 || code === 99991663 || code === 99991668) throw new Error(`${msg}（授权失效，运行 omem doubao login 重新授权）`);
    throw new Error(msg);
  }
  return v.data;
}

/** Parse one SSE stream into (event, data) frames. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ev: { event: string; data: string[]; id?: string } = { event: "message", data: [] };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (ev.data.length) yield { event: ev.event, data: ev.data.join("\n"), id: ev.id };
        ev = { event: "message", data: [] };
      } else if (line.startsWith(":")) continue;
      else {
        const i = line.indexOf(":");
        const k = i < 0 ? line : line.slice(0, i);
        const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (k === "event") ev.event = v;
        else if (k === "data") ev.data.push(v);
        else if (k === "id") ev.id = v;
      }
    }
  }
  if (ev.data.length) yield { event: ev.event, data: ev.data.join("\n"), id: ev.id };
}

function artifactLine(it: Item) {
  const url = it.document?.url ?? it.link?.url ?? it.file?.url ?? it.image?.url;
  return url ? `\n\n[${it.name ?? it.artifact_type ?? "产物"}](${url})` : "";
}

/**
 * One prompt turn. A new Doubao session is created per turn unless `resumeSessionId` names one
 * (threads keep it, so the conversation continues there). The reply streams from MessageStream;
 * reasoning becomes thoughts, artifacts are appended as links.
 */
export async function runDoubao(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void, ctx: { home: string; app: DoubaoApp }): Promise<AgentResult> {
  if (req.probe) return { text: "", stopReason: "probe", agent: "豆包", probe: { agent: "豆包 OpenAPI", modes: [], options: [] } };
  const token = await doubaoAccessToken(ctx.home, ctx.app);
  if (!token) throw new Error("豆包还没有授权：在运行 omem 的电脑上执行 omem doubao login（或网页 Agent 页的豆包授权）");
  const signal = req.signal;
  const userMessage = { type: "user.message", contents: [{ type: "text", text: req.prompt }] };
  let sessionId = req.resumeSessionId;
  let queryId: string;
  if (sessionId) {
    try {
      const d = await api<{ messages: Message[] }>(token, "POST", `/v1/sessions/${sessionId}/events`, { uuid: randomUUID(), events: [userMessage] });
      queryId = d.messages[0].id;
    } catch (e) {
      if ((e as Error).message === "CANCELLED") throw e;
      emit({ type: "status", text: `无法继续之前的豆包会话，改为新会话：${(e as Error).message.slice(0, 120)}` });
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const d = await api<{ id: string; messages: Message[] }>(token, "POST", "/v1/sessions", { uuid: randomUUID(), initial_events: [userMessage] });
    sessionId = d.id;
    queryId = d.messages[0].id;
  }
  emit({ type: "status", text: "已连接 豆包" });

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | null = null;
  let gotOutput = false;
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error("idle")), profile.idleTimeoutMs);
  };
  const texts = new Map<string, string>();
  const order: { id: string; seq: number; kind: "text" | "artifact"; value: string }[] = [];
  let replyId: string | undefined;
  let status = "in_progress";
  try {
    touch();
    const r = await fetchImpl(`${DOUBAO_BASE}/v1/sessions/${sessionId}/events/${queryId!}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error(`豆包消息流打不开：HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    for await (const f of sse(r.body)) {
      touch();
      let d: Record<string, any>;
      try {
        d = JSON.parse(f.data);
      } catch {
        continue;
      }
      switch (f.event) {
        case "text.delta": {
          gotOutput = true;
          const prev = texts.get(d.id) ?? "";
          texts.set(d.id, prev + String(d.delta ?? ""));
          emit({ type: "text", text: String(d.delta ?? "") });
          break;
        }
        case "text": {
          gotOutput = true;
          const full = String(d.text ?? "");
          const seen = texts.get(d.id) ?? "";
          // Frames without preview (reconnect, non-streamed text): show what was not streamed.
          if (full.startsWith(seen) && full.length > seen.length) emit({ type: "text", text: full.slice(seen.length) });
          texts.set(d.id, full);
          order.push({ id: d.id, seq: Number(d.seq ?? order.length), kind: "text", value: full });
          break;
        }
        case "reasoning.delta":
          gotOutput = true;
          emit({ type: "thought", text: String(d.delta ?? "") });
          break;
        case "artifact": {
          gotOutput = true;
          const line = artifactLine(d as Item);
          order.push({ id: d.id, seq: Number(d.seq ?? order.length), kind: "artifact", value: line });
          emit({ type: "tool", id: String(d.id), title: `产物：${d.name ?? d.artifact_type ?? ""}`, kind: "other", status: "completed" });
          break;
        }
        case "message.in_progress":
          replyId = d.message?.id ?? d.message_id;
          break;
        case "message.completed":
        case "message.failed":
        case "message.cancelled":
          status = f.event.slice("message.".length);
          replyId = d.message?.id ?? d.message_id ?? replyId;
          break;
        case "error":
          throw new Error(`豆包返回错误：${JSON.stringify(d.error ?? d).slice(0, 300)}`);
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      void api(token, "POST", `/v1/sessions/${sessionId}/events`, { uuid: randomUUID(), events: [{ type: "user.interrupt", ...(replyId ? { message_id: replyId } : {}) }] }).catch(() => {});
      throw new Error("CANCELLED");
    }
    if (ctrl.signal.aborted)
      throw gotOutput
        ? agentRunError(`豆包超过 ${Math.round(profile.idleTimeoutMs / 1000)} 秒没有任何活动，已停止`, "idle")
        : agentRunError(`豆包 ${Math.round(profile.idleTimeoutMs / 1000)} 秒内没有开始回答，已停止`, "queue", true);
    throw e;
  } finally {
    if (idle) clearTimeout(idle);
    signal?.removeEventListener("abort", onAbort);
  }
  // The stream ended without a final frame (dropped connection): the stored reply is authoritative.
  if (status === "in_progress" && replyId) {
    const m = await api<Message>(token, "GET", `/v1/sessions/${sessionId}/messages/${replyId}`).catch(() => null);
    if (m) {
      status = m.status;
      order.length = 0;
      for (const it of m.items ?? []) {
        if (it.type === "text") order.push({ id: it.id, seq: it.seq ?? 0, kind: "text", value: it.text ?? "" });
        else if (it.type === "artifact") order.push({ id: it.id, seq: it.seq ?? 0, kind: "artifact", value: artifactLine(it) });
      }
    }
  }
  if (status === "failed") throw new Error("豆包没有完成这次回答（failed）");
  order.sort((a, b) => a.seq - b.seq);
  const segments = order.filter((o) => o.kind === "text").map((o) => o.value);
  const links = order.filter((o) => o.kind === "artifact").map((o) => o.value).join("");
  const text = segments.join("\n\n") + links;
  const reply = replyFromSegments(segments);
  return { text, reply: reply ? reply + links : undefined, stopReason: status === "cancelled" ? "cancelled" : "end_turn", sessionId, agent: "豆包" };
}

/** The app whose token a doubao profile uses: `env.DOUBAO_APP_ID` on the profile, else the bot. */
export function doubaoAppFor(home: string, profile: AgentProfile, apps: DoubaoApp[]): DoubaoApp | null {
  const wanted = profile.env?.DOUBAO_APP_ID;
  if (wanted) return apps.find((a) => a.appId === wanted) ?? null;
  const tokens = readDoubaoTokens(home);
  return apps.find((a) => tokens[a.appId]) ?? apps[0] ?? null;
}

export function doubaoTokenExists(home: string) {
  return existsSync(tokenFile(home)) && Object.keys(readDoubaoTokens(home)).length > 0;
}

// ---- wiring --------------------------------------------------------------------------------

/**
 * Apps omem can authorize Doubao with: every Feishu app it holds a secret for (the bot first).
 * lark-cli's app is listed by `doubaoStatus` for its scopes, but its secret stays in lark-cli.
 */
export async function doubaoApps(home: string, config: { lark: { appId?: string; appSecretEnv: string } }): Promise<DoubaoApp[]> {
  const { readLarkSecrets, larkAppSecret } = await import("../channels/lark-setup.ts");
  const out: DoubaoApp[] = [];
  const bot = config.lark.appId;
  const botSecret = larkAppSecret(home, bot, config.lark.appSecretEnv);
  const secrets = readLarkSecrets(home);
  if (bot && botSecret) out.push({ appId: bot, secret: botSecret, name: secrets[bot]?.name });
  for (const [appId, v] of Object.entries(secrets)) if (appId !== bot && v.appSecret) out.push({ appId, secret: v.appSecret, name: v.name });
  return out;
}

/** Every app the owner might use, with what it lacks: the ones omem can authorize and lark-cli's own. */
export async function doubaoStatus(home: string, config: { lark: { appId?: string; appSecretEnv: string } }) {
  const apps = await doubaoApps(home, config);
  const checked = await Promise.all(apps.map((a) => checkDoubaoApp(home, a)));
  let larkCliApp: { appId: string; granted: string[]; missing: string[]; usable: false; note: string } | null = null;
  try {
    const { larkCli } = await import("../channels/lark-cli.ts");
    const v = (await larkCli(["auth", "scopes"], 30_000)) as { appId?: string; userScopes?: string[] };
    if (v.appId && !apps.some((a) => a.appId === v.appId)) {
      const granted = (v.userScopes ?? []).filter((s) => s.startsWith("doubao:"));
      const missing = REQUIRED.filter((s) => !granted.includes(s));
      larkCliApp = { appId: v.appId, granted, missing, usable: false, note: missing.length ? "lark-cli 的应用没有开通豆包权限" : "lark-cli 的应用有豆包权限，但它的 App Secret 不在 omem 里：用 omem 机器人授权，或在 omem setup 里绑定这个应用" };
    }
  } catch {}
  return { apps: checked, larkCliApp, ready: checked.find((a) => a.authorized)?.appId ?? null };
}
