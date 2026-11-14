import { afterEach, expect, it } from "vitest";
import { setKey } from "../src/core/ai-keys.ts";
import { one, run } from "../src/core/db.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { gateMaterial, heartbeatGate, keepSkipped, sweepDue, swept, type Fresh } from "../src/agents/heartbeat-gate.ts";
import { upsertItem } from "../src/items/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { setDecisionFetchForTests(null); for (const app of apps.splice(0)) app.db.close(); });

function setup() {
  const app = testApp(); apps.push(app);
  const chat = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_a", title: "项目 A 退款群", text: `${"早先的讨论。".repeat(60)}\n小王：审计材料已经发你邮箱了` });
  const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "doc:menu", title: "食堂本周菜单", text: "周一：番茄炒蛋。" });
  const waiting = upsertItem(app, undefined, { spaceId: "personal", title: "等小王补齐审计材料", kind: "waiting", waitingOn: "小王", sourceRefs: [`src:${chat.id}#L1-L2`] }, "user");
  const fresh: Fresh[] = [
    { id: doc.id, space_id: "personal", uri: "doc:menu", title: "食堂本周菜单", kind: "doc" },
    { id: chat.id, space_id: "personal", uri: "lark:oc_a", title: "项目 A 退款群", kind: "chat" },
  ];
  return { app, chat, doc, waiting, fresh };
}

function withDecision(app: ReturnType<typeof testApp>, probability: number, seen?: (body: string) => void) {
  app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
  setKey(app.home, "d", "key-1");
  let asked = 0;
  setDecisionFetchForTests((async (_u: string, init: RequestInit) => (asked++, seen?.(String(init.body)), new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability }] })))) as unknown as typeof fetch);
  return () => asked;
}

it("shows the decision model the items, each new source with a piece of it, and which source an item came from", () => {
  const { app, waiting, fresh } = setup();
  const m = gateMaterial(app, [waiting], fresh, [{ title: "简报 · 周一" }]);
  expect(m["关注和等待中的事项"]).toContain("[等待] 等小王补齐审计材料（等 小王）");
  const lines = m["上次巡检以来的新材料"].split("\n");
  // Where a waited-for item came from goes first, with the end of the chat (its newest lines).
  expect(lines[0]).toContain("项目 A 退款群");
  expect(lines[0]).toContain("事项「等小王补齐审计材料」的来源");
  expect(lines[0]).toContain("审计材料已经发你邮箱了");
  expect(lines[1]).toContain("食堂本周菜单");
  expect(lines[1]).toContain("番茄炒蛋");
  expect(m["这段时间已经发给本人的通知"]).toContain("简报 · 周一");
});

it("lets the agent look unless the decision model says there is nothing, and never skips what it could not show or judge", async () => {
  const { app, waiting, fresh } = setup();
  // No decision model: as before.
  expect(await heartbeatGate(app, [waiting], fresh, [])).toEqual({ look: true, why: "" });
  let body = "";
  const asked = withDecision(app, 0.08, (b) => (body = b));
  const no = await heartbeatGate(app, [waiting], fresh, []);
  expect(no.look).toBe(false);
  expect(no.why).toContain("不用看");
  expect(body).toContain("等小王补齐审计材料");
  expect(asked()).toBe(1);
  // Turned off: not asked.
  app.config.heartbeat.gate = "off";
  expect((await heartbeatGate(app, [waiting], fresh, [])).look).toBe(true);
  expect(asked()).toBe(1);
  app.config.heartbeat.gate = "decision";
  // More than it can be shown: handed over unasked.
  const many = Array.from({ length: 31 }, (_, i) => ({ ...fresh[0], id: `s_many_${i}` }));
  const over = await heartbeatGate(app, [waiting], many, []);
  expect(over.look).toBe(true);
  expect(over.why).toContain("31");
  expect(asked()).toBe(1);
  // "Yes" and a failing model both hand it over.
  withDecision(app, 0.9);
  expect((await heartbeatGate(app, [waiting], fresh, [])).look).toBe(true);
  setDecisionFetchForTests((async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
  const failed = await heartbeatGate(app, [waiting], fresh, []);
  expect(failed.look).toBe(true);
  expect(failed.why).toContain("预筛没成");
});

it("keeps what was skipped for a sweep after sweepHours, and forgets it once swept", () => {
  const { app, chat, doc, fresh } = setup();
  expect(sweepDue(app)).toEqual([]);
  keepSkipped(app, [fresh[0]]);
  keepSkipped(app, fresh);
  // Not yet: the first skip started the clock.
  expect(sweepDue(app)).toEqual([]);
  run(app.db, "update kv set value = ? where key = 'heartbeat_sweep_at'", new Date(Date.now() - 13 * 3600_000).toISOString());
  expect(sweepDue(app).map((s) => s.id).sort()).toEqual([chat.id, doc.id].sort());
  // A source deleted meanwhile is not handed over.
  run(app.db, "update sources set deleted_at = ? where id = ?", new Date().toISOString(), doc.id);
  expect(sweepDue(app).map((s) => s.id)).toEqual([chat.id]);
  // Handed nothing yet (the tick was full): the list stays and the sweep stays due.
  swept(app, []);
  expect(sweepDue(app).map((s) => s.id)).toEqual([chat.id]);
  swept(app, sweepDue(app));
  expect(sweepDue(app)).toEqual([]);
  expect(one<{ value: string }>(app.db, "select value from kv where key = 'heartbeat_skipped'")?.value).toBe("[]");
});
