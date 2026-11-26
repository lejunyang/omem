import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { classifyError } from "../src/core/ai-errors.ts";
import { keyEnv, setKey, useKeyHome } from "../src/core/ai-keys.ts";
import { relayToken, useRelayBase } from "../src/core/ai-relay-addr.ts";
import { onKeyModels, relayFailure, setRelayFetchForTests, setRelayWaitForTests } from "../src/core/ai-relay.ts";
import { configSchema, keyedProfiles } from "../src/core/config.ts";
import { downReason, outOfQuotaUntil } from "../src/agents/capacity.ts";
import { codexErrorReply } from "../src/agents/acp.ts";
import { isRetryableAgentError } from "../src/agents/runner.ts";
import { decide, decisionOrder, resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { testApp } from "./helpers.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  useRelayBase(null);
});
afterEach(() => {
  setRelayFetchForTests(null);
  setRelayWaitForTests(null);
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
});

const body = (o: unknown) => JSON.stringify(o);

describe("provider errors by kind", () => {
  it("reads Volcengine Ark's codes", () => {
    const ark = (status: number, code: string) => classifyError("ark", status, body({ error: { code, message: "x. Request id: 1", type: "T" } })).kind;
    expect(ark(429, "RateLimitExceeded.EndpointRPMExceeded")).toBe("rate");
    expect(ark(429, "ModelAccountTpmRateLimitExceeded")).toBe("rate");
    expect(ark(429, "ServerOverloaded")).toBe("rate");
    expect(ark(429, "RequestBurstTooFast")).toBe("rate");
    expect(ark(429, "ModelAccountTpdRateLimitExceeded")).toBe("daily");
    expect(ark(429, "SetLimitExceeded")).toBe("quota");
    expect(ark(429, "AccountQuotaExceeded")).toBe("quota");
    expect(ark(429, "QuotaExceeded.AgentPlanQuotaExceeded")).toBe("quota");
    expect(ark(403, "AccountOverdueError")).toBe("quota");
    expect(ark(401, "AuthenticationError")).toBe("auth");
    expect(ark(404, "InvalidEndpointOrModel.ModelIDAccessDisabled")).toBe("config");
    expect(ark(404, "ModelNotOpen")).toBe("config");
    expect(ark(500, "InternalServiceError")).toBe("server");
    expect(ark(400, "InputTextSensitiveContentDetected")).toBe("input");
    expect(classifyError("ark", 429, body({ error: { code: "SetLimitExceeded", message: "reached. Request id: 0217x" } }))).toEqual({ kind: "quota", code: "SetLimitExceeded", message: "reached." });
  });

  it("reads OpenAI's, Anthropic's and Cloudflare's, and the usual words for anyone else", () => {
    expect(classifyError("openai", 429, body({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" } })).kind).toBe("quota");
    expect(classifyError("openai", 429, body({ error: { code: "rate_limit_exceeded", message: "Rate limit reached for gpt-6 on tokens per min (TPM)" } })).kind).toBe("rate");
    expect(classifyError("openai", 429, body({ error: { code: "rate_limit_exceeded", message: "Rate limit reached on requests per day (RPD)" } })).kind).toBe("daily");
    expect(classifyError("openai", 401, body({ error: { code: "invalid_api_key", message: "Incorrect API key" } })).kind).toBe("auth");
    expect(classifyError("anthropic", 400, body({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low" } })).kind).toBe("quota");
    expect(classifyError("anthropic", 529, body({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).kind).toBe("rate");
    expect(classifyError("cloudflare", 429, body({ success: false, errors: [{ code: 3036, message: "Account limited: you have used up your daily free allocation of 10,000 neurons" }] })).kind).toBe("daily");
    expect(classifyError("cloudflare", 429, body({ success: false, errors: [{ code: 3040, message: "Capacity temporarily exceeded" }] })).kind).toBe("rate");
    expect(classifyError("openai-compatible", 429, body({ error: { message: "too many requests" } })).kind).toBe("rate");
    expect(classifyError("openai-compatible", 402, "Payment Required").kind).toBe("quota");
    expect(classifyError("openai-compatible", 502, "<html>bad gateway</html>").kind).toBe("server");
  });

  it("sends an agent's side calls for its vendor's model to the key's model", () => {
    const p = { keyModels: ["ep-1", "ep-2"], model: "ep-2" };
    const out = (b: unknown) => JSON.parse(onKeyModels(p, Buffer.from(JSON.stringify(b)))!.toString());
    expect(out({ model: "gpt-5.6-luna", input: "title" })).toEqual({ model: "ep-2", input: "title" });
    expect(out({ model: "ep-1" })).toEqual({ model: "ep-1" });
    expect(onKeyModels({ model: "x" }, Buffer.from('{"model":"gpt"}'))!.toString()).toBe('{"model":"gpt"}');
  });

  it("turns Codex's error replies into failures", () => {
    const busy = codexErrorReply("exceeded retry limit, last status: 429 Too Many Requests\n");
    expect(busy && isRetryableAgentError(busy)).toBe(true);
    expect(codexErrorReply("We’re currently experiencing high demand, which may cause temporary errors.")).toMatchObject({ kind: "rate-limit" });
    expect(codexErrorReply("unexpected status 403 Forbidden: The account is overdue.")).toMatchObject({ kind: "other" });
    expect(codexErrorReply("我查了一下，状态码 429 表示限流。")).toBeNull();
  });
});

describe("the API-key relay", () => {
  it("points the backends at omem and gives them a token instead of the key", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-relay-"));
    useKeyHome(home);
    setKey(home, "ark", "real-ark-key");
    useRelayBase("http://127.0.0.1:4999/");
    try {
      const keyed = keyedProfiles(configSchema.parse({ ai: { providers: [{ id: "ark", kind: "ark", baseUrl: "https://ark.example.com/api/v3", model: "ep-1", backends: ["codex", "claude", "opencode"] }] } }));
      const by = Object.fromEntries(keyed.map((p) => [p.id, p]));
      expect(JSON.parse(by["codex@ark"].env.CODEX_CONFIG).model_providers["omem-key"].base_url).toBe("http://127.0.0.1:4999/api/ai/relay/ark/codex%40ark/openai");
      // Ark's Anthropic-shaped address is known: Claude Code is made without a check.
      expect(by["claude@ark"].env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4999/api/ai/relay/ark/claude%40ark/anthropic");
      expect(JSON.parse(by["opencode@ark"].env.OPENCODE_CONFIG_CONTENT).provider["omem-key"].options.baseURL).toBe("http://127.0.0.1:4999/api/ai/relay/ark/opencode%40ark/openai");
      expect(keyEnv(by["codex@ark"])).toMatchObject({ OMEM_AI_KEY: relayToken("codex@ark") });
      expect(JSON.stringify(keyEnv(by["claude@ark"]))).not.toContain("real-ark-key");
      expect(by["codex@ark"].env.OMEM_AI_BASE_URL).toBeUndefined();
    } finally {
      useRelayBase(null);
    }
  });

  it("passes requests on with the key, waits out short limits, stops runs on spent quota", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-relay-"));
    const b = await boot(home, { port: 0, quiet: true, background: false });
    servers.push(b.server);
    const app = b.app;
    app.config.ai.providers = [{ id: "ark", name: "方舟", kind: "ark", baseUrl: "https://ark.example.com/api/v3", model: "ep-1", backends: ["codex", "claude"] }] as never;
    setKey(app.home, "ark", "real-ark-key");
    const codex = keyedProfiles(app.config).find((p) => p.id === "codex@ark")!;
    const relay = `${app.baseUrl}/api/ai/relay/ark/${encodeURIComponent("codex@ark")}/openai`;
    const call = (token = relayToken("codex@ark"), path = "/responses") =>
      fetch(relay + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body({ model: "ep-1", input: "hi" }) });

    expect((await call("wrong")).status).toBe(401);

    // Streamed through, with the real key and the body as sent.
    const seen: { url: string; auth: string | null; body: string }[] = [];
    let answer: () => Response = () => new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } });
    setRelayFetchForTests((async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: Buffer.from(init.body as Uint8Array).toString() });
      return answer();
    }) as unknown as typeof fetch);
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/event-stream");
    expect(await ok.text()).toBe("data: hello\n\n");
    expect(seen[0]).toEqual({ url: "https://ark.example.com/api/v3/responses", auth: "Bearer real-ark-key", body: body({ model: "ep-1", input: "hi" }) });

    // A per-minute limit: tried again here, then handed on as 429; the key set aside for a minute.
    seen.length = 0;
    const waits: number[] = [];
    setRelayWaitForTests(async (ms) => { waits.push(ms); });
    answer = () => new Response(body({ error: { code: "RateLimitExceeded.EndpointRPMExceeded", message: "rpm" } }), { status: 429 });
    const started = Date.now();
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(seen.length).toBe(4);
    expect(waits).toEqual([2000, 5000, 10000]);
    expect(downReason(app, codex)).toMatch(/限流/);
    expect(relayFailure(app, codex, started)).toMatchObject({ kind: "rate-limit" });

    // Spent quota: once, passed on as 400 (no agent retries it), the key out until checked, the owner told.
    seen.length = 0;
    answer = () => new Response(body({ error: { code: "SetLimitExceeded", message: "limit reached" } }), { status: 429 });
    const spent = await call();
    expect(spent.status).toBe(400);
    expect(spent.headers.get("x-omem-relay-status")).toBe("429");
    expect(seen.length).toBe(1);
    expect(outOfQuotaUntil(app, codex)).toBeTruthy();
    const failure = relayFailure(app, codex, started)!;
    expect(failure).toMatchObject({ kind: "quota" });
    expect(failure.resetAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(app.db.prepare("select title from notifications").all()).toEqual([{ title: "API key「方舟」额度用完或欠费" }]);

    // The API key page says so; a passing check brings it back.
    const view = await (await fetch(`${app.baseUrl}/api/ai`)).json();
    expect(view.providers[0].paused.message).toMatch(/SetLimitExceeded/);
    expect(view.providers[0].relay.counts).toEqual({ rate: 1, quota: 1 });
    setRelayFetchForTests(null);
  });
});

it("keeps a decision model away as long as its error says", async () => {
  const app = testApp();
  try {
    app.config.ai.providers = [{ id: "cf", name: "", kind: "cloudflare", accountId: "0".repeat(32), backends: [] }, { id: "j", name: "", kind: "typesafe", backends: [] }] as never;
    app.config.ai.decision = { provider: "cf", model: "clef-flash", others: [{ provider: "j", model: "jev-latest" }], fallback: "general", gatekeeper: true } as never;
    setKey(app.home, "cf", "k1");
    setKey(app.home, "j", "k2");
    setDecisionFetchForTests((async (url: string) => String(url).includes("cloudflare")
      ? new Response(body({ success: false, errors: [{ code: 3036, message: "daily free allocation used up" }] }), { status: 429 })
      : new Response(body({ answers: { q: { type: "noul", noul: 0.9 } } }))) as unknown as typeof fetch);
    expect((await decide(app, "材料", { type: "yesno", instructions: "要不要看" }))?.by).toMatch(/jev-latest/);
    // Out until the owner's midnight, not the usual five minutes.
    expect(decisionOrder(app).map((s) => s.provider)).toEqual(["j", "cf"]);
    const { relayStats } = await import("../src/core/ai-relay.ts");
    expect(relayStats(app, "cf")?.last).toMatchObject({ kind: "daily", code: "3036" });
  } finally {
    app.db.close();
  }
});
