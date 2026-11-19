import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSkillFile } from "../src/agents/specs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { saveContext } from "../src/channels/listen.ts";
import { all } from "../src/core/db.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { boot } from "../src/main.ts";
import { redactBody, redactUrl } from "../src/remote/redact.ts";
import { getRecording, readRecording } from "../src/remote/recordings.ts";

/**
 * Recordings from the owner's own Chrome (chrome/ 录制 → POST /api/remote/recordings/import): written
 * as aad writes a browser recording, so read_recording, the request grouping and save_skill read them
 * unchanged; then handed to the assistant like a stopped 远程 recording.
 */
describe("recordings imported from the Chrome extension", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-rec-import-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ auth: { enabled: true } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const owner = createApiToken(app, "owner", "chrome");
  createUser(app, { id: "wang", name: "小王" });
  addMember(app, "personal", "wang", "contributor");
  const member = createApiToken(app, "wang", "chrome");
  const post = (body: unknown, token = owner) =>
    fetch(`${app.baseUrl}/api/remote/recordings/import`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  // What the extension sends after the owner granted a merchant refunds in a back office.
  const t = 1_763_600_000_000;
  const page = "https://admin.example.test/merchants?tab=refund#top";
  const recording = {
    goal: "给商户开通退款权限",
    startUrl: page,
    startTitle: "商户后台",
    startedAt: t,
    steps: [
      { at: t + 1000, tab: 7, kind: "action", action: { kind: "click", label: "退款设置", role: "tab", tag: "button", selector: "nav > button:nth-of-type(2)", heading: "商户 B-1001", url: page } },
      { at: t + 2000, tab: 7, kind: "action", action: { kind: "input", label: "商户号", role: "textbox", tag: "input", type: "text", selector: "input#merchant", value: "B-1001", url: page } },
      // The extension found nothing secret about this field; its label says otherwise.
      { at: t + 3000, tab: 7, kind: "action", action: { kind: "input", label: "操作密码", role: "textbox", tag: "input", type: "text", value: "hunter2", url: page } },
      { at: t + 4000, tab: 7, kind: "mark", action: { kind: "mark", label: "可退金额", role: "status", selector: "div.balance", note: "这里看的是还能退多少钱", url: page } },
      { at: t + 5000, tab: 7, kind: "action", action: { kind: "click", label: "开通", role: "button", tag: "button", selector: "button#grant", url: page }, screenshot: "s1" },
      { at: t + 9000, tab: 7, kind: "action", action: { kind: "navigate", url: "https://admin.example.test/merchants/1001", title: "商户详情" } },
    ],
    network: [
      { at: t + 100, tab: 7, method: "GET", url: "https://admin.example.test/static/app.3f2a.js", type: "Script", status: 200, durationMs: 12 },
      { at: t + 1200, tab: 7, method: "GET", url: "https://admin.example.test/api/merchants/1001", type: "XHR", status: 200, responseBody: '{"name":"B-1001","balance":300}', mimeType: "application/json", source: "devtools" },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ at: t + 2100 + n, tab: 7, method: "GET", url: `https://admin.example.test/api/orders?page=${n}`, type: "XHR", status: 200 })),
      { at: t + 5100, tab: 7, method: "OPTIONS", url: "https://admin.example.test/api/refund/grant", type: "Other", status: 204 },
      {
        at: t + 5200, tab: 7, method: "POST", url: "https://admin.example.test/api/refund/grant?access_token=abc-secret-token&merchant=B-1001", type: "XHR", status: 200, durationMs: 85,
        requestHeaders: { Authorization: "Bearer abc-secret-token", "Content-Type": "application/json" },
        requestBody: '{"merchant":"B-1001","csrf_token":"abc-secret-token","amount":300}',
        source: "webRequest",
      },
      ...[1, 2, 3].map((n) => ({ at: t + 5300 + n, tab: 7, method: "POST", url: "https://mon.example.test/monitor_browser/collect", type: "XHR", status: 204, requestBody: '[{"events":[{"event":"click"}]}]' })),
    ],
    images: [{ key: "s1", data: `data:image/png;base64,${png}` }, { key: "unused", data: png }],
  };

  it("keeps it in the layout read_recording reads, with secrets taken out", async () => {
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "商户 B 退款权限", kind: "todo" }, "user");
    const r = await post({ ...recording, itemId: item.id });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { recording: { id: string; dir: string; summary: Record<string, unknown>; target: string; kind: string }; conversationId: string };
    const rec = body.recording;
    expect(rec.kind).toBe("browser");
    expect(rec.target).toBe("https://admin.example.test/merchants?tab=refund");
    expect(rec.summary).toMatchObject({ source: "chrome-extension", actions: 5, marks: 1, requests: 13, screenshots: 1, responseBodies: 1, firstPage: "https://admin.example.test/merchants?tab=refund" });

    // aad's layout: a baseline step 0, then the steps in order, each with its requests.
    const steps = readFileSync(join(rec.dir, "steps.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(steps.map((s) => [s.id, s.kind, s.action.kind ?? null])).toEqual([[0, "baseline", null], [1, "action", "click"], [2, "action", "input"], [3, "action", "input"], [4, "mark", "mark"], [5, "action", "click"], [6, "action", "navigate"]]);
    expect(steps[1].action).toMatchObject({ label: "退款设置", name: "退款设置", control: { role: "tab", name: "退款设置" }, locator: { css: "nav > button:nth-of-type(2)" } });
    expect(steps[3].action).toMatchObject({ protected: true, value: null });
    expect(steps[5].screenshots[0].path).toMatch(/^images\/[0-9a-f]{24}\.png$/);
    expect(existsSync(join(rec.dir, steps[5].screenshots[0].path))).toBe(true);
    expect(steps[5].network.map((n: { method: string }) => n.method)).toEqual(["OPTIONS", "POST", "POST", "POST", "POST"]);
    const evidence = readFileSync(join(rec.dir, "evidence", "network.jsonl"), "utf8");
    expect(evidence).not.toContain("abc-secret-token");
    expect(evidence).not.toContain("hunter2");
    const grant = evidence.trim().split("\n").map((l) => JSON.parse(l)).find((q) => q.request.method === "POST" && q.request.url.includes("refund"));
    expect(grant).toMatchObject({ step_id: 5, type: "XHR", request: { headers: { Authorization: "[REDACTED]", "Content-Type": "application/json" } }, response: { status: 200 }, duration_ms: 85, body_status: "not_captured_without_devtools" });
    expect(grant.request.url).toBe("https://admin.example.test/api/refund/grant?access_token=%5BREDACTED%5D&merchant=B-1001");
    expect(JSON.parse(grant.request.postData)).toEqual({ merchant: "B-1001", csrf_token: "[REDACTED]", amount: 300 });

    // What an agent reads: the steps (no walkthrough here), the owner's mark, the screenshot it can open.
    const summary = readRecording(app, rec.id, "owner", {});
    expect(summary).toMatch(/录制 rec\w+（Chrome 扩展，done）/);
    expect(summary).toMatch(/本人加的标记 1 处，请求 13 个（带响应体的 1 个）/);
    expect(summary).toContain("#1 点击「退款设置」（tab，在「商户 B-1001」下） @ https://admin.example.test/merchants?tab=refund");
    expect(summary).toContain("#3 填写「操作密码」（受保护，内容未记录）");
    expect(summary).toContain("#4 备注（指着「可退金额」）：这里看的是还能退多少钱（status）");
    expect(summary).toContain("#6 打开页面「商户详情」 @ https://admin.example.test/merchants/1001");
    expect(summary).toContain(`截图：${join(rec.dir, steps[5].screenshots[0].path)}`);
    // Requests grouped like aad's: the paged list is not polling (no responses to compare), the rest is noise.
    const apis = readRecording(app, rec.id, "owner", { part: "requests" });
    expect(apis).toMatch(/共 3 个接口[^]*略去[^]*\n1\. POST admin\.example\.test\/api\/refund\/grant → 200（第 5 步）[^]*GET admin\.example\.test\/api\/orders → 200 ×6（第 2 步）/);
    expect(apis).not.toMatch(/collect|app\.3f2a/);
    expect(readRecording(app, rec.id, "owner", { part: "requests", filter: "merchants", bodies: true })).toContain('响应体：{"name":"B-1001","balance":300}');

    // Handed to the assistant: a new conversation, naming the item.
    expect(body.conversationId).toBeTruthy();
    expect(getRecording(app, rec.id).conversationId).toBe(body.conversationId);
    const said = all<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'user'", body.conversationId);
    expect(said[0].text).toMatch(new RegExp(`录制 ${rec.id}，在我自己的 Chrome 里[^]*给商户开通退款权限[^]*5 个动作、1 处我加的标记[^]*13 个请求[^]*事项「商户 B 退款权限」（${item.id}）[^]*skill-from-recording`));

    // And save_skill takes the endpoints from it as from a 远程 recording.
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
    expect((await callTool(ctx, "list_recordings", {})).text).toContain(`${rec.id}（Chrome 扩展`);
    const saved = await callTool(ctx, "save_skill", { name: "grant-refund-chrome", description: "给商户开通退款权限", body: "## 步骤\n…", from_recording: rec.id, recording_requests: ["POST /api/refund/grant"], attach: false });
    expect(saved.isError).toBe(false);
    const kept = readSkillFile(app, "grant-refund-chrome", "recording/requests.md");
    expect(kept).toMatch(/1\. POST admin\.example\.test\/api\/refund\/grant[^]*"csrf_token":"\[REDACTED\]"/);
    expect(kept).not.toContain("abc-secret-token");
  });

  it("puts the organizing message in a 关注's conversation, or only keeps it", async () => {
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "退款改造", kind: "todo" }, "user");
    const context = saveContext(app, { kind: "item", itemId: item.id, name: "退款改造" });
    expect(context.conversationId).toBeTruthy();
    const into = await post({ goal: "看退款单", startUrl: "https://admin.example.test/refunds", steps: [recording.steps[0]], contextId: context.id });
    expect(into.status).toBe(200);
    expect(((await into.json()) as { conversationId: string }).conversationId).toBe(context.conversationId);

    const kept = await post({ goal: "只存着", steps: [recording.steps[0]], organize: false });
    const k = (await kept.json()) as { recording: { id: string }; conversationId: string | null };
    expect(k.conversationId).toBeNull();
    expect(getRecording(app, k.recording.id).conversationId).toBeNull();
    expect((await post({ steps: [], contextId: "ctx-none" })).status).toBe(404);
  });

  it("is the owner's only, and takes only images", async () => {
    expect((await post({ goal: "x", steps: [] }, member)).status).toBe(403);
    const bad = await post({ steps: [{ ...recording.steps[4], screenshot: "s1" }], images: [{ key: "s1", data: Buffer.from("<svg/>").toString("base64") }], organize: false });
    expect(bad.status).toBe(400);
  });

  it("redacts like aad's redact_network, and twice is the same as once", () => {
    const url = "https://u:p@example.test/cb?code=xyz&returnTo=%2Fhome&q=1#frag";
    expect(redactUrl(url)).toBe("https://example.test/cb?code=%5BREDACTED%5D&returnTo=%5BREDACTED%5D&q=1");
    expect(redactUrl(redactUrl(url))).toBe(redactUrl(url));
    // A front-end route stays, without what follows its "?"; an OAuth fragment goes.
    expect(redactUrl("https://a.test/app#/orders/7?access_token=t")).toBe("https://a.test/app#/orders/7");
    expect(redactUrl("https://a.test/login#access_token=t")).toBe("https://a.test/login");
    expect(redactBody('{"user":{"password":"p","name":"小王"},"next":{"url":"https://x.test/?ticket=t"}}')).toBe('{"user":{"password":"[REDACTED]","name":"小王"},"next":{"url":"https://x.test/?ticket=%5BREDACTED%5D"}}');
    expect(redactBody("user=wang&passwd=123")).toBe("user=wang&passwd=[REDACTED]");
    expect(redactBody(redactBody("user=wang&passwd=123"))).toBe("user=wang&passwd=[REDACTED]");
    expect(redactBody("<html>secret page</html>")).toBe("[REDACTED OPAQUE BODY]");
  });
});
