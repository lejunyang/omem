import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSkill, readSkillFile } from "../src/agents/specs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import type { App } from "../src/core/app.ts";
import { setToolResolverForTests } from "../src/core/tools.ts";
import { organizeText } from "../src/remote/http.ts";
import { getRecording, readRecording } from "../src/remote/recordings.ts";
import { profileDir } from "../src/remote/sessions.ts";
import { startServer } from "../src/server/http.ts";
import { WebSocketServer } from "ws";
import { testApp } from "./helpers.ts";

// Remote operation (docs/v2/remote.md) against a fake aad (test/fake-aad.ts): the page's API, the
// forwarded viewer and its WebSocket, recordings and the tools that read them.
const fake = join(import.meta.dirname, "fake-aad.ts");
const DEFAULT_VIEWER = ["--codecs", "auto", "--quality", "70", "--max-width", "1600"];

describe("remote operation", () => {
  let app: App;
  let server: Awaited<ReturnType<typeof startServer>>;
  let log: string;
  let browser: { id: string; src: string };
  beforeAll(async () => {
    log = join(mkdtempSync(join(tmpdir(), "fake-aad-log-")), "calls.jsonl");
    process.env.FAKE_AAD_LOG = log;
    setToolResolverForTests((name) => (name === "aad" ? [process.execPath, fake] : null));
    app = testApp();
    server = await startServer(app, { port: 0, quiet: true });
  });
  afterAll(async () => {
    await server.close();
    setToolResolverForTests(null);
    delete process.env.FAKE_AAD_LOG;
    delete process.env.FAKE_AAD_NO_CHROME;
    delete process.env.FAKE_AAD_CLOSE_MS;
    delete process.env.FAKE_AAD_START_ERROR;
    delete process.env.FAKE_AAD_TRUNCATED;
    delete process.env.FAKE_AAD_CDP_PORT;
  });
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(app.baseUrl + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, body: json, headers: r.headers };
  };
  const calls = (): unknown[][] => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const socket = (path: string) =>
    new Promise<string>((ok, fail) => {
      const ws = new WebSocket(app.baseUrl.replace(/^http/, "ws") + path);
      ws.onmessage = (e) => (ok(String(e.data)), setTimeout(() => ws.close(), 300));
      ws.onerror = () => fail(new Error("socket failed"));
    });

  it("is offered with aad, opens a browser page and forwards its viewer and socket", async () => {
    const status = await api("GET", "/api/remote");
    expect(status.body).toMatchObject({ available: true, version: "0.0.5", sessions: [] });

    const opened = await api("POST", "/api/remote/sessions", { kind: "browser", url: "https://example.test/admin", profile: "后台" });
    expect(opened.status).toBe(200);
    browser = opened.body;
    expect(browser.src).toMatch(/^\/remote\/rs\w+\/\?token=\w+&lang=zh$/);
    expect(opened.body.browser).toMatchObject({ name: "chrome", url: "https://example.test/admin", profile: "后台" });
    expect(opened.headers.get("set-cookie")).toMatch(/^omem_remote=\w+; Path=\/remote; HttpOnly/);
    const open = calls().find((c) => c[0] === "mcp" && c[2] === "browser_open")!;
    expect(open[3]).toMatchObject({ browser: "chrome", headless: true, url: "https://example.test/admin", profile_dir: join(app.home, "remote", "profiles", "后台") });
    // The picture as the default settings have it (no video check made yet: aad picks).
    expect(calls()).toContainEqual(["assist", "--browser-port", "9333", "--page", "PAGE1", ...DEFAULT_VIEWER]);

    // The viewer page and its socket, through /remote/<id>/.
    const page = await api("GET", browser.src);
    expect(page.status).toBe(200);
    expect(page.body).toContain("path=/");
    const token = browser.src.split("token=")[1].split("&")[0];
    const bare = await api("GET", `/remote/${browser.id}?token=${token}`);
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe(`/remote/${browser.id}/?token=${token}`);
    const said = socket(`/remote/${browser.id}/ws?token=${token}`);
    expect(await said).toBe(`ready assist --browser-port 9333 --page PAGE1 ${DEFAULT_VIEWER.join(" ")}`);
    expect((await api("GET", "/api/remote")).body.sessions[0].viewers).toBe(1);
    expect((await api("GET", `/remote/${browser.id}/?token=wrong`)).status).toBe(403);

    // No Chrome on this machine: the next browser it knows.
    process.env.FAKE_AAD_NO_CHROME = "1";
    const edge = await api("POST", "/api/remote/sessions", { kind: "browser" });
    delete process.env.FAKE_AAD_NO_CHROME;
    expect(edge.body.browser.name).toBe("edge");
    expect((await api("DELETE", `/api/remote/sessions/${edge.body.id}`)).status).toBe(200);
  });

  it("keeps each person's long-lived browser profiles apart", () => {
    expect(profileDir(app, "工作")).toBe(join(app.home, "remote", "profiles", "工作"));
    expect(profileDir(app, "工作", "wang")).toBe(join(app.home, "remote", "profiles", "@wang", "工作"));
    expect(() => profileDir(app, "../x", "wang")).toThrow();
  });

  it("lets only whoever opened the session see it", async () => {
    app.config.token = "secret";
    try {
      expect((await api("GET", browser.src)).status).toBe(401);
      expect((await api("POST", `/api/remote/sessions/${browser.id}/view`)).status).toBe(401);
      const view = await api("POST", `/api/remote/sessions/${browser.id}/view`, {}, { authorization: "Bearer secret" });
      const cookie = view.headers.get("set-cookie")!.split(";")[0];
      expect((await api("GET", browser.src, undefined, { cookie })).status).toBe(200);
      // The cookie goes along with another site's socket too: refused by its Origin.
      const status = await new Promise<number>((ok) => {
        const u = new URL(app.baseUrl + `/remote/${browser.id}/ws?${browser.src.split("?")[1]}`);
        const r = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", cookie, origin: "http://evil.test" } });
        r.on("response", (res) => ok(res.statusCode ?? 0));
        r.on("upgrade", () => ok(101));
        r.end();
      });
      expect(status).toBe(401);
    } finally {
      app.config.token = undefined;
    }
  });

  it("records a browser task, keeps what an agent needs and makes a skill of it", async () => {
    const started = await api("POST", `/api/remote/sessions/${browser.id}/recording`, { goal: "给商户开通退款权限" });
    expect(started.body).toMatchObject({ kind: "browser", status: "recording", goal: "给商户开通退款权限", target: "https://example.test/admin" });
    const start = calls().find((c) => c[0] === "mcp" && c[2] === "browser_record_start")!;
    expect(start[3]).toMatchObject({ page_id: "PAGE1", record: { redact_network: true } });
    expect((await api("POST", `/api/remote/sessions/${browser.id}/recording`, { goal: "again" })).status).toBe(409);

    const stopped = await api("DELETE", `/api/remote/sessions/${browser.id}/recording?organize=0`);
    const r = stopped.body.recording;
    expect(r.status).toBe("done");
    expect(r.summary).toEqual({ actions: 2, replayable: 2, skipped: 0, requests: 12, screenshots: 1, workflow: true, firstPage: "https://example.test/admin" });
    for (const f of ["steps.jsonl", "walkthrough.md", "record.json", "workflow.yaml", join("evidence", "network.jsonl")]) expect(existsSync(join(r.dir, f))).toBe(true);
    expect(calls()).toContainEqual(["browser-record", "steps", "--out", r.dir, "--save", `omem-${r.id}`, "--overwrite"]);
    expect(organizeText(getRecording(app, r.id))).toMatch(new RegExp(`录制 ${r.id}.*给商户开通退款权限[^]*2 个动作[^]*12 个请求[^]*skill-from-recording`));

    // What an agent reads: the walkthrough, steps with their requests, request bodies (already redacted).
    expect(readRecording(app, r.id, "owner", {})).toMatch(/要做的事：给商户开通退款权限[^]*填写「商户号」/);
    const steps = readRecording(app, r.id, "owner", { part: "steps" });
    expect(steps).toContain("#1 填写「商户号」：B-1001（textbox） @ https://example.test/admin");
    expect(steps).toContain("请求：POST https://example.test/api/refund/grant → 200");
    const requests = readRecording(app, r.id, "owner", { part: "requests", filter: "refund", bodies: true });
    expect(requests).toMatch(/POST example\.test\/api\/refund\/grant → 200（第 2 步） \[req-7\][^]*"merchant":"B-1001","token":"\[REDACTED\]"[^]*\{"ok":true\}/);
    // Noise set aside: telemetry, the preflight, the script, the polling; one line per endpoint, writes first.
    const apis = readRecording(app, r.id, "owner", { part: "requests" });
    expect(apis).toMatch(/共 2 个接口[^]*略去[^]*埋点 3 个[^]*\n1\. POST example\.test\/api\/refund\/grant[^]*\n2\. GET example\.test\/api\/merchants\/:id → 200（第 1 步）/);
    expect(apis).not.toMatch(/collect|qr\/check|app\.3f2a/);
    const everything = readRecording(app, r.id, "owner", { part: "requests", noise: true });
    expect(everything).toMatch(/monitor_browser\/collect → 204 ×3（不在哪一步里） \[埋点\]/);
    expect(everything).toMatch(/GET example\.test\/api\/qr\/check → 200 ×5[^\n]*\[轮询\]/);
    expect(everything).toMatch(/OPTIONS [^\n]*\[预检\]/);
    expect(everything).toMatch(/app\.3f2a\.js[^\n]*\[静态资源\]/);
    expect(readRecording(app, r.id, "owner", {})).toMatch(/## 调用的接口（2 个；略去[^]*- POST example\.test\/api\/refund\/grant（第 2 步）/);
    expect(readRecording(app, r.id, "owner", { part: "requests", filter: "nothing" })).toMatch(/没有/);
    expect(() => readRecording(app, r.id, "someone-else", {})).toThrow(/没有录制/);

    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
    const listed = await callTool(ctx, "list_recordings", {});
    expect(listed.text).toContain(`${r.id}（浏览器`);
    const saved = await callTool(ctx, "save_skill", { name: "grant-refund", description: "给商户开通退款权限", body: "## 步骤\n…", from_recording: r.id, attach: false });
    expect(saved.isError).toBe(false);
    const skill = readSkill(app, "grant-refund");
    // Only the endpoints go with the skill; the replay steps and aad's walkthrough of every detour stay with the recording.
    expect(skill.files).toEqual(["recording/requests.md"]);
    const kept = readSkillFile(app, "grant-refund", "recording/requests.md");
    expect(kept).toMatch(/去掉了静态资源 1 个、埋点 3 个、预检 1 个、轮询 5 个，[^]*1\. POST example\.test\/api\/refund\/grant[^]*"merchant":"B-1001"[^]*2\. GET example\.test\/api\/merchants\/:id/);
    expect(kept).not.toMatch(/collect|qr\/check/);
    expect(getRecording(app, r.id).skill).toBe("grant-refund");
    // The agent picks the endpoints the task used.
    const second = await callTool(ctx, "save_skill", { name: "grant-refund-picked", description: "给商户开通退款权限", body: "## 步骤\n…", from_recording: r.id, recording_requests: ["POST /api/refund/grant"], attach: false });
    expect(second.isError).toBe(false);
    const picked = readSkillFile(app, "grant-refund-picked", "recording/requests.md");
    expect(picked).toMatch(/挑出的接口[^]*1\. POST example\.test\/api\/refund\/grant/);
    expect(picked).not.toContain("merchants");

  });

  it("shares the desktop and records one window until stopped", async () => {
    const screens = await api("GET", "/api/remote/screens");
    expect(screens.body.windows.map((w: { title: string }) => w.title)).toEqual(["记事本"]);
    expect(screens.body.recordable).toEqual([{ resourceId: "desktop.fake:notepad", name: "记事本", process: "notepad.exe" }]);
    const desk = (await api("POST", "/api/remote/sessions", { kind: "desktop", monitor: 0 })).body;
    expect(desk.title).toBe("显示器 1");
    expect(calls()).toContainEqual(["assist", "--desktop", "--monitor", "0", ...DEFAULT_VIEWER]);

    expect((await api("POST", `/api/remote/sessions/${desk.id}/recording`, { goal: "保存笔记" })).status).toBe(400);
    const started = (await api("POST", `/api/remote/sessions/${desk.id}/recording`, { goal: "保存笔记", window: "desktop.fake:notepad" })).body;
    expect(calls()).toContainEqual(["record", "desktop.fake:notepad", "--until-stdin-closes", "--save", `omem-${started.id}`, "--overwrite"]);
    const r = (await api("DELETE", `/api/remote/sessions/${desk.id}/recording?organize=0`)).body.recording;
    expect(r).toMatchObject({ status: "done", target: "desktop.fake:notepad", summary: { replayable: 1, skipped: 1, workflow: true } });
    expect(readRecording(app, r.id, "owner", {})).toMatch(/#1 \{"type":"click"\} → button「保存」 @ notepad\.exe[^]*无法识别操作的元素/);


    expect((await api("DELETE", `/api/remote/sessions/${desk.id}`)).status).toBe(200);

    // Sharing one window, a recording watches that window without being told.
    const one = (await api("POST", "/api/remote/sessions", { kind: "desktop", window: "0x1", title: "记事本" })).body;
    expect(one).toMatchObject({ title: "记事本", window: "0x1" });
    const watched = (await api("POST", `/api/remote/sessions/${one.id}/recording`, { goal: "保存笔记" })).body;
    expect(calls()).toContainEqual(["record", "desktop.fake:notepad", "--until-stdin-closes", "--save", `omem-${watched.id}`, "--overwrite"]);
    expect((await api("DELETE", `/api/remote/sessions/${one.id}`)).status).toBe(200);
  });

  it("takes the page to an address, through DevTools when aad's capture of the page is truncated", async () => {
    const small = (await api("POST", "/api/remote/sessions", { kind: "browser" })).body;
    expect((await api("POST", `/api/remote/sessions/${small.id}/navigate`, { url: "https://example.test/a" })).status).toBe(200);
    expect(calls()).toContainEqual(["mcp", "tools/call", "control_act", { target: { node_id: "doc" }, action: { type: "navigate", url: "https://example.test/a" } }]);
    expect((await api("DELETE", `/api/remote/sessions/${small.id}`)).status).toBe(200);

    // A browser's DevTools endpoint: the page list and one page's socket.
    const sent: unknown[] = [];
    const http = createServer((req, res) => {
      const port = (http.address() as { port: number }).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "OTHER", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/other` }, { id: "PAGE1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE1` }]));
    });
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (ws, req) => {
      expect(req.url).toBe("/devtools/page/PAGE1");
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        sent.push({ method: m.method, params: m.params });
        ws.send(JSON.stringify({ id: m.id, result: {} }));
        if (m.method === "Page.navigate") setTimeout(() => ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} })), 20);
      });
    });
    await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
    process.env.FAKE_AAD_CDP_PORT = String((http.address() as { port: number }).port);
    process.env.FAKE_AAD_TRUNCATED = "1";
    try {
      const big = (await api("POST", "/api/remote/sessions", { kind: "browser" })).body;
      const went = await api("POST", `/api/remote/sessions/${big.id}/navigate`, { url: "https://example.test/b" });
      expect(went.status).toBe(200);
      expect(went.body.browser.url).toBe("https://example.test/b");
      expect(sent).toContainEqual({ method: "Page.navigate", params: { url: "https://example.test/b" } });
      expect(calls()).not.toContainEqual(expect.arrayContaining([{ target: { node_id: "doc" }, action: { type: "navigate", url: "https://example.test/b" } }]));
      expect((await api("DELETE", `/api/remote/sessions/${big.id}`)).status).toBe(200);
    } finally {
      delete process.env.FAKE_AAD_TRUNCATED;
      delete process.env.FAKE_AAD_CDP_PORT;
      wss.close();
      http.close();
    }
  });

  it("starts a browser from a copy of one of this machine's browser profiles", async () => {
    expect((await api("GET", "/api/remote/browser-profiles")).body).toEqual([{ browser: "edge", id: "Default", name: "工作" }]);
    // The browser using it is open: said so, and nothing is closed unasked.
    const refused = await api("POST", "/api/remote/sessions", { kind: "browser", copyFrom: { browser: "edge", id: "Default" } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Edge 正开着这份资料/);
    expect(refused.body.error).toContain("PID 1234");
    const s = (await api("POST", "/api/remote/sessions", { kind: "browser", copyFrom: { browser: "edge", id: "Default" }, closeRunning: true })).body;
    expect(s.browser).toMatchObject({ name: "edge", profile: "Edge · Default" });
    const open = calls().filter((c) => c[2] === "browser_open").at(-1)!;
    expect(open[3]).toMatchObject({ browser: "edge", copy_profile: "Default", close_running: true });
    expect(open[3]).not.toHaveProperty("profile_dir");
    expect(calls()).toContainEqual(["mcp", "--allow-input", "--allow-profile-copy"]);
    expect((await api("DELETE", `/api/remote/sessions/${s.id}`)).status).toBe(200);
  });

  it("waits for aad to release a persistent profile before closing, so it can be reopened", async () => {
    process.env.FAKE_AAD_CLOSE_MS = "3200";
    const opened = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "reusable", visible: true });
    delete process.env.FAKE_AAD_CLOSE_MS;
    expect(opened.status).toBe(200);
    const lock = join(app.home, "remote", "profiles", "reusable", ".aad-recording.lock");
    expect(existsSync(lock)).toBe(true);
    expect(calls().filter((c) => c[2] === "browser_open").at(-1)![3]).toMatchObject({ headless: false });
    expect((await api("DELETE", `/api/remote/sessions/${opened.body.id}`)).status).toBe(200);
    expect(existsSync(lock)).toBe(false);
    const reopened = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "reusable" });
    expect(reopened.status).toBe(200);
    expect((await api("DELETE", `/api/remote/sessions/${reopened.body.id}`)).status).toBe(200);
  }, 10_000);

  it("closes the existing session for a persistent profile and passes close_running", async () => {
    const first = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "replaceable" });
    expect(first.status).toBe(200);
    const next = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "replaceable", closeRunning: true });
    expect(next.status).toBe(200);
    expect(calls().filter((c) => c[2] === "browser_open").at(-1)![3]).toMatchObject({ close_running: true });
    expect((await api("GET", "/api/remote")).body.sessions.some((s: { id: string }) => s.id === first.body.id)).toBe(false);
    expect((await api("DELETE", `/api/remote/sessions/${next.body.id}`)).status).toBe(200);
  });

  it("preserves the startup failure instead of trying other browsers on the same profile", async () => {
    const before = calls().filter((c) => c[2] === "browser_open").length;
    process.env.FAKE_AAD_START_ERROR = "browser exited before CDP startup: Missing X server";
    let result;
    try {
      result = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "failed" });
    } finally {
      delete process.env.FAKE_AAD_START_ERROR;
    }
    expect(result.status).toBe(502);
    expect(result.body.error).toContain("Missing X server");
    expect(calls().filter((c) => c[2] === "browser_open")).toHaveLength(before + 1);
  });

  it.runIf(process.platform === "linux")("rejects window mode without a display before closing an existing profile", async () => {
    const opened = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "no-display" });
    expect(opened.status).toBe(200);
    const display = process.env.DISPLAY;
    let refused;
    try {
      delete process.env.DISPLAY;
      expect((await api("GET", "/api/remote")).body.windowAvailable).toBe(false);
      refused = await api("POST", "/api/remote/sessions", { kind: "browser", profile: "no-display", closeRunning: true, visible: true });
    } finally {
      if (display === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = display;
    }
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("X11");
    expect((await api("GET", "/api/remote")).body.sessions.some((s: { id: string }) => s.id === opened.body.id)).toBe(true);
    expect((await api("DELETE", `/api/remote/sessions/${opened.body.id}`)).status).toBe(200);
  });

  it("sends the picture as each user set it, and gives an open session a viewer with new settings", async () => {
    expect((await api("GET", "/api/remote/settings")).body).toMatchObject({ settings: { format: "auto", quality: 70, fps: 0, maxWidth: 1600, cursor: true, clipboard: true, browser: "" }, video: null });
    // Which video codecs work here: checked once, kept until aad changes.
    expect((await api("POST", "/api/remote/settings/probe")).body).toMatchObject({ aad: "0.0.5", encoders: { h264: "libx264" } });
    expect((await api("GET", "/api/remote/settings")).body.video.encoders).toEqual({ h264: "libx264" });
    expect((await api("PUT", "/api/remote/settings", { quality: 101 })).status).toBe(400);
    expect((await api("PUT", "/api/remote/settings", { format: "h264", quality: 85, fps: 15, maxWidth: 0, clipboard: false, cursor: false })).body).toMatchObject({ format: "h264", quality: 85, browser: "" });

    // The open browser session gets a new viewer; the session (and its page) carry on.
    const old = browser;
    const restarted = (await api("POST", `/api/remote/sessions/${browser.id}/viewer`)).body;
    expect(restarted.id).toBe(old.id);
    expect(restarted.src).not.toBe(old.src);
    browser = restarted;
    const args = ["--browser-port", "9333", "--page", "PAGE1", "--codecs", "h264,webp,jpeg", "--quality", "85", "--max-width", "0", "--encoder", "libx264", "--fps", "15", "--no-clipboard"];
    expect(calls()).toContainEqual(["assist", ...args]);
    expect(await socket(`/remote/${browser.id}/ws?${browser.src.split("?")[1]}`)).toBe(`ready assist ${args.join(" ")}`);
    expect((await api("GET", old.src)).status).toBe(403);
    expect((await api("GET", "/api/remote")).body.sessions.map((s: { id: string }) => s.id)).toEqual([browser.id]);

    // A desktop gets the pointer setting too; a video codec this machine cannot encode falls back to auto.
    await api("PUT", "/api/remote/settings", { format: "av1" });
    const desk = (await api("POST", "/api/remote/sessions", { kind: "desktop" })).body;
    expect(calls()).toContainEqual(["assist", "--desktop", "--codecs", "webp,jpeg,tiles,h264", "--quality", "85", "--max-width", "0", "--encoder", "libx264", "--fps", "15", "--no-clipboard", "--hide-cursor"]);
    expect((await api("DELETE", `/api/remote/sessions/${desk.id}`)).status).toBe(200);
  });

  it("ends a session: its viewer is gone", async () => {
    expect((await api("DELETE", `/api/remote/sessions/${browser.id}`)).status).toBe(200);
    expect((await api("GET", browser.src)).status).toBe(404);
    expect((await api("GET", "/api/remote")).body.sessions).toEqual([]);
    expect((await api("GET", "/api/remote/recordings")).body).toHaveLength(3);
  });
});
