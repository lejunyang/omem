import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { getRun } from "../src/agents/runs.ts";
import { getThread } from "../src/agents/threads.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => {
  app.db.close();
  rmSync(app.home, { recursive: true, force: true });
});

describe("long questions", () => {
  it("keep more of the message in the titles and show the whole question on the run page", async () => {
    const text = "退款改造里，" + "已发货的订单行要不要也允许部分退款，需要看一下现在的规则和上周讨论的结论。".repeat(6);
    const r = await receive(app, { channel: "web", text, mergeMs: 0 });
    const run = getRun(app, r.runId!);
    expect(run.title.length).toBeGreaterThan(100);
    expect(run.title.length).toBeLessThanOrEqual(200);
    expect(getThread(app, r.thread.id).title.length).toBe(120);
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const res = await server.inject({ url: `/api/runs/${run.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().context.question).toBe(text);
    } finally { await server.close(); }
  });
});
