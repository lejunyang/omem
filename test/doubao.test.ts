import { afterEach, describe, expect, it, vi } from "vitest";
import { one } from "../src/core/db.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { checkDoubaoApp, doubaoAccessToken, readDoubaoTokens, runDoubao, saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { createRun } from "../src/agents/runs.ts";
import { threadTurn } from "../src/agents/sessions.ts";
import { addMessage, createThread, getThread, threadMessages } from "../src/agents/threads.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { testApp } from "./helpers.ts";

const profile = agentProfileSchema.parse({ id: "doubao", transport: "doubao", command: "doubao-openapi", idleTimeoutMs: 5000 });
const botApp = { appId: "cli_bot", secret: "s" };
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ code: 0, msg: "success", data }), { status, headers: { "content-type": "application/json" } });
const stream = (frames: [string, unknown][]) =>
  new Response(new ReadableStream({ start(c) { for (const [e, d] of frames) c.enqueue(new TextEncoder().encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const future = () => new Date(Date.now() + 3600_000).toISOString();

afterEach(() => setDoubaoFetchForTests(null));

function authorizedApp() {
  const app = testApp();
  saveLarkSecret(app.home, { appId: botApp.appId, appSecret: botApp.secret });
  app.config.lark.appId = botApp.appId;
  saveDoubaoToken(app.home, { appId: botApp.appId, accessToken: "u-1", expiresAt: future(), savedAt: "" });
  return app;
}

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
    expect(events).toContainEqual({ type: "session", sessionId: "S1", resumed: false });
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

  it.each(["stream-unavailable", "reply-failed"])("deletes a new OpenAPI session when %s, while keeping resumed sessions", async (failure) => {
    const app = authorizedApp();
    const deleted: string[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        deleted.push(url.split("/v1/sessions/")[1]);
        return ok({});
      }
      if (init?.method === "POST" && url.endsWith("/v1/sessions")) return ok({ id: "S1", messages: [{ id: "Q1" }] });
      if (init?.method === "POST" && url.endsWith("/events")) return ok({ messages: [{ id: "Q1" }] });
      if (url.endsWith("/events/Q1")) {
        if (failure === "stream-unavailable") return new Response("unavailable", { status: 503 });
        return stream([["message.failed", { message: { id: "A1", status: "failed" } }]]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const error = failure === "stream-unavailable" ? /HTTP 503/ : /failed/;
    await expect(runBackend(app, profile, { cwd: app.home, prompt: "临时任务" }, () => {})).rejects.toThrow(error);
    expect(deleted).toEqual(["S1"]);
    await expect(runBackend(app, profile, { cwd: app.home, prompt: "继续", resumeSessionId: "S2" }, () => {})).rejects.toThrow(error);
    await expect(runBackend(app, profile, { cwd: app.home, prompt: "聊天", persistSession: true }, () => {})).rejects.toThrow(error);
    expect(deleted).toEqual(["S1"]);
  });

  it("rebuilds the full first turn when a thread loses its cloud session", async () => {
    const app = authorizedApp();
    app.baseUrl = "http://localhost";
    app.config.agents.profiles = [profile];
    const thread = createThread(app, { channel: "web", spaceId: "personal", settings: { profile: profile.id } });
    const created: string[] = [];
    const resumed: string[] = [];
    const retired: string[] = [];
    setDoubaoFetchForTests(async (url, init) => {
      if (init?.method === "DELETE") {
        retired.push(String(url).split("/").at(-1)!);
        return ok({});
      }
      if (init?.method === "GET" || !init?.method) return stream([["message.completed", {}]]);
      const body = JSON.parse(String(init.body));
      if (body.events) {
        resumed.push(body.events[0].contents[0].text);
        return new Response(null, { status: 404 });
      }
      created.push(body.initial_events[0].contents[0].text);
      return ok({ id: `S${created.length}`, messages: [{ id: "Q1" }] });
    });
    const turn = (text: string) => {
      addMessage(app, thread.id, "user", text);
      const run = createRun(app, { kind: "ask", title: text, input: { conversationId: thread.id } });
      return threadTurn({ app, run, signal: new AbortController().signal, event() {}, output() {} }, thread.id, threadMessages(app, thread.id).slice(-1));
    };
    await turn("样品选蓝色");
    expect(await turn("要两份")).toMatchObject({ mode: "fresh" });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).not.toContain("# 会话背景");
    expect(created).toHaveLength(2);
    for (const part of ["# 会话背景", "样品选蓝色", "要两份"]) expect(created[1]).toContain(part);
    expect(getThread(app, thread.id)).toMatchObject({ agentSession: "S2", agentTurns: 1 });
    await vi.waitFor(() => expect(retired).toEqual(["S1"]));
  });

  it("replaces and keeps a lost session when the caller supplies the full task", async () => {
    const app = authorizedApp();
    const requests: string[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/old/events")) return new Response(null, { status: 404 });
      if (path.endsWith("/v1/sessions")) {
        const first = JSON.parse(String(init?.body)).initial_events[0].contents[0].text;
        expect(first).toBe("角色说明\n\n---\n\n最近的私聊和本轮要求");
        return ok({ id: "new", messages: [{ id: "Q1" }] });
      }
      return stream([["message.completed", {}]]);
    });
    const result = await runBackend(app, profile, {
      cwd: app.home, system: "角色说明", prompt: "最近的私聊和本轮要求", resumeSessionId: "old", persistSession: true,
    }, () => {});
    expect(result.sessionId).toBe("new");
    expect(requests).toEqual(["POST /open-apis/agent/v1/sessions/old/events", "POST /open-apis/agent/v1/sessions", "GET /open-apis/agent/v1/sessions/new/events/Q1"]);
  });

  it.each([true, false])("releases only the replacement of a temporary task (stream succeeds=%s)", async (success) => {
    const app = authorizedApp();
    const deleted: string[] = [];
    setDoubaoFetchForTests(async (url, init) => {
      if (init?.method === "DELETE") { deleted.push(String(url).split("/").at(-1)!); return ok({}); }
      if (String(url).endsWith("/old/events")) return new Response(null, { status: 404 });
      if (String(url).endsWith("/v1/sessions")) {
        expect(JSON.parse(String(init?.body)).initial_events[0].contents[0].text).toBe("角色说明\n\n---\n\n完整任务");
        return ok({ id: "replacement", messages: [{ id: "Q1" }] });
      }
      return success ? stream([["message.completed", {}]]) : new Response(null, { status: 503 });
    });
    const result = runBackend(app, profile, { cwd: app.home, system: "角色说明", prompt: "完整任务", resumeSessionId: "old" }, () => {});
    if (success) expect((await result).sessionId).toBe("replacement");
    else await expect(result).rejects.toThrow(/503/);
    expect(deleted).toEqual(["replacement"]);
  });

  it("cancels the resume POST without starting another request", async () => {
    const app = authorizedApp();
    const cancel = new AbortController();
    const requests: string[] = [];
    let openingSignal: AbortSignal | null | undefined;
    setDoubaoFetchForTests(async (url, init) => {
      requests.push(new URL(String(url)).pathname);
      openingSignal = init?.signal;
      cancel.abort();
      init?.signal?.throwIfAborted();
      throw new Error("opening POST missed cancellation");
    });
    await expect(runBackend(app, profile, { cwd: app.home, prompt: "任务", signal: cancel.signal, resumeSessionId: "old" }, () => {})).rejects.toThrow("CANCELLED");
    expect(requests).toEqual(["/open-apis/agent/v1/sessions/old/events"]);
    expect(openingSignal?.aborted).toBe(true);
  });

  it.each([
    { resumeSessionId: undefined, persistSession: false },
    { resumeSessionId: "old", persistSession: true },
  ])("collects the receipt after cancellation and releases the new session ($resumeSessionId, keep=$persistSession)", async ({ resumeSessionId, persistSession }) => {
    const app = authorizedApp();
    const cancel = new AbortController();
    const events: AgentEvent[] = [];
    const operations: string[] = [];
    let readyAtReceipt: number | undefined;
    setDoubaoFetchForTests(async (input, init) => {
      const path = new URL(String(input)).pathname;
      operations.push(`${init?.method} ${path}`);
      if (path.endsWith("/old/events")) return new Response(null, { status: 404 });
      if (path.endsWith("/v1/sessions")) {
        const { uuid } = JSON.parse(String(init?.body));
        expect(events).toContainEqual({ type: "status", text: `正在创建豆包会话（请求 ${uuid}）` });
        // The server has created the session. Its receipt body is still in flight.
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            cancel.abort();
            await Promise.resolve();
            init?.signal?.throwIfAborted();
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 0, data: { id: "late", messages: [{ id: "Q1" }] } })));
            controller.close();
          },
        });
        return new Response(body);
      }
      if (persistSession && init?.method === "DELETE") return new Response(null, { status: 503 });
      if (path.endsWith("/late/events")) expect(JSON.parse(String(init?.body)).events[0].type).toBe("user.interrupt");
      return ok({});
    });
    await expect(runBackend(app, profile, {
      cwd: app.home, prompt: "任务", signal: cancel.signal, resumeSessionId, persistSession,
    }, e => {
      events.push(e);
      if (e.type === "session") {
        readyAtReceipt = one<{ ready: number }>(app.db, "select ready from session_cleanup where session_id = ?", e.sessionId)?.ready;
      }
    })).rejects.toThrow("CANCELLED");
    expect(readyAtReceipt).toBe(0);
    expect(events).toContainEqual({ type: "session", sessionId: "late", resumed: false });
    expect(operations).toEqual([
      ...(resumeSessionId ? ["POST /open-apis/agent/v1/sessions/old/events"] : []),
      "POST /open-apis/agent/v1/sessions", "POST /open-apis/agent/v1/sessions/late/events", "DELETE /open-apis/agent/v1/sessions/late",
    ]);
    const pending = one(app.db, "select ready, attempts from session_cleanup where session_id = ?", "late");
    if (persistSession) expect(pending).toMatchObject({ ready: 1, attempts: 1 });
    else expect(pending).toBeUndefined();
  });

  it("records the create request when the receipt deadline expires after cancellation", async () => {
    const app = authorizedApp();
    const cancel = new AbortController();
    const deadline = new AbortController();
    const events: AgentEvent[] = [];
    let uuid = "";
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    try {
      setDoubaoFetchForTests(async (_url, init) => {
        uuid = JSON.parse(String(init?.body)).uuid;
        cancel.abort();
        expect(init?.signal?.aborted).toBe(false);
        return new Response(new ReadableStream({
          pull(controller) {
            deadline.abort(new Error("receipt deadline"));
            controller.error(init?.signal?.reason);
          },
        }));
      });
      await expect(runDoubao(profile, { cwd: app.home, prompt: "任务", signal: cancel.signal }, e => events.push(e), { home: app.home, app: botApp })).rejects.toThrow("CANCELLED");
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(events).toContainEqual({ type: "status", text: `取消时未取得豆包会话 ID（创建请求 ${uuid}）：receipt deadline` });
      expect(events.some(e => e.type === "session")).toBe(false);
    } finally {
      timeout.mockRestore();
    }
  });

  it("interrupts and deletes a temporary session cancelled as soon as its id arrives", async () => {
    const app = authorizedApp();
    const cancel = new AbortController();
    const operations: string[] = [];
    setDoubaoFetchForTests(async (url, init) => {
      if (String(url).endsWith("/v1/sessions") && init?.method === "POST") return ok({ id: "new", messages: [{ id: "Q1" }] });
      operations.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      if (init?.method === "POST") expect(JSON.parse(String(init.body)).events[0].type).toBe("user.interrupt");
      return ok({});
    });
    await expect(runBackend(app, profile, { cwd: app.home, prompt: "任务", signal: cancel.signal }, (e) => {
      if (e.type === "session") cancel.abort();
    })).rejects.toThrow("CANCELLED");
    expect(operations).toEqual(["POST /open-apis/agent/v1/sessions/new/events", "DELETE /open-apis/agent/v1/sessions/new"]);
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
