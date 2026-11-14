import { afterEach, expect, it } from "vitest";
import { categoryStatus, decisionStatuses, setKey } from "../src/core/ai-keys.ts";
import { decide, decisionOrder, resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
  for (const app of apps.splice(0)) app.db.close();
});

/** Three decision models: 甲 (OpenAI Decisions) and 乙 (Jev) have keys, 丙 has none. */
function setup(pick?: "fixed" | "random") {
  const app = testApp();
  apps.push(app);
  app.config.ai.providers = [
    { id: "a", name: "甲", kind: "openai" as never, backends: [] },
    { id: "b", name: "乙", kind: "typesafe" as never, backends: [] },
    { id: "c", name: "丙", kind: "openrouter" as never, backends: [] },
  ];
  app.config.ai.decision = { provider: "a", model: "m-a", others: [{ provider: "b", model: "m-b" }, { provider: "c", model: "m-c" }, { provider: "b", model: "m-b" }], pick, fallback: "general", gatekeeper: true };
  setKey(app.home, "a", "k-a");
  setKey(app.home, "b", "k-b");
  return app;
}

type Reply = { status?: number; yes?: number; refuse?: boolean };
/** Answers by provider: 甲 is asked at /decisions, 乙 at /v1/systemone. Returns who was asked, in order. */
function answers(by: { a?: Reply; b?: Reply }) {
  const asked: string[] = [];
  setDecisionFetchForTests((async (url: string) => {
    const who = String(url).endsWith("/decisions") ? "a" : "b";
    asked.push(who);
    const r = by[who] ?? {};
    if (r.status) return new Response("{}", { status: r.status });
    if (who === "a") return new Response(JSON.stringify({ answers: [r.refuse ? { type: "refusal", name: "q" } : { type: "predicate", name: "q", probability: r.yes ?? 0.9 }] }));
    return new Response(JSON.stringify({ answers: { q: r.refuse ? { type: "refusal" } : { type: "noul", noul: r.yes ?? 0.9 } } }));
  }) as unknown as typeof fetch);
  return asked;
}
const q = { type: "yesno" as const, instructions: "要不要看" };

it("lists every named decision model once and is usable when any of them is", () => {
  const app = setup();
  const all = decisionStatuses(app.config, app.home);
  expect(all.map((s) => [s.provider, s.ready])).toEqual([["a", true], ["b", true], ["c", false]]);
  expect(categoryStatus(app.config, "decision", app.home)).toMatchObject({ ready: true, provider: "a", detail: "甲 · m-a 等 2 个" });
  // Only an unusable one named: says why.
  app.config.ai.decision = { provider: "c", model: "", fallback: "general", gatekeeper: true };
  expect(categoryStatus(app.config, "decision", app.home)).toMatchObject({ ready: false, detail: "丙 还没有填写 API key" });
  app.config.ai.decision = { provider: "", model: "", fallback: "general", gatekeeper: true };
  expect(categoryStatus(app.config, "decision", app.home)).toMatchObject({ ready: false, detail: "没有选择提供方" });
});

it("fixed: asks the first, passes over one that fails and keeps it at the back for a while", async () => {
  const app = setup();
  let asked = answers({ a: { yes: 0.8 } });
  expect((await decide(app, "材料", q))?.by).toBe("甲 · m-a");
  expect(asked).toEqual(["a"]);
  asked = answers({ a: { status: 500 }, b: { yes: 0.2 } });
  const r = await decide(app, "材料", q);
  expect(r).toMatchObject({ choice: "no" });
  expect(r?.by).toContain("乙 · m-b");
  expect(r?.by).toContain("甲 · m-a没答上");
  expect(asked).toEqual(["a", "b"]);
  // 甲 just failed: 乙 is asked first now, and 甲 not at all while 乙 answers.
  asked = answers({ b: { yes: 0.7 } });
  expect((await decide(app, "材料", q))?.by).toBe("乙 · m-b");
  expect(asked).toEqual(["b"]);
  expect(decisionOrder(app).map((s) => s.provider)).toEqual(["b", "a"]);
});

it("random: any usable one may go first, the others stay behind it", () => {
  const app = setup("random");
  expect(decisionOrder(app, () => 0).map((s) => s.provider)).toEqual(["a", "b"]);
  expect(decisionOrder(app, () => 0.99).map((s) => s.provider)).toEqual(["b", "a"]);
  app.config.ai.decision.pick = "fixed";
  expect(decisionOrder(app, () => 0.99).map((s) => s.provider)).toEqual(["a", "b"]);
});

it("a refusal moves on without setting the model aside; when none answers the last error is thrown; none usable is null", async () => {
  const app = setup();
  let asked = answers({ a: { refuse: true }, b: { yes: 0.9 } });
  expect((await decide(app, "材料", q))?.by).toContain("乙 · m-b");
  expect(asked).toEqual(["a", "b"]);
  expect(decisionOrder(app).map((s) => s.provider)).toEqual(["a", "b"]);
  asked = answers({ a: { status: 500 }, b: { status: 503 } });
  await expect(decide(app, "材料", q)).rejects.toThrow("503");
  expect(asked).toEqual(["a", "b"]);
  app.config.ai.decision = { provider: "c", model: "", fallback: "general", gatekeeper: true };
  expect(await decide(app, "材料", q)).toBeNull();
});
