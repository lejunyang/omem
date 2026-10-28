import { describe, expect, it } from "vitest";
import { deleteAgentSpec, findAgentSpec, listAgentSpecs, listSkills, readRaw, saveAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { findSpace } from "../src/core/spaces.ts";
import { createSession, sessionView, submitBlock } from "../src/plugins/blocks.ts";
import { getPlugin, loadPlugins } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import { levelOf, nextRating, normalize, snapshot, wordAccuracy } from "../plugins/english/learner.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

async function englishApp() {
  const app = testApp();
  await loadPlugins(app);
  return app;
}

/** A plugin session with a turn of the tutor in it (no real agent: the run row is enough for tools). */
async function tutorTurn(app: Awaited<ReturnType<typeof englishApp>>) {
  const { id: conversationId } = await createSession(app, { plugin: "english", agent: "english-tutor", spaceId: "english", userId: "owner" });
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at,lane) values(?,?,?,?,?,?,?,?)", runId, "ask", "english", "running", "t", JSON.stringify({ conversationId }), new Date().toISOString(), conversationId);
  const spec = findAgentSpec(app, "english-tutor")!;
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId: "english", spaces: ["english"], tools: new Set(spec.tools), actor: "agent", spec: spec.name, plugin: spec.plugin }))!;
  return { conversationId, runId, ctx };
}

const quiz = {
  title: "餐厅点餐 · 第 1 组",
  items: [
    { type: "choice", prompt: "想打包时说：", options: ["for here", "to go", "take over"], answer: 1, skill: "vocab", level: "A2", points: ["phrase:to-go"], explanation: "to go = 带走" },
    { type: "cloze", text: "Could I get the ___, please?", answer: ["check", "bill"], skill: "vocab", level: "A2", points: ["word:bill"] },
    { type: "dictation", audio: { text: "I'd like it medium rare." }, skill: "listening", level: "B1", points: ["phrase:medium-rare"] },
    { type: "translate", direction: "zh-en", prompt: "这道菜辣吗？", reference: "Is this dish spicy?", skill: "translation", level: "A2", points: ["word:spicy"] },
  ],
};

