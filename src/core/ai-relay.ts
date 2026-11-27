import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "./app.ts";
import { allProfiles, providerFormats, type AgentProfile } from "./config.ts";
import { keyOf } from "./ai-keys.ts";
import { relayActivity, relayTokenOk } from "./ai-relay-addr.ts";
import { markDown, markOutOfQuota, outOfQuotaList, quotaResetAt } from "../agents/capacity.ts";
import { agentRunError } from "../agents/types.ts";
import { classifyError, type ErrorKind } from "./ai-errors.ts";
import { estimatedAiTokens, MINUTE_LIMIT_EXHAUSTED, requestWithAiLimit, streamWithAiUsage } from "./ai-request.ts";
import { notify } from "./notify.ts";

/**
 * omem's relay for backends run on an API key: the agent talks to `/api/ai/relay/<provider>/
 * <backend>/<format>/…` with a token of its own, omem adds the key and passes the request on as it
 * is, the answer back as it comes (streamed). What it is for is the errors: agents report a
 * provider's error in their own words, often without its code (Codex turns every 429 into
 * "exceeded retry limit", Claude Code retries for minutes), so omem reads them here and acts by
 * their kind (core/ai-errors.ts, by the provider's own codes):
 *
 * - `rate`: configured minute limits wait in the key/model queue. Other rate errors use short
 *   retries. If still refused, pass on the 429 and set the key aside for new runs.
 * - `daily`: the key's backends left out until the owner's midnight.
 * - `quota` / `auth`: left out until a check on the API key page passes (a day at most), the owner
 *   told once. `daily` and `quota` are passed on as 400, which no agent retries, so the run ends in
 *   seconds and moves on to the next backend.
 *
 * The decision models (core/decision.ts) report their errors here too (`noteProviderError`), so the
 * API key page shows one record per key.
 */
export type RelayError = { at: number; status: number; kind: ErrorKind; code: string; message: string; backend: string };

// ------------------------------------------------------------------ what it saw

type Seen = { errors: RelayError[]; told?: number };
const seen = new WeakMap<App, Map<string, Seen>>();
const seenOf = (app: App, provider: string) => {
  let m = seen.get(app);
  if (!m) seen.set(app, (m = new Map()));
  let s = m.get(provider);
  if (!s) m.set(provider, (s = { errors: [] }));
  return s;
};
const HOUR = 3_600_000;

/** Errors of one key in the last hour, by kind, and the latest: for the API key page. */
export function relayStats(app: App, provider: string, now = Date.now()) {
  const errors = (seen.get(app)?.get(provider)?.errors ?? []).filter((e) => now - e.at < HOUR);
  if (!errors.length) return null;
  const counts: Partial<Record<ErrorKind, number>> = {};
  for (const e of errors) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { counts, last: errors.at(-1)! };
}

/** The error a backend's run ran into since it started, in a form the failover understands (null: none seen). */
export function relayFailure(app: App, profile: AgentProfile, since: number): (Error & { resetAt?: Date }) | null {
  if (!profile.keyRelay || !profile.keyRef) return null;
  const e = (seen.get(app)?.get(profile.keyRef)?.errors ?? []).filter((x) => x.at >= since && x.backend === profile.id).at(-1);
  if (!e) return null;
  const what = `${e.code || e.status}${e.message ? `：${e.message}` : ""}`;
  const name = profile.name ?? profile.id;
  if (e.kind === "rate") return agentRunError(`${name} 被提供方限流（${what}），换一个后端`, "rate-limit");
  if (e.kind === "daily" || e.kind === "quota" || e.kind === "auth") {
    const err = agentRunError(`${name} 的 API key ${e.kind === "daily" ? "今天的用量到上限了" : e.kind === "auth" ? "被提供方拒绝" : "额度用完或欠费"}（${what}）`, "quota") as Error & { resetAt?: Date };
    err.resetAt = resumeAt(app, e.kind, e.at);
    return err;
  }
  return null;
}

export const resumeAt = (app: App, kind: ErrorKind, at: number) =>
  kind === "daily" ? quotaResetAt("daily limit", new Date(at), app.config.timezone) : new Date(at + 24 * HOUR);

/**
 * One error answer of a key's provider: kept for the API key page, and for an agent's backend the
 * key set aside by its kind; the owner told when it needs them. `profile`: the backend that got it
 * (none for omem's own calls, the decision models).
 */
