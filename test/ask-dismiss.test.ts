import { describe, expect, it } from "vitest";
import { createAsk, getAsk } from "../src/agents/asks.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("the owner drops a question they do not need answered", () => {
  it("closes an agent's question as lapsed, and leaves the host's decision cards to be answered", async () => {
    const app = testApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
      const plain = createAsk(app, { runId: null, userId: "owner", question: "下一步要不要整理成草稿？", options: [{ label: "整理" }], allowText: false });
      const gate = createAsk(app, { runId: null, userId: "owner", question: "轮到「验收」了，开始吗？", options: [{ label: "开始" }], allowText: false, context: { handler: "flow-stage" } });
      const dismiss = (id: string) => fetch(`${base}/api/asks/${id}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect((await dismiss(plain.id)).status).toBe(200);
      expect(getAsk(app, plain.id).status).toBe("cancelled");
      expect((await dismiss(plain.id)).status).toBe(409);
      expect((await dismiss(gate.id)).status).toBe(409);
      expect(getAsk(app, gate.id).status).toBe("pending");
    } finally {
      await server.close();
    }
  });

  it("restates a waiting question in sections, and refuses a wall of text", async () => {
    const app = testApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
      const a = createAsk(app, { runId: null, userId: "owner", question: "要不要改？", options: [{ label: "改" }], allowText: true });
      const say = (question: string) => fetch(`${base}/api/asks/${a.id}/question`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      expect((await say("退款金额算错了，原因在订单行的运费分摊。".repeat(30))).status).toBe(400);
      const ok = "退款金额按行算还是按单算？\n\n**现在**\n按单算，部分退款时运费退多了。\n\n**做法**\n- 按行算（推荐）：运费按金额比例退";
      expect((await say(ok)).status).toBe(200);
      expect(getAsk(app, a.id)).toMatchObject({ status: "pending", question: ok, options: [{ label: "改" }] });
    } finally {
      await server.close();
    }
  });
});
