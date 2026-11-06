import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { generateImage, setImageFetchForTests } from "../src/core/images.ts";
import { liveConnect, listVoiceSessions, realtimeSecret, saveVoiceSession, setVoiceFetchForTests, transcribe, voiceTool } from "../src/core/voice.ts";
import { listSkills, skillIndex, skillUsable } from "../src/agents/specs.ts";
import { getRun } from "../src/agents/runs.ts";
import type { App } from "../src/core/app.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});
afterEach(() => {
  setImageFetchForTests(null);
  setVoiceFetchForTests(null);
});

async function appWithOpenAI(): Promise<App> {
  const home = mkdtempSync(join(tmpdir(), "omem-media-"));
  const b = await boot(home, { port: 0, quiet: true, background: false });
  servers.push(b.server);
  b.app.config.ai.providers = [{ id: "o", name: "", kind: "openai", backends: [] }];
  setKey(home, "o", "sk-1");
  return b.app;
}

type Call = { url: string; init: RequestInit };
function fake(answer: (c: Call) => unknown, setter: (f: typeof fetch) => void) {
  const calls: Call[] = [];
  setter((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer({ url, init })), { status: 200 });
  }) as unknown as typeof fetch);
  return calls;
}

describe("image generation", () => {
  it("draws with the Images API and keeps the picture as a stored file", async () => {
    const app = await appWithOpenAI();
    await expect(generateImage(app, { prompt: "流程图" })).rejects.toThrow(/图片生成模型不可用/);
    app.config.ai.image = { provider: "o", model: "", size: "1536x1024", quality: "" };
    const png = Buffer.from("fake-png-bytes");
    const calls = fake(() => ({ data: [{ b64_json: png.toString("base64"), revised_prompt: "a flow chart" }] }), setImageFetchForTests);
    const img = await generateImage(app, { prompt: "退款流程示意图", quality: "low" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: "gpt-image-2.5-flare", prompt: "退款流程示意图", n: 1, size: "1536x1024", quality: "low", output_format: "png" });
    expect(img).toMatchObject({ url: `/api/files/${img.name}`, revisedPrompt: "a flow chart", model: "gpt-image-2.5-flare" });
    expect(readFileSync(img.path)).toEqual(png);
    // Served like any other stored file.
    const r = await fetch(`${app.baseUrl}${img.url}`, { headers: { connection: "close" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(png);
  });

  it("offers the image skill only once an image model is configured", async () => {
    const app = await appWithOpenAI();
    const skill = listSkills(app).find((s) => s.name === "image-generation")!;
    expect(skill.requires).toEqual(["ai:image"]);
    expect(skillUsable(app, skill)).toBe(false);
    expect(skillIndex(app)).not.toContain("image-generation");
    app.config.ai.image.provider = "o";
    expect(skillUsable(app, skill)).toBe(true);
    expect(skillIndex(app)).toContain("image-generation");
  });
});

describe("voice", () => {
  it("mints a Realtime client secret carrying the session, with omem's read tools for a chat", async () => {
    const app = await appWithOpenAI();
    app.config.ai.voice = { ...app.config.ai.voice, provider: "o", api: "realtime" };
    const calls = fake(() => ({ value: "ek_123", expires_at: 1900000000 }), setVoiceFetchForTests);
    const s = await realtimeSecret(app, { purpose: "chat" });
    expect(s).toEqual({ api: "realtime", model: "gpt-realtime-2.1", secret: "ek_123", expiresAt: 1900000000, callsUrl: "https://api.openai.com/v1/realtime/calls" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(body.session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1", audio: { output: { voice: "marin" } }, tool_choice: "auto" });
    expect(body.session.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["search", "read_source", "recall"]));
    expect(body.session.tools[0]).toMatchObject({ type: "function", parameters: { type: "object" } });
    // A practice has no tools, and the scene in its instructions.
    await realtimeSecret(app, { purpose: "practice", scenario: "在餐厅点餐" });
    const p = JSON.parse(String(calls[1].init.body)).session;
    expect(p.tools).toBeUndefined();
    expect(p.instructions).toContain("Scene: 在餐厅点餐");
    await expect(liveConnect(app, { purpose: "chat", sdp: "v=0 offer" })).rejects.toThrow(/Realtime，不是 GPT-Live/);
  });

  it("opens a GPT-Live session for the browser's SDP, delegating tools to a Responses model", async () => {
    const app = await appWithOpenAI();
    app.config.ai.voice = { ...app.config.ai.voice, provider: "o", api: "live", delegateModel: "gpt-6-sol" };
    const calls = fake(() => ({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0 answer" } }), setVoiceFetchForTests);
    expect(await liveConnect(app, { purpose: "chat", sdp: "v=0 offer" })).toEqual({ api: "live", model: "gpt-live-1", sessionId: "live_1", sdp: "v=0 answer" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/live/sessions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0 offer" });
    expect(body.session).toMatchObject({ model: "gpt-live-1", delegation: { type: "responses", responses: { model: "gpt-6-sol", tool_choice: "auto" } } });
    expect(body.session.delegation.responses.tools.some((t: { name: string }) => t.name === "search")).toBe(true);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-1");
  });

  it("transcribes a recording for the input box", async () => {
    const app = await appWithOpenAI();
    app.config.ai.voice = { ...app.config.ai.voice, provider: "o" };
    const calls = fake(() => ({ text: " 明天的评审几点 " }), setVoiceFetchForTests);
    expect(await transcribe(app, Buffer.from("webm"), "audio/webm;codecs=opus")).toBe("明天的评审几点");
    const form = calls[0].init.body as FormData;
    expect(calls[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(form.get("model")).toBe("gpt-transcribe");
    expect((form.get("file") as File).name).toBe("speech.webm");
  });

  it("runs only read tools for the voice model", async () => {
    const app = await appWithOpenAI();
    expect(await voiceTool(app, "owner", "personal", "remember", {})).toMatchObject({ isError: true, text: expect.stringMatching(/不能用工具 remember/) });
    const r = await voiceTool(app, "owner", "personal", "list_spaces", {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain("personal");
  });

  it("keeps a practice and queues its review by the speaking coach", async () => {
    const app = await appWithOpenAI();
    const chat = await saveVoiceSession(app, "owner", { purpose: "chat", api: "realtime", model: "m", startedAt: new Date().toISOString(), spaceId: "personal", transcript: [{ role: "user", text: "hi" }] });
    expect(chat.reviewRunId).toBeNull();
    const t0 = new Date(Date.now() - 5 * 60_000).toISOString();
    const p = await saveVoiceSession(app, "owner", {
      purpose: "practice",
      scenario: "在餐厅点餐",
      api: "live",
      model: "gpt-live-1",
      startedAt: t0,
      spaceId: "personal",
      transcript: [{ role: "assistant", text: "Hi, ready to order?" }, { role: "user", text: "I want a coffee with no ice." }, { role: "user", text: "  " }],
    });
    expect(p.reviewRunId).toBeTruthy();
    const run = getRun(app, p.reviewRunId!);
    expect(run).toMatchObject({ kind: "speaking-review", title: "口语练习评价：在餐厅点餐" });
    const list = listVoiceSessions(app, "owner", "practice");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ scenario: "在餐厅点餐", reviewRunId: p.reviewRunId, transcript: [{ role: "assistant" }, { role: "user", text: "I want a coffee with no ice." }] });
    expect(listVoiceSessions(app, "someone-else")).toEqual([]);
    expect(existsSync(join(app.home, "secrets", "ai-keys.json"))).toBe(true);
  });
});
