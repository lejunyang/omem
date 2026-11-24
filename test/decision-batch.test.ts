import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { setKey } from "../src/core/ai-keys.ts";
import { all } from "../src/core/db.ts";
import { decide, decideMany, decisionOrder, DecisionRefused, resetDecisionCooldownForTests, setDecisionFetchForTests, type DecisionQuestion } from "../src/core/decision.ts";
import { decideSceneMany, type DecisionRow } from "../src/core/decision-log.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

function setup() {
  const app = testApp(); apps.push(app);
  app.config.ai.providers = [
    { id: "a", name: "甲", kind: "openai", backends: [] },
    { id: "b", name: "乙", kind: "typesafe", backends: [] },
    { id: "c", name: "丙", kind: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", backends: [] },
  ];
  for (const id of ["a", "b", "c"]) setKey(app.home, id, `key-${id}`);
  app.config.ai.decision = { provider: "a", model: "m-a", others: [{ provider: "b", model: "m-b" }], fallback: "general", gatekeeper: true };
  return app;
}

type Call = { url: string; body: Record<string, unknown> };
function fake(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  setDecisionFetchForTests(async (url, init) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return Response.json(answer(call));
  });
  return calls;
}

const questions = {
  relevant: { type: "yesno", instructions: "和项目 A 有关吗？", yes: "有关", no: "无关" },
  action: { type: "choice", instructions: "怎么处理？", options: { ignore: "不用管", notify: "提醒", handle: "先查" } },
} satisfies Record<string, DecisionQuestion>;
const predicate = (name: string, probability: number) => ({ type: "predicate", name, probability });
const choice = { type: "choice", name: "action", probabilities: [{ value: "ignore", probability: 0.625 }, { value: "notify", probability: 0.375 }], confidence: 0.8 };
const systemAnswers = { action: { type: "choice", choice: "notify", probabilities: { notify: 0.875, ignore: 0.125 } }, relevant: { type: "noul", noul: 0.75 } };

it("OpenAI 一次发送具名问题，按名字而不是答案顺序匹配", async () => {
  const app = setup(), material = { 消息: "项目 A 有更新" };
  const calls = fake(() => ({ answers: [choice, predicate("relevant", 0.125), predicate("extra", 0.75)] }));
  expect(await decideMany(app, material, questions)).toEqual({
    relevant: { choice: "no", probabilities: { yes: 0.125, no: 0.875 }, confidence: null, by: "甲 · m-a" },
    action: { choice: "ignore", probabilities: { ignore: 0.625, notify: 0.375 }, confidence: 0.8, by: "甲 · m-a" },
  });
  expect(calls).toEqual([{ url: "https://api.openai.com/v1/decisions", body: {
    model: "m-a", input: [{ role: "user", content: [{ type: "input_json", data: material }] }],
    questions: [
      { type: "predicate", name: "relevant", instructions: questions.relevant.instructions },
      { type: "choice", name: "action", instructions: questions.action.instructions, choices: Object.entries(questions.action.options).map(([value, description]) => ({ value, description })) },
    ],
  } }]);
});

