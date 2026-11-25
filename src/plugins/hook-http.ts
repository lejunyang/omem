import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../core/app.ts";
import { hookBodyHash, hookInbox } from "./hook-inbox.ts";
import { HOOK_BODY_MAX, HOOK_HEADER_BYTES, HOOK_HEADER_MAX, HOOK_QUERY_BYTES, hookDeliveryKey, hookEvent, hookReceipt, hookRequestHeaders, parseHookEvent } from "./hook-request.ts";
import { checkHookSecret, hookRetryAfter, pluginHook, type RegisteredHook } from "./hooks.ts";
import type { PluginHookJson } from "./types.ts";

type Params = { plugin: string; name: string; secret?: string };
const sendJson = (reply: FastifyReply, body: PluginHookJson | undefined, error: string) => reply.type("application/json; charset=utf-8")
  .send(Buffer.from(JSON.stringify(body === undefined ? { error } : body)));
const unauthorized = (reply: FastifyReply, hook?: RegisteredHook) => sendJson(reply.status(401).header("www-authenticate", "Bearer"), hook?.unauthorizedBody, "回调密钥无效");
const unavailable = (reply: FastifyReply, hook?: RegisteredHook, retry = 1) => sendJson(reply.status(503).header("retry-after", String(retry)), hook?.unavailableBody, "回调收件箱暂时不可用");
const rateLimited = (reply: FastifyReply, hook: RegisteredHook, retry: number) => sendJson(reply.status(429).header("retry-after", String(retry)), hook.rateLimitedBody, "回调太频繁");

function credential(req: FastifyRequest, params: Params) {
  if (params.secret !== undefined) return params.secret;
  const bearer = /^Bearer +([^\s,]+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const custom = pluginHook(params.plugin, params.name)?.secretHeader?.toLowerCase();
  const value = custom ? req.headers[custom] : undefined;
  return bearer ?? (typeof value === "string" ? value : "");
}

export async function registerHookRoutes(server: FastifyInstance, app: App) {
  const inbox = hookInbox(app);
  await server.register(async (scope) => {
    scope.addHook("onReady", async () => inbox.start());
    scope.addHook("preClose", async () => inbox.pause());
    scope.addHook("onClose", async () => inbox.stop());
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: HOOK_BODY_MAX }, (_req, body, done) => done(null, body));
    for (const url of ["/api/hooks/:plugin/:name", "/api/hooks/:plugin/:name/:secret"]) scope.route({
      method: "POST", url, bodyLimit: HOOK_BODY_MAX,
      async onRequest(req, reply) {
        const params = req.params as Params;
        const headers = req.raw.rawHeaders;
        if (headers.length / 2 > HOOK_HEADER_MAX || headers.reduce((bytes, part) => bytes + Buffer.byteLength(part) + 2, 0) > HOOK_HEADER_BYTES)
          return reply.status(431).send({ error: "回调请求头过多或过大" });
        const hook = pluginHook(params.plugin, params.name);
        try {
          if (!checkHookSecret(app, params.plugin, params.name, credential(req, params), false)) return unauthorized(reply, hook);
        } catch { return unavailable(reply, hook); }
        const queryAt = req.url.indexOf("?");
        if (queryAt >= 0 && Buffer.byteLength(req.url.slice(queryAt + 1)) > HOOK_QUERY_BYTES)
          return reply.status(414).send({ error: "回调查询参数过大" });
      },
      async onResponse(_req, reply) { if (reply.statusCode >= 200 && reply.statusCode < 300) inbox.schedule(); },
      async handler(req, reply) {
        const params = req.params as Params;
        const hook = pluginHook(params.plugin, params.name);
        try {
          if (!checkHookSecret(app, params.plugin, params.name, credential(req, params)) || !hook) return unauthorized(reply, hook);
        } catch { return unavailable(reply, hook); }
        const retry = hook.respond ? hookRetryAfter(app, hook) : 0;
        if (retry) return rateLimited(reply, hook, retry);
        const headers = hookRequestHeaders(hook, req.headers);
        const query = Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).map(([name, value]) => [name, String(Array.isArray(value) ? value[0] : value)]));
        const envelope = { method: "POST" as const, headers, query };
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const body = bytes.toString("utf8");
        const parsed = parseHookEvent(body, hook.format);
        const key = hookDeliveryKey(hook, headers, parsed.raw);
        if (key === undefined) return reply.status(400).send({ error: { code: "IDEMPOTENCY_MISMATCH", message: "回调幂等标识必须在请求头和正文中一致" } });
        let receipt: ReturnType<typeof inbox.admit>;
        try { receipt = inbox.admit(hook, envelope, body, parsed.format, key, key === null ? null : hookBodyHash(bytes)); }
        catch { return unavailable(reply, hook); }
        if ("status" in receipt) return receipt.status === 429 ? rateLimited(reply, hook, receipt.retry) : unavailable(reply, hook, receipt.retry);
        const { duplicate, conflict, deliveryId } = receipt;
        const request = { ...envelope, body, event: hookEvent(parsed), deliveryId, deliveryKey: key };
        if (hook.respond) {
          let response: Awaited<ReturnType<typeof hook.respond>> | undefined;
          try { response = await hook.respond(request, { duplicate, conflict, deliveryId }); }
          catch { response = undefined; }
          if (receipt.staged) {
            try { inbox.finishAdmission(deliveryId, response?.status ?? 500); }
            catch { if (response) return unavailable(reply, hook); }
          }
          if (!response) return reply.status(500).send({ error: "回调受理失败" });
          return reply.status(response.status).headers(response.headers).send(Buffer.from(response.body));
        }
        if (conflict) return reply.status(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "幂等标识对应的请求体不同" } });
        const result = !duplicate && hook.ack !== "first" ? await inbox.sync(hook, request) : null;
        const protocol = hookReceipt(parsed, deliveryId, receipt.at);
        if (protocol) {
          if (protocol.contentType) reply.type(protocol.contentType);
          return reply.status(protocol.status).send(protocol.body);
        }
        return result ?? reply.status(duplicate ? 200 : 202).send({ ok: true, id: deliveryId, duplicate });
      },
    });
  });
}
