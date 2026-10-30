import { describe, expect, it } from "vitest";
import { deleteAgentSpec, findAgentSpec, listAgentSpecs, listSkills, readRaw, saveAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { findSpace } from "../src/core/spaces.ts";
import { createSession, sessionView, submitBlock } from "../src/plugins/blocks.ts";
import { describePlugin, getPlugin, loadPlugins, setPluginIcon } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import { webLink } from "../src/core/util.ts";
import { levelOf, nextRating, normalize, pickFromBank, snapshot, wordAccuracy, type BankEntry } from "../plugins/english/learner.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    const env = getPlugin("english").env;
    const view = sessionView(app, env, conversationId, "owner");
    expect(view.busy).toBe("running");
    const block = view.blocks[0];
    expect(block.status).toBe("open");
    expect(JSON.stringify(block.data)).not.toMatch(/"answer"|reference|带走/);
    expect(block.data.items.map((i: { id: string }) => i.id)).toEqual(["q1", "q2", "q3", "q4"]);

    const r = await submitBlock(app, env, { blockId: block.id, userId: "owner", answers: { q1: 1, q2: "Bill", q3: "I like it medium rare", q4: "Is the dish spicy?" } });
    const items = (r.result as { items: { id: string; correct: boolean | null; pending: boolean; score: number | null }[] }).items;
    expect(items.map((i) => [i.id, i.correct])).toEqual([["q1", true], ["q2", true], ["q3", false], ["q4", null]]);
    expect(items[2].score).toBe(0.8);
    await expect(submitBlock(app, env, { blockId: block.id, userId: "owner", answers: {} })).rejects.toThrow(/提交过/);
    const msg = one<{ text: string; meta: string }>(app.db, "select text, meta from messages where conversation_id = ? and role = 'user' order by created_at desc limit 1", conversationId)!;
    expect(JSON.parse(msg.meta)).toMatchObject({ submission: block.id });
    expect(msg.text).toMatch(/^【提交】餐厅点餐 · 第 1 组：判过分的 3 题对 2 题，1 题待你评分/);
    expect(msg.text).toContain(`english_grade(block_id="${block.id}")`);
    // The default way to get sets is the bank: the tutor comments and restocks instead of handing in the next one.
    expect(msg.text).toMatch(/不要用 english_quiz 出下一组。题库现在 0 题，用 english_bank_add 补到约 24 题/);
    expect(r.runId).toBeTruthy();
    // Submitted, the page may see the answers.
    expect(sessionView(app, env, conversationId, "owner").blocks[0].data.items[0].answer).toBe(1);

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

  it("a block handed in outside the plugin's page (a Feishu chat) opens a session there and gives a link; plugin records only in a plugin's run", async () => {
    const app = await englishApp();
    run(app.db, "insert into conversations(id,space_id,channel,title,created_at,updated_at) values('c_lark','personal','lark','',?,?)", new Date().toISOString(), new Date().toISOString());
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values('r_web','ask','personal','running','t',?,?)", JSON.stringify({ conversationId: "c_lark" }), new Date().toISOString());
    const lark = toolContextForToken(app, issueToolToken({ runId: "r_web", spaceId: "english", spaces: null, tools: null, actor: "agent", spec: "english-tutor", plugin: "english" }))!;
    app.config.webUrl = "http://192.0.2.10:4317/";
    const moved = await callTool(lark, "english_quiz", quiz);
    const session = one<{ id: string; title: string; settings: string }>(app.db, "select id, title, settings from conversations where channel = 'plugin:english'")!;
    expect(moved.text).toContain(`http://192.0.2.10:4317/#/plugin/english?session=${session.id}`);
    expect(session).toMatchObject({ title: quiz.title });
    expect(JSON.parse(session.settings)).toEqual({ spec: "english-tutor" });
    expect(sessionView(app, getPlugin("english").env, session.id, "owner").blocks).toHaveLength(1);
    // The host's blocks need a plugin run to know whose session it is.
    const plain = toolContextForToken(app, issueToolToken({ runId: "r_web", spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    expect((await callTool(plain, "plugin_form", { title: "t", fields: [{ id: "a", label: "a", type: "text" }] })).text).toMatch(/只在插件的 Agent 运行里可用/);
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

  it("settings: declared in the manifest, defaults filled in, checked on save, read by the plugin", async () => {
    const app = await englishApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const got = (await server.inject({ url: "/api/plugins/english/settings" })).json();
      expect(got.values).toEqual({ source: "bank", quizSize: "8", voice: "en-US", rate: "1", dailyGoal: 30 });
      expect(got.fields.map((f: { key: string }) => f.key)).toEqual(["source", "quizSize", "voice", "rate", "dailyGoal"]);
      expect((await server.inject({ method: "PUT", url: "/api/plugins/english/settings", payload: { quizSize: "7" } })).statusCode).toBe(400);
      expect((await server.inject({ method: "PUT", url: "/api/plugins/english/settings", payload: { dailyGoal: 1 } })).statusCode).toBe(400);
      expect((await server.inject({ method: "PUT", url: "/api/plugins/english/settings", payload: { nope: 1 } })).statusCode).toBe(400);
      const saved = (await server.inject({ method: "PUT", url: "/api/plugins/english/settings", payload: { source: "tutor", dailyGoal: "40" } })).json();
      expect(saved.values).toMatchObject({ source: "tutor", dailyGoal: 40, quizSize: "8" });
      // Agents cannot reach the settings through plugin records.
      const { ctx } = await tutorTurn(app);
      expect((await callTool(ctx, "plugin_query", { collection: "_settings" })).isError).toBe(true);
      expect((await callTool(ctx, "english_snapshot", {})).text).toMatch(/出题方式 陪练现出.*每天目标 40 题/);
    } finally {
      await server.close();
    }
  });

  it("the host's blocks: a form is checked and handed in like any block, a chart is only shown", async () => {
    const app = await englishApp();
    const { conversationId, ctx } = await tutorTurn(app);
    const env = getPlugin("english").env;
    expect((await callTool(ctx, "plugin_form", { title: "目标", fields: [{ id: "a", label: "A", type: "choice", options: ["x"] }] })).text).toMatch(/至少要两个选项/);
    await callTool(ctx, "plugin_form", { title: "这周的目标", fields: [{ id: "scene", label: "想练的场景", type: "multi", options: ["点餐", "面试", "邮件"], required: true }, { id: "minutes", label: "每天几分钟", type: "number" }, { id: "mood", label: "信心", type: "scale" }] });
    expect((await callTool(ctx, "plugin_chart", { title: "近 3 天", labels: ["一", "二"], series: [{ name: "题数", values: [1, 2, 3] }] })).text).toMatch(/要一样多/);
    await callTool(ctx, "plugin_chart", { title: "近 3 天", labels: ["一", "二", "三"], series: [{ name: "题数", values: [4, 0, 8] }] });
    const [form, chart] = sessionView(app, env, conversationId, "owner").blocks;
    expect([form.kind, form.status, chart.kind, chart.status]).toEqual(["form", "open", "chart", "shown"]);
    await expect(submitBlock(app, env, { blockId: form.id, userId: "owner", answers: { minutes: "20" } })).rejects.toThrow(/还没填：想练的场景/);
    expect(sessionView(app, env, conversationId, "owner").blocks[0].status).toBe("open");
    const r = await submitBlock(app, env, { blockId: form.id, userId: "owner", answers: { scene: ["面试", "不存在"], minutes: "20", mood: 9 } });
    expect(r.result).toEqual({ values: { scene: "面试", minutes: "20", mood: "5" } });
    const msg = one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'user' order by created_at desc limit 1", conversationId)!;
    expect(msg.text).toBe("【提交】这周的目标\n- 想练的场景：面试\n- 每天几分钟：20\n- 信心：5");
    await expect(submitBlock(app, env, { blockId: chart.id, userId: "owner", answers: {} })).rejects.toThrow(/只用来展示/);
  });

  it("nav icons: the manifest's name or .svg, and the owner's choice over it", async () => {
    const app = testApp();
    const dir = join(app.home, "plugins", "drawn");
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), ["id: drawn", "name: 画", "icon: web-icon.svg", "page: { title: 画 }"].join("\n"));
    await loadPlugins(app);
    expect(describePlugin(getPlugin("english")).icon).toBe("languages");
    expect(describePlugin(getPlugin("drawn")).icon).toBe("/plugins/drawn/web-icon.svg");
    expect(setPluginIcon(app, "drawn", "notebook")).toMatchObject({ icon: "notebook", iconChosen: true });
    expect(app.config.plugins.icons).toEqual({ drawn: "notebook" });
    expect(() => setPluginIcon(app, "drawn", "../x.svg")).toThrow();
    expect(setPluginIcon(app, "drawn", "")).toMatchObject({ icon: "/plugins/drawn/web-icon.svg", iconChosen: false });
  });

  it("a plugin in the data directory: declarations and skills, the default page; its code waits for trust", async () => {
    const app = testApp();
    const dir = join(app.home, "plugins", "journal");
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "skills", "journal-style"), { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "id: journal\nname: 日记\nagents: [coach]\nskills: [journal-style]\ntools: [recall]\npage: { title: 日记 }\n");
    writeFileSync(join(dir, "agents", "coach.md"), "---\ndescription: 陪本人写日记\n---\n\n每天问本人三个问题。\n");
    writeFileSync(join(dir, "skills", "journal-style", "SKILL.md"), "---\nname: journal-style\ndescription: 日记的问法\n---\n\n先问今天最好的事。\n");
    writeFileSync(join(dir, "server.ts"), "throw new Error('must not run')\n");
    await loadPlugins(app);
    const p = getPlugin("journal");
    expect(p.source).toBe("data");
    expect(p.trust).toBe("required");
    expect(findAgentSpec(app, "journal-coach")!.tools.sort()).toEqual(["plugin_chart", "plugin_form", "plugin_put", "plugin_query", "recall"]);
    expect(listSkills(app).map((s) => s.name)).toContain("journal-style");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const listed = (await server.inject({ url: "/api/plugins" })).json() as { id: string; source: string; page: unknown }[];
      expect(listed.find((x) => x.id === "journal")).toMatchObject({ source: "data", trust: "required", page: { title: "日记", own: false, built: false } });
    } finally {
      await server.close();
    }
  });

  it("the question bank: the tutor stocks it, the next set is drawn at once and weak points come first", async () => {
    const app = await englishApp();
    const { conversationId, ctx } = await tutorTurn(app);
    const one_ = (n: number, point: string, scene = "餐厅点餐") => ({ type: "cloze", text: `Item ${n} ___.`, answer: ["x"], skill: "vocab", level: "A2", points: [point] });
    const added = await callTool(ctx, "english_bank_add", { scene: "餐厅点餐", items: Array.from({ length: 10 }, (_, i) => one_(i, `word:w${i}`)) });
    expect(added.text).toMatch(/题库现在 10 题/);
    const page = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "english", spaces: null, tools: new Set(["english_next"]), actor: "user", plugin: "english" }))!;
    expect(JSON.parse((await callTool(page, "english_next", { session_id: conversationId, scene: "面试" })).text)).toEqual({ drawn: false, bank: 10 });
    const drawn = JSON.parse((await callTool(page, "english_next", { session_id: conversationId, scene: "餐厅点餐" })).text);
    expect(drawn).toMatchObject({ drawn: true, bank: 2 });
    const block = sessionView(app, getPlugin("english").env, conversationId, "owner").blocks.find((b) => b.id === drawn.blockId)!;
    expect(block.data.title).toBe("餐厅点餐（题库）");
    expect(block.data.items).toHaveLength(8);
    expect(JSON.stringify(block.data)).not.toContain('"answer"');
    // Someone else's session is not a place to draw into, and the bank keeps its questions.
    await callTool(ctx, "english_bank_add", { scene: "", items: Array.from({ length: 8 }, (_, i) => one_(i, `word:v${i}`)) });
    expect((await callTool(page, "english_next", { session_id: "c_nope" })).text).toMatch(/没有这个会话/);
    expect(pluginStore(app, "english", "owner", "english").count("bank")).toBe(10);

    const bank = (pts: string[]) => pts.map((p, i) => ({ key: `k${i}`, data: { item: { type: "cloze", skill: "vocab", level: "B1", points: [p] }, scene: "", addedAt: `2026-10-0${i + 1}` } as BankEntry }));
    const snap = { ...snapshot(pluginStore(app, "english", "owner", "x")), weak: [{ point: "word:late", seen: 3, accuracy: 0.3, lastScore: 0, lastAt: "", errors: {} }] };
    expect(pickFromBank(bank(["word:a", "word:b", "word:late"]), snap, { size: 1 })!.map((e) => e.data.item.points[0])).toEqual(["word:late"]);
    expect(pickFromBank(bank(["word:a"]), snap, { size: 2 })).toBeNull();
    // Translations wait for the tutor's grading: at most a quarter of a set while other questions are left.
    const typed = (type: string, p: string) => bank([1, 2, 3, 4].map((i) => `word:${p}${i}`)).map((e) => ({ key: `${p}${e.key}`, data: { ...e.data, item: { ...e.data.item, type } } }));
    const drawnTypes = pickFromBank([...typed("translate", "t"), ...typed("cloze", "c"), ...typed("choice", "h")], snap, { size: 8 })!.map((e) => e.data.item.type);
    expect(drawnTypes).toHaveLength(8);
    expect(drawnTypes.filter((t) => t === "translate")).toHaveLength(2);
    expect(drawnTypes).toEqual([...drawnTypes].sort((a, b) => ["choice", "cloze", "dictation", "translate"].indexOf(a) - ["choice", "cloze", "dictation", "translate"].indexOf(b)));
  });

  it("page links become absolute with the web address, so they open from Feishu", () => {
    expect(webLink({ config: {} }, "#/plugin/english")).toBe("#/plugin/english");
    expect(webLink({ config: { webUrl: "https://omem.example.com//" } }, "#/runs/r1")).toBe("https://omem.example.com/#/runs/r1");
    expect(webLink({ config: { webUrl: "https://omem.example.com" } }, "https://other.example.com/x")).toBe("https://other.example.com/x");
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
