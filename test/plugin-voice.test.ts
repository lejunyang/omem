import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { roleNames } from "../src/core/config.ts";
import { one, run } from "../src/core/db.ts";
import { setVoiceFetchForTests } from "../src/core/voice.ts";
import { createSession, sessionView, submitBlock } from "../src/plugins/blocks.ts";
import { getPlugin, loadPlugins } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import { snapshot } from "../plugins/english/learner.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/**
 * Speaking practice inside the English plugin (docs/v2/plugins.md “语音”): omem gives a plugin that
 * declares `voice: true` a voice session with the plugin's instructions and no tools; the plugin
 * keeps the practice as a block, and its tutor assesses the transcript.
 */
afterEach(() => setVoiceFetchForTests(null));

async function appWithPlugins() {
  const app = testApp();
  // A data-directory plugin with a page but no voice declared.
  const dir = join(app.home, "plugins", "quiet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: quiet\nname: 安静\n");
  await loadPlugins(app);
  return app;
}

function withVoice(app: ReturnType<typeof testApp>) {
  app.config.ai.providers = [{ id: "o", name: "", kind: "openai", backends: [] }];
  setKey(app.home, "o", "sk-1");
  app.config.ai.voice = { ...app.config.ai.voice, provider: "o", api: "realtime" };
  const calls: { url: string; body: any }[] = [];
  setVoiceFetchForTests((async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ value: "ek_plugin", expires_at: 1900000000 }), { status: 200 });
  }) as unknown as typeof fetch);
  return calls;
}

