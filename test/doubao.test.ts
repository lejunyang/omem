import { afterEach, describe, expect, it } from "vitest";
import { agentProfileSchema } from "../src/core/config.ts";
import { checkDoubaoApp, doubaoAccessToken, readDoubaoTokens, runDoubao, saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

const profile = agentProfileSchema.parse({ id: "doubao", transport: "doubao", command: "doubao-openapi", idleTimeoutMs: 5000 });
const botApp = { appId: "cli_bot", secret: "s" };
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ code: 0, msg: "success", data }), { status, headers: { "content-type": "application/json" } });
const stream = (frames: [string, unknown][]) =>
  new Response(new ReadableStream({ start(c) { for (const [e, d] of frames) c.enqueue(new TextEncoder().encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const future = () => new Date(Date.now() + 3600_000).toISOString();

afterEach(() => setDoubaoFetchForTests(null));

describe("doubao backend", () => {
  it("creates a session, streams the reply and keeps the session to continue", async () => {
    const app = testApp();
    saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "u-1", expiresAt: future(), savedAt: new Date().toISOString() });
    const calls: { method: string; url: string; body?: any; auth?: string }[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
      if (url.endsWith("/v1/sessions") && init?.method === "POST") return ok({ id: "S1", status: "in_progress", messages: [{ id: "Q1", role: "user", status: "completed" }] }, 201);
      if (url.endsWith("/v1/sessions/S1/events") && init?.method === "POST") return ok({ messages: [{ id: "Q2", role: "user", status: "completed" }] }, 202);
      if (url.endsWith("/v1/sessions/S1/events/Q1") || url.endsWith("/v1/sessions/S1/events/Q2"))
        return stream([
          ["message.in_progress", { message: { id: "A1", role: "assistant", status: "in_progress" } }],
          ["reasoning.start", { id: "r1", type: "reasoning" }],
          ["reasoning.delta", { id: "r1", summary_index: 0, delta: "想一想" }],
          ["text.start", { id: "t1", type: "text" }],
          ["text.delta", { id: "t1", delta: "北京明天" }],
          ["text", { id: "t1", seq: 3, type: "text", text: "北京明天多云。" }],
          ["artifact", { id: "a1", seq: 4, type: "artifact", artifact_type: "document", name: "天气", document: { url: "https://tenant.larkoffice.com/docx/abc" } }],
          ["message.completed", { message: { id: "A1", status: "completed" } }],
        ]);
      throw new Error(`unexpected ${url}`);
    });
    const events: AgentEvent[] = [];
    const r = await runDoubao(profile, { cwd: app.home, prompt: "查天气" }, (e) => events.push(e), { home: app.home, app: botApp });
    expect(r.sessionId).toBe("S1");
    expect(r.text).toBe("北京明天多云。\n\n[天气](https://tenant.larkoffice.com/docx/abc)");
    // The streamed text and the completed item's remainder, never twice.
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("北京明天多云。");
    expect(events.some((e) => e.type === "thought" && e.text === "想一想")).toBe(true);
    expect(calls[0].body.initial_events[0]).toEqual({ type: "user.message", contents: [{ type: "text", text: "查天气" }] });
    expect(calls[0].body.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].auth).toBe("Bearer u-1");

    // A thread continues in the same Doubao session.
    const r2 = await runDoubao(profile, { cwd: app.home, prompt: "那后天呢", resumeSessionId: "S1" }, () => {}, { home: app.home, app: botApp });
    expect(r2.sessionId).toBe("S1");
    expect(calls.some((c) => c.url.endsWith("/v1/sessions/S1/events") && c.body.events[0].contents[0].text === "那后天呢")).toBe(true);
  });

  it("refreshes an expiring token and keeps the old refresh token when none comes back", async () => {
    const app = testApp();
    saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "old", refreshToken: "r-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), savedAt: "" });
    setDoubaoFetchForTests(async (input, init) => {
      expect(String(input)).toContain("/authen/v2/oauth/token");
      expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "r-1", client_id: "cli_bot" });
      return new Response(JSON.stringify({ access_token: "new", expires_in: 7200 }));
    });
    expect(await doubaoAccessToken(app.home, botApp)).toBe("new");
    expect(readDoubaoTokens(app.home).cli_bot.refreshToken).toBe("r-1");
  });

  it("reports which app has the doubao user scopes and whether the saved authorization works", async () => {
    const app = testApp();
    setDoubaoFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "t" }));
      if (url.includes("/application/v6/applications/"))
        return new Response(JSON.stringify({ code: 0, data: { app: { app_name: "小王的助理", scopes: [{ scope: "doubao:session:write", token_types: ["user"] }, { scope: "doubao:session.event:write", token_types: ["user"] }, { scope: "im:message", token_types: ["tenant"] }] } } }));
      if (url.includes("open.doubao.com")) return ok({ sessions: [], has_more: false });
      throw new Error(url);
    });
    const before = await checkDoubaoApp(app.home, botApp);
    expect(before).toMatchObject({ name: "小王的助理", granted: ["doubao:session:write", "doubao:session.event:write"], missing: ["doubao:session.message.stream:read"], authorized: false });
    saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "u", expiresAt: future(), savedAt: "" });
    expect((await checkDoubaoApp(app.home, botApp)).authorized).toBe(true);
  });

  it("says how to authorize when there is no token, and classifies rate limits as retryable", async () => {
    const app = testApp();
    await expect(runDoubao(profile, { cwd: app.home, prompt: "hi" }, () => {}, { home: app.home, app: botApp })).rejects.toThrow(/omem doubao login/);
    saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "u", expiresAt: future(), savedAt: "" });
    setDoubaoFetchForTests(async () => new Response(JSON.stringify({ code: 429001, msg: "rate limited", data: null }), { status: 429 }));
    const err = await runDoubao(profile, { cwd: app.home, prompt: "hi" }, () => {}, { home: app.home, app: botApp }).catch((e) => e);
    const { isRetryableAgentError } = await import("../src/agents/runner.ts");
    expect(isRetryableAgentError(err)).toBe(true);
  });
});
