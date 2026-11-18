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
});