export function noteProviderError(app: App, provider: string, status: number, c: ReturnType<typeof classifyError>, profile?: AgentProfile) {
  const s = seenOf(app, provider);
  const now = Date.now();
  const e: RelayError = { at: now, status, ...c, backend: profile?.id ?? "" };
  s.errors = [...s.errors.filter((x) => now - x.at < HOUR).slice(-199), e];
  const what = `${c.code || status}${c.message ? `：${c.message}` : ""}`;
  if (profile && c.kind === "rate") markDown(app, profile, `提供方限流（${what}）`, now, "backend", 60_000);
  if (c.kind === "daily" || c.kind === "quota" || c.kind === "auth") {
    if (profile) markOutOfQuota(app, profile, what, new Date(now), resumeAt(app, c.kind, now), false);
    // Something the owner has to do (top up, raise the limit, a new key): said once in a while, not per request.
    if (c.kind !== "daily" && (!s.told || now - s.told > 6 * HOUR)) {
      s.told = now;
      const p = app.config.ai.providers.find((x) => x.id === provider);
      try {
        notify(app, {
          title: `API key「${p?.name || provider}」${c.kind === "auth" ? "被提供方拒绝" : "额度用完或欠费"}`,
          body: `提供方返回 ${status} ${what}。${profile ? "用这个 key 的后端先不用了，换别的后端接着做；" : "这个 key 的模型先排到后面；"}处理好以后到 设置 → 后端与模型 → API key 点“检查”恢复。`,
          link: "#/settings?tab=agents&section=keys",
          urgency: "normal",
        });
      } catch {}
    }
  }
}

/** Whether a key's backends are set aside for a spent quota or a refused key, and until when. */
export function keyPaused(app: App, provider: string) {
  const q = outOfQuotaList(app).find((x) => x.source === `key:${provider}`);
  return q ? { until: q.until, message: q.message } : null;
}

/** The owner's "检查" passed: the key's own records start over. */
export function forgetRelayErrors(app: App, provider: string) {
  seen.get(app)?.delete(provider);
}

// ------------------------------------------------------------------ passing requests on

const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "authorization", "x-api-key", "accept-encoding", "keep-alive", "proxy-authorization", "proxy-connection", "te", "upgrade"]);
const RATE_WAITS = [2_000, 5_000, 10_000];

let relayFetch: typeof fetch = (...a) => fetch(...a);
/** Tests stand in for the provider. */
export function setRelayFetchForTests(f: typeof fetch | null) {
  relayFetch = f ?? ((...a) => fetch(...a));
}
let waitFor = (ms: number, signal: AbortSignal) => new Promise<void>((done) => {
  const t = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
});
export function setRelayWaitForTests(f: ((ms: number, signal: AbortSignal) => Promise<void>) | null) {
  waitFor = f ?? ((ms, signal) => new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
  }));
}

/**
 * A request for a model the key does not have, from a backend that runs on a third party's models: the
 * agent's own side calls name its vendor's model (Codex titles a session with a built-in model whatever
 * the provider), which this provider would refuse. They go to the backend's default model instead.
 */
export function onKeyModels(profile: Pick<AgentProfile, "keyModels" | "model">, body: Buffer | undefined) {
  const models = profile.keyModels;
  if (!body?.length || !models?.length || body[0] !== 0x7b) return body;
  try {
    const j = JSON.parse(body.toString("utf8")) as { model?: unknown };
    if (typeof j.model !== "string" || models.includes(j.model)) return body;
    j.model = profile.model && models.includes(profile.model) ? profile.model : models[0];
    return Buffer.from(JSON.stringify(j));
  } catch {
    return body;
  }
}

