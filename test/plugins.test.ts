import { describe, expect, it } from "vitest";
import { deleteAgentSpec, findAgentSpec, listAgentSpecs, listSkills, readRaw, saveAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { upsertSource } from "../src/sources/store.ts";
import { listRules } from "../src/rules/store.ts";
import { savePluginSettings } from "../src/plugins/settings.ts";
import { createUser } from "../src/core/users.ts";
import { createSpace, findSpace, updateSpace } from "../src/core/spaces.ts";
import { createSession, sessionView, submitBlock } from "../src/plugins/blocks.ts";
import { describePlugin, getPlugin, loadPlugins, setPluginEnabled, setPluginIcon } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import { webLink } from "../src/core/util.ts";
import { levelOf, nextRating, normalize, pickFromBank, snapshot, wordAccuracy, type BankEntry } from "../plugins/english/learner.ts";
import { commitLibrary, ensureLibraryRepo } from "../src/core/git.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

async function englishApp() {
  const app = testApp();
  await loadPlugins(app, undefined, manifest => manifest.id === "english");
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
    expect(spec).toMatchObject({ plugin: "english", space: "english", skills: ["english-item-writing", "english-speaking"] });
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

  it("refreshes seeded tutor skills on upgrade and preserves an edited copy", async () => {
    const app = await englishApp();
    ensureLibraryRepo(app.libraryDir);
    const skill = (name: string) => join(app.libraryDir, "_skills", name, "SKILL.md");
    writeFileSync(skill("english-item-writing"), "old writing guide\n");
    writeFileSync(skill("english-speaking"), "old speaking guide\n");
    commitLibrary(app.libraryDir, "omem: add skills of plugin english: english-item-writing, english-speaking");
    writeFileSync(skill("english-speaking"), "my speaking guide\n");
    await setPluginEnabled(app, "english", false);
    await setPluginEnabled(app, "english", true);
    expect(readFileSync(skill("english-item-writing"), "utf8")).toContain("材料题");
    expect(readFileSync(skill("english-speaking"), "utf8")).toBe("my speaking guide\n");
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
      expect((await server.inject({ url: "/api/plugins" })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "english", agents: [expect.objectContaining({ name: "english-tutor" })], page: expect.objectContaining({ title: "英语练习" }) })]));
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
      expect(got.values).toEqual({ source: "bank", quizSize: "8", voice: "en-US", rate: "1", dailyGoal: 30, materialSpaces: [] });
      expect(got.fields.map((f: { key: string }) => f.key)).toEqual(["source", "quizSize", "voice", "rate", "dailyGoal", "materialSpaces"]);
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

  it("limits tutor material tools to the selected readable spaces and keeps their writes in English", async () => {
    const app = await englishApp();
    app.baseUrl = "http://127.0.0.1:1";
    const spec = findAgentSpec(app, "english-tutor")!;
    const fields = getPlugin("english").manifest.settings;
    const save = (ids: string[]) => savePluginSettings(app, "english", fields, "owner", "english", { materialSpaces: ids });
    const turn = () => toolContextForToken(app, prepareRun(app, { actor: { spec }, runId: null, spaceId: "english" }).token)!;
    const source = (spaceId: string) => upsertSource(app, { spaceId, kind: "note", title: "行程", uri: "note:itinerary", text: "Choose a return date." }).id;
    const selected = source("personal"), other = source("english");
    expect((await callTool(turn(), "list_sources", {})).isError).toBe(true);
    expect(() => save(["missing"])).toThrow("不可选");
    const member = createUser(app, { name: "学习者" });
    expect(() => savePluginSettings(app, "english", fields, member.id, "english", { materialSpaces: ["personal"] })).toThrow("不可选");
    save(["personal"]);
    const ctx = turn();
    expect(ctx.writable).toEqual(["english"]);
    createSpace(app, { id: "overlay", name: "分支索引", kind: "worktree" });
    updateSpace(app, "overlay", { settings: { repo: "personal" } });
    expect((await callTool(ctx, "read_source", { source: source("overlay") })).isError).toBe(true);
    expect((await callTool(ctx, "search", { space: "personal", query: "return", branch: "sample" })).isError).toBe(true);
    expect((await callTool(ctx, "read_source", { source: selected })).text).toContain("Choose a return date.");
    expect((await callTool(ctx, "read_source", { source: other })).isError).toBe(true);
    expect((await callTool(ctx, "list_sources", { space: "english" })).isError).toBe(true);
    expect((await callTool(ctx, "search", { query: "return", space: "english" })).isError).toBe(true);
    expect((await callTool(ctx, "search", { query: "return", scope: "sources" })).text).toContain(selected);
    expect((await callTool(ctx, "remember", { space: "personal", kind: "preference", content: "学习者更喜欢用英文安排短途旅行。" })).isError).toBe(true);
    save([]);
    expect((await callTool(ctx, "read_source", { source: selected })).isError).toBe(true);
  });

  it("keeps verified citations and bilingual points, and drops invalid quiz and bank citations with a reason", async () => {
    const app = await englishApp();
    const { ctx, conversationId } = await tutorTurn(app);
    const { env, manifest } = getPlugin("english");
    savePluginSettings(app, "english", manifest.settings, "owner", "english", { materialSpaces: ["english"] });
    const source = (spaceId: string) => upsertSource(app, { spaceId, uri: "packing", title: "打包笔记", kind: "note", text: "收拾剩下的饭菜。\n想请店员打包。" }).id;
    const id = source("english"), other = source("personal");
    const material = { ref: `src:${id}#L2-L2`, title: "打包笔记", summary: "请店员打包。" };
    const expression = { zh: "打包", en: "to go" };
    const items = [
      { ...quiz.items[0], material: { ...material, title: "标题以原件为准" }, expression },
      ...["bad", "src:missing#L1-L1", `src:${id}#L2-L1`, `src:${id}#L1-L3`, `src:${other}#L1-L1`].map(ref => ({ ...quiz.items[1], material: { ...material, ref } })),
      { ...quiz.items[2], material: { title: "缺少引用" } },
    ];
    for (const tool of ["english_bank_add", "english_quiz"]) {
      const out = await callTool(ctx, tool, { title: "打包", items });
      expect(out.isError, out.text).toBe(false);
      expect(out.text).toContain("去掉 6 处");
    }
    const store = pluginStore(app, "english", "owner", "english");
    expect(store.list<BankEntry>("bank").filter(r => r.data.item.material)).toHaveLength(1);
    const block = sessionView(app, env, conversationId, "owner").blocks[0];
    expect(block.data.items[0].material).toEqual(material);
    expect(block.data.items[0]).not.toHaveProperty("expression");
    expect(block.data.items.slice(1).every((it: { material?: unknown }) => !it.material)).toBe(true);
    await submitBlock(app, env, { userId: "owner", blockId: block.id, answers: { q1: 0 } });
    expect(store.get("points", "phrase:to-go")).toMatchObject({ lastCorrect: false, expression: { ...expression, material } });
    expect(snapshot(store).recentMaterials).toMatchObject([{ sourceId: id, ...material }]);
  });

  it("imports a disabled morning lesson rule, updates the same day's bank and opens the notified lesson", async () => {
    const app = await englishApp();
    const { ctx, conversationId } = await tutorTurn(app);
    const { env, manifest } = getPlugin("english");
    expect(listRules(app).find(rule => rule.origin?.plugin === "english")).toMatchObject({
      enabled: false, trigger: { event: "schedule", cron: "0 8 * * *" }, actions: [{ type: "agent", spec: "english-tutor", task: expect.stringContaining("notify") }],
    });
    const expr = { zh: "留出时间", en: "leave time for" };
    const lesson = { theme: "留出时间", expressions: [expr], quiz, speaking: { scene: "和同事安排一次试用" } };
    const first = await callTool(ctx, "english_lesson", lesson);
    expect(first.isError, first.text).toBe(false);
    const store = pluginStore(app, "english", "owner", "english");
    expect(store.count("bank")).toBe(4);
    const date = store.list("lessons")[0].key;
    const link = `#/plugin/english?lesson=${date}`;
    expect(first.text).toContain(link);
    expect((await callTool(ctx, "notify", { title: lesson.theme, body: "今天练习安排时间。", link })).isError).toBe(false);
    expect(all(app.db, "select link from notifications where link=?", link)).toEqual([{ link }]);
    const id = upsertSource(app, { spaceId: "english", kind: "doc", uri: "schedule", title: "安排", text: "预留答疑时间。" }).id;
    savePluginSettings(app, "english", manifest.settings, "owner", "english", { materialSpaces: ["english"] });
    expect((await callTool(ctx, "list_sources", { recent_days: 2 })).text).toContain(id);
    const material = { ref: `src:${id}#L1-L1`, title: "安排", summary: "要留出答疑时间。" };
    const update = await callTool(ctx, "english_lesson", { ...lesson, expressions: [{ ...expr, material }], speaking: { ...lesson.speaking, material }, quiz: { ...quiz, items: [{ ...quiz.items[0], material }] } });
    expect(update.isError, update.text).toBe(false);
    expect(store.count("lessons")).toBe(1);
    expect(store.list("bank")).toMatchObject([{ data: { lessonDate: date, item: { material } } }]);
    expect(store.get("lessons", date)).toMatchObject({ expressions: [{ ...expr, material }], speaking: { material } });
    const bad = await callTool(ctx, "english_lesson", { ...lesson, quiz: { ...quiz, items: [{ ...quiz.items[0], answer: 99 }] } });
    expect(bad.isError).toBe(true);
    expect(store.count("bank")).toBe(1);
    const snap = JSON.parse((await callTool(ctx, "english_snapshot", { format: "json" })).text);
    expect(snap.todayLesson).toEqual({ date, ready: true, theme: lesson.theme, link });
    const drawn = JSON.parse((await callTool(ctx, "english_next", { session_id: conversationId, lessonDate: date })).text);
    expect(drawn).toMatchObject({ drawn: true, bank: 0 });
    expect(sessionView(app, env, conversationId, "owner").blocks[0].data.items[0].material).toEqual(material);
    for (let i = 0; i < 300; i++) store.put("bank", `ordinary-${i}`, { item: quiz.items[0], scene: "点餐" });
    expect((await callTool(ctx, "english_lesson", lesson)).isError).toBe(false);
    expect(store.count("bank")).toBe(304);
    expect((await callTool(ctx, "english_lesson", lesson)).isError).toBe(false);
    expect(store.count("bank")).toBe(304);
  });

  it("questions and views in a plugin session are its page's blocks: a form is checked and answered, a view is only shown", async () => {
    const app = await englishApp();
    const { conversationId, ctx, runId } = await tutorTurn(app);
    const env = getPlugin("english").env;
    expect((await callTool(ctx, "ask_user", { question: "目标", fields: [{ id: "a", label: "A", type: "choice", options: ["x"] }], wait_seconds: 0 })).isError).toBe(true);
    await callTool(ctx, "ask_user", { question: "这周的目标", fields: [{ id: "scene", label: "想练的场景", type: "multi", options: ["点餐", "面试", "邮件"], required: true }, { id: "minutes", label: "每天几分钟", type: "number", min: 5 }, { id: "mood", label: "信心", type: "scale" }], wait_seconds: 0 });
    expect((await callTool(ctx, "show", { components: [{ type: "chart", title: "近 3 天", labels: ["一", "二"], series: [{ name: "题数", values: [1, 2, 3] }] }] })).text).toMatch(/要一样多/);
    await callTool(ctx, "show", { title: "进展", components: [{ type: "chart", title: "近 3 天", labels: ["一", "二", "三"], series: [{ name: "题数", values: [4, 0, 8] }] }] });
    const [form, chart] = sessionView(app, env, conversationId, "owner").blocks;
    expect([form.kind, form.status, chart.kind, chart.status]).toEqual(["ask", "open", "view", "shown"]);
    expect(chart).toMatchObject({ runId, data: { title: "进展" } });
    await expect(submitBlock(app, env, { blockId: form.id, userId: "owner", answers: { value: { minutes: "20" } } })).rejects.toThrow(/还没填：想练的场景/);
    await expect(submitBlock(app, env, { blockId: form.id, userId: "owner", answers: { value: { scene: ["面试", "不存在"] } } })).rejects.toThrow(/不在选项里：不存在/);
    await expect(submitBlock(app, env, { blockId: form.id, userId: "owner", answers: { value: { scene: ["面试"], minutes: 3 } } })).rejects.toThrow(/不能小于 5/);
    expect(sessionView(app, env, conversationId, "owner").blocks[0].status).toBe("open");
    const r = await submitBlock(app, env, { blockId: form.id, userId: "owner", answers: { value: { scene: ["邮件", "面试"], minutes: "20", mood: 4 } } });
    expect((r.result as { answer: string }).answer).toBe("- 想练的场景：面试、邮件\n- 每天几分钟：20\n- 信心：4 / 5");
    const done = sessionView(app, env, conversationId, "owner").blocks[0];
    expect([done.status, done.answers]).toEqual(["submitted", { scene: ["面试", "邮件"], minutes: 20, mood: 4 }]);
    await expect(submitBlock(app, env, { blockId: chart.id, userId: "owner", answers: {} })).rejects.toThrow(/没有内容块/);
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
    expect(findAgentSpec(app, "journal-coach")!.tools.sort()).toEqual(["ask_user", "plugin_put", "plugin_query", "recall", "show", "wait_answer"]);
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
