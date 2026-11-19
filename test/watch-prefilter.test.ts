import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { setKey } from "../src/core/ai-keys.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { prefilterBatch } from "../src/channels/lark-watch.ts";
import { saveContext } from "../src/channels/listen.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { setDecisionFetchForTests(null); for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); } });

it("screens a watched group's batch with the decision model: chatter is skipped, an @ always goes through, and it can be turned off", async () => {
  const app = testApp(); apps.push(app);
  const ctx = saveContext(app, { kind: "place", name: "项目 A 值班群", chats: ["oc_ops"], note: "有人报线上问题时帮我查", knobs: { reply: "none", batchMinutes: 5 } });
  const conv = { id: ctx.conversationId! };
  const chatter = [{ text: "稍等，重新部署中", meta: { speaker: "小王" } }];
  // No decision model: nothing screened.
  expect(await prefilterBatch(app, conv.id, chatter)).toBeNull();
  app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
  setKey(app.home, "d", "key-1");
  let asked = 0;
  setDecisionFetchForTests((async () => (asked++, new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.1 }] })))) as unknown as typeof fetch);
  expect(await prefilterBatch(app, conv.id, chatter)).toContain("不用看");
  // Addressed to the owner or the bot: handed over without asking.
  expect(await prefilterBatch(app, conv.id, [{ text: "@本人 线上报错", meta: { speaker: "小王", addressed: true } }])).toBeNull();
  expect(asked).toBe(1);
  setDecisionFetchForTests(async () => new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.44 }] })));
  const reason = vi.fn();
  expect(await prefilterBatch(app, conv.id, chatter, undefined, { ref: "run-demo", reason })).toBeNull();
  expect(reason.mock.calls[0][0]).toContain("把握不到 0.6，按要看处理");
  // Off for this watch, then off for all.
  saveContext(app, { id: ctx.id, kind: "place", knobs: { prefilter: false } });
  expect(await prefilterBatch(app, conv.id, chatter)).toBeNull();
  saveContext(app, { id: ctx.id, kind: "place", knobs: { prefilter: undefined } });
  app.config.lark.watchPrefilter = false;
  expect(await prefilterBatch(app, conv.id, chatter)).toBeNull();
  // A failing model hands the batch over.
  app.config.lark.watchPrefilter = true;
  setDecisionFetchForTests((async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
  expect(await prefilterBatch(app, conv.id, chatter)).toBeNull();
});

it("gives the decision model the context: the owner's words here, rules on the group, earlier group lines", async () => {
  const app = testApp(); apps.push(app);
  const { addMessage } = await import("../src/agents/threads.ts");
  const { saveRule } = await import("../src/rules/store.ts");
  const { OWNER } = await import("../src/core/users.ts");
  const ctx = saveContext(app, { kind: "place", name: "项目 A 答疑群", chats: ["oc_help"], note: "帮群里的人解答接口问题", knobs: { reply: "auto", batchMinutes: 5 } });
  const conv = { id: ctx.conversationId! };
  addMessage(app, conv.id, "user", "退款相关的问题都帮他们查一下", null, {});
  addMessage(app, conv.id, "user", "这个接口返回 403 是怎么回事", null, { speaker: "小王" });
  saveRule(app, { name: "答疑群报错", description: "答疑群里有人贴报错就查日志", enabled: true, trigger: { event: "message" }, conditions: { all: [{ field: "chat.id", op: "equals", value: "oc_help" }] }, judge: "code", actions: [{ type: "notify" }] } as never, "user", OWNER);
  app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
  setKey(app.home, "d", "key-1");
  let body = "";
  setDecisionFetchForTests((async (_u: string, init: RequestInit) => ((body = String(init.body)), new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.9 }] })))) as unknown as typeof fetch);
  expect(await prefilterBatch(app, conv.id, [{ text: "能帮忙看下吗", meta: { speaker: "小李" } }])).toBeNull();
  expect(body).toContain("退款相关的问题都帮他们查一下");
  expect(body).toContain("答疑群报错");
  expect(body).toContain("这个接口返回 403");
  expect(body).toContain("帮群里的人解答接口问题");
});