const INFERENCE_PATHS = new Set([
  "responses", "responses/compact", "chat/completions", "completions", "messages", "embeddings", "rerank", "images/generations",
]);
function inferenceBody(rest: string, body: Buffer | undefined) {
  if (!body || !INFERENCE_PATHS.has(rest.replace(/^v1\//, ""))) return;
  try {
    const fields = JSON.parse(body.toString("utf8"));
    if (typeof fields?.model === "string") return fields as Record<string, unknown> & { model: string };
  } catch {}
}

export async function relayRequest(app: App, req: FastifyRequest, reply: FastifyReply) {
  const { provider, backend, format } = req.params as { provider: string; backend: string; format: string };
  const rest = (req.params as Record<string, string>)["*"] ?? "";
  const header = req.headers["x-api-key"] ?? (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
  const given = Array.isArray(header) ? header[0] : header;
  const activity = relayActivity(backend, given);
  if (!activity && !relayTokenOk(backend, given)) return reply.code(401).send({ error: { code: "omem_relay_token", message: "omem 转发：令牌不对（只给 omem 启动的后端用）" } });
  const p = app.config.ai.providers.find((x) => x.id === provider);
  const profile = allProfiles(app.config).find((x) => x.id === backend && x.keyRef === provider);
  const upstream = p && (format === "openai" || format === "anthropic") ? providerFormats(p)[format] : undefined;
  if (!p || !profile || !upstream) return reply.code(404).send({ error: { code: "omem_relay_unknown", message: "omem 转发：没有这个 API key 或后端" } });
  const key = keyOf(provider, app.home);
  if (!key) return reply.code(401).send({ error: { code: "omem_relay_no_key", message: `omem 转发：API key ${provider} 还没有填写` } });
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const url = `${upstream.url}/${rest}${query}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") headers[k] = v;
  // A vendor's own Anthropic API takes the key as x-api-key; third parties (Ark and the like) want Bearer.
  if (format === "anthropic" && p.kind === "anthropic") headers["x-api-key"] = key;
  else headers.authorization = `Bearer ${key}`;
  let body = onKeyModels(profile, req.method === "POST" ? req.body as Buffer | undefined : undefined);
  const fields = p.limits ? inferenceBody(rest, body) : undefined;
  const gone = new AbortController();
  reply.raw.on("close", () => { if (!reply.raw.writableFinished) gone.abort(); });

  for (let attempt = 0; ; attempt++) {
    const send = () => relayFetch(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: gone.signal });
    let result;
    try {
      result = fields
        ? await requestWithAiLimit(app, p, fields.model, () => {
          if (fields.stream === true && rest.replace(/^v1\//, "") === "chat/completions" && (p.kind === "ark" || p.kind === "openai")) {
            body = Buffer.from(JSON.stringify({ ...fields, stream_options: { ...(fields.stream_options as object), include_usage: true } }));
          }
          return estimatedAiTokens(body!, fields, /(?:embeddings|rerank|images\/generations)$/.test(rest) ? 0 : 4096);
        }, {
          signal: gone.signal,
          onWait: (ms) => activity?.(`按 API key 的限额等了 ${Math.max(1, Math.round(ms / 1000))} 秒`),
        }, send)
        : { response: await send() };
    } catch (e) {
      if (gone.signal.aborted) return reply;
      return reply.code(502).send({ error: { code: "omem_relay_unreachable", message: `omem 转发：连不上 ${new URL(url).host}：${(e as Error).message}` } });
    }
    const { response: r, errorText, settle, minuteRetriesExhausted } = result;
    if (r.ok) {
      reply.code(r.status);
      for (const h of ["content-type", "cache-control", "x-request-id", "openai-model"]) {
        const v = r.headers.get(h);
        if (v) reply.header(h, v);
      }
      const stream = settle && r.body ? streamWithAiUsage(r.body, r.headers.get("content-type") ?? "", settle) : r.body;
      return reply.send(stream ? Readable.fromWeb(stream as import("node:stream/web").ReadableStream) : "");
    }
    const text = errorText ?? await r.text().catch(() => "");
    const c = classifyError(p.kind, r.status, text);
    // A short limit: wait it out here (the provider's Retry-After when it gives one), then try again.
    const after = Number(r.headers.get("retry-after"));
    if (minuteRetriesExhausted) {
      activity?.(MINUTE_LIMIT_EXHAUSTED);
      c.message = [c.message, MINUTE_LIMIT_EXHAUSTED].filter(Boolean).join(" ");
    } else if (c.kind === "rate" && attempt < RATE_WAITS.length && (!after || after <= 15)) {
      await waitFor(after ? after * 1000 : RATE_WAITS[attempt], gone.signal);
      if (gone.signal.aborted) return reply;
      continue;
    }
    noteProviderError(app, provider, r.status, c, profile);
    // Retrying will not help with these: say so with a status no agent retries.
    const status = c.kind === "daily" || c.kind === "quota" ? 400 : r.status;
    reply.code(status).header("content-type", r.headers.get("content-type") ?? "application/json").header("x-omem-relay-status", String(r.status));
    return reply.send(text);
  }
}