describe("plugins", () => {
  it("loads the English plugin: its space, skill and agent, which shows up like any profile", async () => {
    const app = await englishApp();
    expect(findSpace(app, "english")).toMatchObject({ kind: "learning" });
    expect(listSkills(app).map((s) => s.name)).toContain("english-item-writing");
    const spec = findAgentSpec(app, "english-tutor")!;
    expect(spec).toMatchObject({ plugin: "english", space: "english", skills: ["english-item-writing"] });
    expect(spec.tools).toEqual(expect.arrayContaining(["english_quiz", "english_grade", "english_snapshot", "plugin_query", "plugin_put", "recall", "remember"]));
    expect(listAgentSpecs(app).map((s) => s.name)).toContain("english-tutor");
    expect(getPlugin("english").tools.find((t) => t.name === "english_snapshot")?.page).toBe(true);
    // The owner's edit becomes a library copy that keeps the plugin scope; it cannot be deleted while it is the plugin's own.
    expect(() => deleteAgentSpec(app, "english-tutor")).toThrow(/插件自带/);
    expect(readRaw(app, "agent", "english-tutor")).toMatch(/plugin: english/);
    saveAgentSpec(app, { name: "english-tutor", description: "我的英语陪练" }, "user");
    expect(findAgentSpec(app, "english-tutor")).toMatchObject({ description: "我的英语陪练", plugin: "english" });
    deleteAgentSpec(app, "english-tutor");
    expect(findAgentSpec(app, "english-tutor")!.description).not.toBe("我的英语陪练");
  });

  it("a quiz goes to the page without its answers; a submission is graded, recorded and reaches the tutor", async () => {
    const app = await englishApp();
    const { conversationId, ctx } = await tutorTurn(app);
    const bad = await callTool(ctx, "english_quiz", { ...quiz, items: [{ ...quiz.items[0], answer: 5 }] });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/超出了选项范围/);
    const shown = await callTool(ctx, "english_quiz", quiz);
    expect(shown.isError).toBe(false);
    const def = (k: string) => getPlugin("english").blocks.get(k);
    const view = sessionView(app, "english", def, conversationId, "owner");
    expect(view.busy).toBe("running");
    const block = view.blocks[0];
    expect(block.status).toBe("open");
    expect(JSON.stringify(block.data)).not.toMatch(/"answer"|reference|带走/);
    expect(block.data.items.map((i: { id: string }) => i.id)).toEqual(["q1", "q2", "q3", "q4"]);

    const r = await submitBlock(app, { plugin: "english", def, blockId: block.id, userId: "owner", answers: { q1: 1, q2: "Bill", q3: "I like it medium rare", q4: "Is the dish spicy?" } });
    const items = (r.result as { items: { id: string; correct: boolean | null; pending: boolean; score: number | null }[] }).items;
    expect(items.map((i) => [i.id, i.correct])).toEqual([["q1", true], ["q2", true], ["q3", false], ["q4", null]]);
    expect(items[2].score).toBe(0.8);
    await expect(submitBlock(app, { plugin: "english", def, blockId: block.id, userId: "owner", answers: {} })).rejects.toThrow(/提交过/);
    const msg = one<{ text: string; meta: string }>(app.db, "select text, meta from messages where conversation_id = ? and role = 'user' order by created_at desc limit 1", conversationId)!;
    expect(JSON.parse(msg.meta)).toMatchObject({ submission: block.id });
    expect(msg.text).toMatch(/^【提交】餐厅点餐 · 第 1 组：判过分的 3 题对 2 题，1 题待你评分/);
    expect(msg.text).toContain(`english_grade(block_id="${block.id}")`);
    expect(r.runId).toBeTruthy();
    // Submitted, the page may see the answers.
    expect(sessionView(app, "english", def, conversationId, "owner").blocks[0].data.items[0].answer).toBe(1);

    const graded = await callTool(ctx, "english_grade", { block_id: block.id, grades: [{ item_id: "q4", score: 0.9, feedback: "很好，this dish 更贴切", error_tags: ["article"] }, { item_id: "q3", feedback: "I'd 的 'd 要听出来" }] });
    expect(graded.text).toMatch(/都评完了/);
    const store = pluginStore(app, "english", "owner", "english");
    expect(store.get("attempts", `${block.id}:q4`)).toMatchObject({ score: 0.9, correct: true, errorTags: ["article"] });
    const s = snapshot(store);
    expect(s.total).toBe(4);
    expect(s.skills.find((k) => k.skill === "translation")!.attempts).toBe(1);
    expect(s.weak.map((w) => w.point)).toContain("phrase:medium-rare");
    expect(s.errors).toEqual([{ tag: "article", count: 1 }]);
    const snap = await callTool(ctx, "english_snapshot", {});
    expect(snap.text).toMatch(/作答 4 题/);
  });

  it("blocks only work inside the plugin's own sessions; plugin records only in a plugin's run", async () => {
    const app = await englishApp();
    run(app.db, "insert into conversations(id,space_id,channel,title,created_at,updated_at) values('c_web','personal','web','',?,?)", new Date().toISOString(), new Date().toISOString());
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values('r_web','ask','personal','running','t',?,?)", JSON.stringify({ conversationId: "c_web" }), new Date().toISOString());
    const web = toolContextForToken(app, issueToolToken({ runId: "r_web", spaceId: "personal", spaces: null, tools: null, actor: "agent", plugin: "english" }))!;
    expect((await callTool(web, "english_quiz", quiz)).text).toMatch(/只能在插件页面的会话里用/);
    const assistant = toolContextForToken(app, issueToolToken({ runId: "r_web", spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    expect((await callTool(assistant, "plugin_query", { collection: "attempts" })).text).toMatch(/只在插件的 Agent 运行里可用/);
    const { ctx } = await tutorTurn(app);
    expect((await callTool(ctx, "plugin_put", { collection: "notes", key: "goal", data: { text: "雅思 7" } })).text).toMatch(/已写入 notes\/goal/);
    expect((await callTool(ctx, "plugin_query", { collection: "notes", key: "goal" })).text).toContain("雅思 7");
    expect(all(app.db, "select id from plugin_records where collection = 'notes'")).toEqual([{ id: "english:owner:notes:goal" }]);
  });

  it("the page API: sessions of this plugin only, page tools only, built pages served for a sandboxed frame", async () => {
    const app = await englishApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      expect((await server.inject({ url: "/api/plugins" })).json()).toMatchObject([{ id: "english", agents: [{ name: "english-tutor" }], page: { title: "英语练习" } }]);
      const s = (await server.inject({ method: "POST", url: "/api/plugins/english/sessions", payload: {} })).json() as { id: string };
      expect((await server.inject({ url: `/api/plugins/english/sessions/${s.id}` })).json()).toMatchObject({ agent: "english-tutor", spaceId: "english", blocks: [], busy: null });
      expect((await server.inject({ url: "/api/plugins/english/sessions/c_nope" })).statusCode).toBe(404);
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/sessions", payload: { agent: "assistant" } })).statusCode).toBe(400);
      const snap = await server.inject({ method: "POST", url: "/api/plugins/english/call/english_snapshot", payload: { format: "json" } });
      expect(JSON.parse(snap.json().text)).toMatchObject({ total: 0, skills: expect.any(Array) });
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/call/english_grade", payload: {} })).statusCode).toBe(403);
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/call/remember", payload: {} })).statusCode).toBe(403);
      expect((await server.inject({ url: "/api/plugins/nope/sessions" })).statusCode).toBe(404);
      expect((await server.inject({ url: "/plugins/english/..%2F..%2Fpackage.json" })).statusCode).toBe(404);
      const page = await server.inject({ url: "/plugins/english/" });
      // A clean source checkout may not have built the page yet.
      if (page.statusCode === 200) expect(page.headers["access-control-allow-origin"]).toBe("*");
    } finally {
      await server.close();
    }
  });

  it("learner arithmetic: answers compared loosely, dictation by words, ratings move with difficulty", () => {
    expect(normalize("  I’d like THE bill. ")).toBe("i'd like the bill");
    expect(wordAccuracy("I'd like it medium rare.", "i'd like it medium rare")).toBe(1);
    expect(wordAccuracy("I'd like it medium rare.", "I like it medium rare")).toBe(0.8);
    expect(wordAccuracy("one two", "")).toBe(0);
    expect(levelOf(1000)).toBe("B1");
    expect(levelOf(600)).toBe("A1");
    expect(levelOf(2000)).toBe("C2");
    expect(nextRating(1000, "B1", 1)).toBe(1016);
    expect(nextRating(1000, "C2", 1)).toBeGreaterThan(nextRating(1000, "A1", 1));
    expect(nextRating(1000, "A1", 0)).toBeLessThan(nextRating(1000, "C2", 0));
  });
});