it("System One 一次发送问题对象，only 选未列出的 Clef 并保留媒体，读取包装的答案", async () => {
  const app = setup(), images = ["data:image/png;base64,AA=="];
  const calls = fake(() => ({ success: true, result: { answers: systemAnswers } }));
  expect(await decideMany(app, "材料", questions, { only: { provider: "c", model: "clef" }, media: { images, audio: [] } })).toEqual({
    relevant: { choice: "yes", probabilities: { yes: 0.75, no: 0.25 }, confidence: null, by: "丙 · clef" },
    action: { choice: "notify", probabilities: { notify: 0.875, ignore: 0.125 }, confidence: null, by: "丙 · clef" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toMatch(/\/run\/@cf\/cloudflare\/clef$/);
  expect(calls[0].body).toEqual({ model: "clef", state: "材料", images, questions: {
    relevant: { type: "noul", instructions: questions.relevant.instructions, criteria: { true: "有关", false: "无关" } },
    action: { type: "choice", instructions: questions.action.instructions, criteria: questions.action.options },
  } });
});

it("StartLux 把每道是 / 否题改成 choice，不启本地模型服务", async () => {
  const app = setup();
  app.config.guard.provider = "startlux";
  app.config.guard.url = "https://judge.example.invalid/";
  const calls = fake(() => ({ answers: { ...systemAnswers, relevant: { type: "choice", probabilities: { yes: 0.25, no: 0.75 } } } }));
  expect(await decideMany(app, "材料", questions, { only: { provider: "startlux", model: "" } })).toMatchObject({
    relevant: { choice: "no", probabilities: { yes: 0.25, no: 0.75 }, by: "StartLux-Decision（本机）" },
    action: { choice: "notify", by: "StartLux-Decision（本机）" },
  });
  expect(calls).toEqual([{ url: "https://judge.example.invalid/v1/systemone", body: { state: { material: "材料" }, questions: {
    relevant: { type: "choice", instructions: questions.relevant.instructions, criteria: { yes: "有关", no: "无关" } },
    action: { type: "choice", instructions: questions.action.instructions, criteria: questions.action.options },
  } } }]);
});

it.each(["a", "b"])("%s 缺一题时整批换模型并冷却，不混用答案", async (first) => {
  const app = setup();
  if (first === "b") {
    app.config.ai.decision = { ...app.config.ai.decision, provider: "b", model: "m-b", others: [{ provider: "a", model: "m-a" }] };
  }
  const calls = fake(({ url }) => url.endsWith("/decisions")
    ? { answers: first === "a" ? [predicate("relevant", 0.125)] : [predicate("relevant", 0.125), choice] }
    : { answers: first === "b" ? { relevant: systemAnswers.relevant } : systemAnswers });
  const results = (await decideMany(app, "材料", questions))!;
  const by = first === "a" ? "乙 · m-b；甲 · m-a没答上，换了一个" : "甲 · m-a；乙 · m-b没答上，换了一个";
  expect(results.relevant).toMatchObject({ choice: first === "a" ? "yes" : "no", by });
  expect(results.action).toMatchObject({ choice: first === "a" ? "notify" : "ignore", by });
  expect(calls.map(({ body }) => body.model)).toEqual(first === "a" ? ["m-a", "m-b"] : ["m-b", "m-a"]);
  expect(decisionOrder(app).map(({ provider }) => provider)).toEqual(first === "a" ? ["b", "a"] : ["a", "b"]);
  expect(Object.keys(calls[0].body.questions as object)).toHaveLength(2);
  expect(Object.keys(calls[1].body.questions as object)).toHaveLength(2);
});

it("多题拒答也换模型但不冷却，only 不换", async () => {
  const app = setup();
  const calls = fake(({ url }) => url.endsWith("/decisions")
    ? { answers: [predicate("relevant", 0.125), { type: "refusal", name: "action" }] }
    : { answers: systemAnswers });
  await expect(decideMany(app, "材料", questions, { only: { provider: "a", model: "m-a" } })).rejects.toBeInstanceOf(DecisionRefused);
  expect(calls).toHaveLength(1);
  expect((await decideMany(app, "材料", questions))?.relevant.by).toContain("乙 · m-b");
  expect(calls.map(({ body }) => body.model)).toEqual(["m-a", "m-a", "m-b"]);
  expect(decisionOrder(app).map(({ provider }) => provider)).toEqual(["a", "b"]);
});

it("单题保留 q 和位置兼容，多题入口即使只有一题也按名字匹配", async () => {
  const app = setup(), only = { provider: "a", model: "m-a" };
  const calls = fake(() => ({ answers: [{ type: "predicate", probability: 0.75 }] }));
  expect(await decide(app, "材料", questions.relevant, { only })).toMatchObject({ choice: "yes" });
  await expect(decideMany(app, "材料", { relevant: questions.relevant }, { only })).rejects.toThrow(/未返回问题「relevant」/);
  expect(calls.map(({ body }) => body.questions)).toEqual([
    [{ type: "predicate", name: "q", instructions: questions.relevant.instructions }],
    [{ type: "predicate", name: "relevant", instructions: questions.relevant.instructions }],
  ]);
  fake(() => ({ answers: [] }));
  await expect(decide(app, "材料", questions.relevant, { only })).rejects.toBeInstanceOf(DecisionRefused);
});

it("空批不请求，超过八题在发请求前报错，没配模型返回 null", async () => {
  const app = setup(), calls = fake(() => ({}));
  expect(await decideMany(app, "材料", {})).toEqual({});
  await expect(decideMany(app, "材料", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, questions.relevant])))).rejects.toThrow(/最多问 8 个/);
  app.config.ai.decision = { provider: "", model: "", fallback: "general", gatekeeper: true };
  expect(await decideMany(app, "材料", questions)).toBeNull();
  expect(calls).toHaveLength(0);
});

it("各题使用自己的场景门槛并独立存材料和原题，无场景不留记录", async () => {
  const app = setup();
  app.config.ai.decision.thresholds = { ...app.config.ai.decision.thresholds!, triage: 0.7 };
  const material = { 甲: '\"\n'.repeat(15000), 乙: "长文本".repeat(15000) };
  const calls = fake(() => ({ answers: [choice, predicate("relevant", 0.125), predicate("raw", 0.75)] }));
  const batch = {
    relevant: { question: questions.relevant, scene: "heartbeat" as const, ref: "run-other", sources: ["s1", "s1", "s2"] },
    action: { question: questions.action, scene: "triage" as const },
    raw: { question: questions.relevant },
  };
  const r = (await decideSceneMany(app, material, batch, { ref: "run-demo", sources: ["s3"] }))!;
  expect(calls).toHaveLength(1);
  expect(r.relevant).toMatchObject({ choice: "no", taken: "no", threshold: 0.6, lowered: false });
  expect(r.action).toMatchObject({ choice: "ignore", taken: "notify", threshold: 0.7, lowered: true });
  expect(r.raw).toEqual({ choice: "yes", probabilities: { yes: 0.75, no: 0.25 }, confidence: null, by: "甲 · m-a" });
  const rows = all<DecisionRow>(app.db, "select * from decisions order by scene");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ id: r.relevant.id, scene: "heartbeat", ref: "run-other", sources: '["s1","s2"]', question: JSON.stringify(questions.relevant), taken: "no", by: r.relevant.by });
  expect(rows[1]).toMatchObject({ id: r.action.id, scene: "triage", ref: "run-demo", sources: "[]", question: JSON.stringify(questions.action), taken: "notify", probabilities: JSON.stringify(r.action.probabilities) });
  expect(rows[1].id).not.toBe(rows[0].id);
  expect(rows[0].material).toBe(rows[1].material);
  expect(rows[0].material.length).toBeLessThanOrEqual(12000);
  expect(Object.keys(JSON.parse(rows[0].material))).toEqual(["甲", "乙"]);

  fake(() => ({ answers: [choice, predicate("relevant", 0.125)] }));
  await expect(decideSceneMany(app, material, batch, { only: { provider: "a", model: "m-a" } })).rejects.toThrow(/未返回问题「raw」/);
  expect(all(app.db, "select id from decisions")).toHaveLength(2);
});