describe("voice for plugin pages", () => {
  it("only a plugin that declares voice gets a session, with its instructions and none of omem's tools; without a voice model it says where to set one up", async () => {
    const app = await appWithPlugins();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      // No voice model yet: the page is told why, it does not fail.
      const before = (await server.inject({ url: "/api/plugins/english/voice" })).json();
      expect(before).toMatchObject({ allowed: true, ready: false });
      expect(before.detail).toBeTruthy();
      const refused = await server.inject({ method: "POST", url: "/api/plugins/english/voice/realtime/secret", payload: { instructions: "Play a waiter." } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/设置 → AI → 语音/);

      const calls = withVoice(app);
      expect((await server.inject({ url: "/api/plugins/english/voice" })).json()).toMatchObject({ allowed: true, ready: true, api: "realtime" });
      const s = await server.inject({ method: "POST", url: "/api/plugins/english/voice/realtime/secret", payload: { instructions: "Play a waiter." } });
      expect(s.json()).toMatchObject({ api: "realtime", secret: "ek_plugin" });
      expect(calls[0].body.session.instructions).toBe("Play a waiter.");
      expect(calls[0].body.session.tools).toBeUndefined();
      // Wrong API for the configured model, empty or oversized instructions.
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/voice/live/sdp", payload: { instructions: "x", sdp: "v=0 offer sdp" } })).statusCode).toBe(409);
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/voice/realtime/secret", payload: { instructions: " " } })).statusCode).toBe(400);
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/voice/realtime/secret", payload: { instructions: "x".repeat(6001) } })).statusCode).toBe(400);

      // A plugin that did not declare voice gets nothing.
      expect((await server.inject({ url: "/api/plugins/quiet/voice" })).json()).toMatchObject({ allowed: false, ready: false });
      expect((await server.inject({ method: "POST", url: "/api/plugins/quiet/voice/realtime/secret", payload: { instructions: "Play a waiter." } })).statusCode).toBe(403);
      expect(calls).toHaveLength(1);
      expect((await server.inject({ url: "/api/plugins" })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "english", voice: true }), expect.objectContaining({ id: "quiet", voice: false })]));

      // The assistant's own voice conversation still has the read tools.
      await server.inject({ method: "POST", url: "/api/voice/realtime/secret", payload: {} });
      expect(calls[1].body.session.tools.map((t: { name: string }) => t.name)).toContain("search");
    } finally {
      await server.close();
    }
  });

  it("a speaking practice: put in the session, briefed at the learner's level, handed in as a transcript, assessed by the tutor into the profile", async () => {
    const app = await appWithPlugins();
    const env = getPlugin("english").env;
    const { id: sessionId } = await createSession(app, { plugin: "english", agent: "english-tutor", spaceId: "english", userId: "owner", title: "口语 · 在餐厅点餐 · 2026/11/11" });
    const page = (tool: string, args: unknown) => callTool({ app, runId: null, spaceId: "english", spaces: null, tools: new Set([tool]), actor: "user", userId: "owner", plugin: "english" }, tool, args);

    const started = await page("english_speaking_start", { session_id: sessionId, scene: "在餐厅点餐", goal: "用 Could I… 点餐" });
    const { blockId } = JSON.parse(started.text) as { blockId: string };
    const view = sessionView(app, env, sessionId, "owner");
    expect(view.blocks).toEqual([expect.objectContaining({ id: blockId, kind: "speaking", status: "open", data: { scene: "在餐厅点餐", goal: "用 Could I… 点餐" } })]);

    // Some weak words from earlier questions go into the brief; the accent follows the settings.
    const store = pluginStore(app, "english", "owner", "english");
    store.put("points", "phrase:to-go", { seen: 2, correct: 0, streak: 0, lastScore: 0, lastCorrect: false, lastAt: new Date().toISOString(), errors: {} });
    const brief = JSON.parse((await page("english_speaking_brief", { block_id: blockId })).text) as { instructions: string };
    expect(brief.instructions).toContain("Scene: 在餐厅点餐");
    expect(brief.instructions).toContain("Could I");
    expect(brief.instructions).toContain("to go");
    expect(brief.instructions).toContain("American English");

    // Nothing said: not handed in, the block stays open for another try.
    await expect(submitBlock(app, env, { blockId, userId: "owner", answers: { transcript: [{ role: "assistant", text: "Hi! Ready to order?" }], startedAt: "2026-11-11T10:00:00.000Z", endedAt: "2026-11-11T10:01:00.000Z" } })).rejects.toThrow(/还没有说话/);
    expect(sessionView(app, env, sessionId, "owner").blocks[0].status).toBe("open");

    const transcript = [
      { role: "assistant", text: "Hi! Ready to order?" },
      { role: "user", text: "I want a coffee, no ice." },
      { role: "user", text: "少冰怎么说" },
      { role: "assistant", text: "少冰 is “light ice”. So, light ice?" },
    ];
    const r = await submitBlock(app, env, { blockId, userId: "owner", answers: { transcript, startedAt: "2026-11-11T10:00:00.000Z", endedAt: "2026-11-11T10:04:00.000Z", model: "gpt-realtime-2.1" } });
    expect(r.result).toMatchObject({ scene: "在餐厅点餐", minutes: 4, assessment: null });
    expect(r.runId).toBeTruthy();
    const msg = one<{ text: string; meta: string }>(app.db, "select text, meta from messages where conversation_id = ? and role = 'user' order by created_at desc limit 1", sessionId)!;
    expect(JSON.parse(msg.meta)).toMatchObject({ submission: blockId });
    expect(msg.text).toMatch(/^【口语练习】在餐厅点餐，约 4 分钟，学习者说了 2 段/);
    expect(msg.text).toContain("learner: I want a coffee, no ice.");
    expect(msg.text).toContain(`english_speaking_grade(block_id="${blockId}")`);
    expect(store.get("speaking", blockId)).toMatchObject({ scene: "在餐厅点餐", assessment: null });

    // The tutor grades it: the card shows the assessment, the profile gets a speaking level and the points.
    const spec = findAgentSpec(app, "english-tutor")!;
    expect(spec.tools).toEqual(expect.arrayContaining(["english_speaking", "english_speaking_grade"]));
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at,lane) values('r_tutor','ask','english','running','t',?,?,?)", JSON.stringify({ conversationId: sessionId }), new Date().toISOString(), sessionId);
    const tutor = toolContextForToken(app, issueToolToken({ runId: "r_tutor", spaceId: "english", spaces: ["english"], tools: new Set(spec.tools), actor: "agent", spec: spec.name, plugin: "english" }))!;
    const graded = await callTool(tutor, "english_speaking_grade", {
      block_id: blockId,
      level: "A2",
      scores: { fluency: 3, grammar: 2, vocab: 2, fit: null },
      review: "**一句话结论**：能把事办成，want 直接说偏生硬。",
      points: [{ point: "phrase:light-ice", correct: false, error_tag: "word-choice" }, { point: "phrase:to-go", correct: true }],
    });
    expect(graded.text).toMatch(/A2，口语水平和 2 个知识点已更新/);
    const block = sessionView(app, env, sessionId, "owner").blocks[0];
    expect(block.result.assessment).toMatchObject({ level: "A2", scores: { fluency: 3, grammar: 2, vocab: 2, fit: null } });
    const snap = snapshot(store);
    expect(snap.skills.find((k) => k.skill === "speaking")).toMatchObject({ level: "A2", attempts: 1 });
    expect(snap.weak.map((w) => w.point)).toContain("phrase:light-ice");
    expect(snap.speaking).toMatchObject({ total: 1, last: { scene: "在餐厅点餐", level: "A2" } });
    // A correction of the same assessment does not count twice.
    await callTool(tutor, "english_speaking_grade", { block_id: blockId, level: "B1", scores: {}, review: "改一下" });
    expect(snapshot(store).skills.find((k) => k.skill === "speaking")!.attempts).toBe(1);
    // Done: the brief is not given out again for it.
    expect((await page("english_speaking_brief", { block_id: blockId })).isError).toBe(true);
  });

  it("speaking has no page or role of its own in omem any more", () => {
    const root = join(import.meta.dirname, "..");
    expect(existsSync(join(root, "web/src/views/Speaking.vue"))).toBe(false);
    expect(readFileSync(join(root, "web/src/main.ts"), "utf8")).not.toMatch(/\/speaking/);
    expect(readFileSync(join(root, "web/src/App.vue"), "utf8")).not.toMatch(/\/speaking|addSpeakingPage/);
    expect((roleNames as readonly string[]).includes("speaking-coach")).toBe(false);
    expect(existsSync(join(root, "roles/speaking-coach.md"))).toBe(false);
    // The shell keeps the voice session's secret from the page: it does not forward voice/… for it.
    expect(readFileSync(join(root, "web/src/views/Plugin.vue"), "utf8")).toMatch(/\/\^voice\\\/\/\.test\(path\)/);
  });
});
