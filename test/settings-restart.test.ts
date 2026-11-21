import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("PUT /api/settings", () => {
  it("round-trips several decision models and their individual readiness", async () => {
    const app = testApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const decision = { ...app.config.ai.decision, provider: "first", model: "m-first", others: [{ provider: "second", model: "m-second" }], pick: "random" };
      const providers = ["first", "second"].map((id) => ({ id, kind: "typesafe", name: id, backends: [] }));
      setKey(app.home, "second", "test-key");
      const saved = await server.inject({ method: "PUT", url: "/api/settings", payload: { ai: { ...app.config.ai, decision, providers } } });
      expect(saved.statusCode).toBe(200);
      expect((await server.inject({ url: "/api/settings" })).json().config.ai.decision).toEqual(decision);
      const view = (await server.inject({ url: "/api/ai" })).json();
      expect(view.status.decision.ready).toBe(true);
      expect(view.decisionModels).toMatchObject([{ provider: "first", model: "m-first", ready: false }, { provider: "second", model: "m-second", ready: true }]);
      setDecisionFetchForTests((async (_url, init) => {
        expect(JSON.parse(String(init?.body)).model).toBe("m-second");
        return Response.json({ answers: { q: { type: "noul", noul: 0.9 } } });
      }) as typeof fetch);
      const trial = await server.inject({ method: "POST", url: "/api/ai/decision/test", payload: { provider: "second", model: "m-second", material: "示例材料", question: "是否继续？" } });
      expect(trial.statusCode).toBe(200);
      expect(trial.json().by).toContain("m-second");
      expect(app.config.ai.decision).toEqual(decision);
    } finally {
      setDecisionFetchForTests(null);
      await server.close();
      app.db.close();
    }
  });
  it("设置可保存任意有限的插件门槛，保留本地门槛", async () => {
    const app = testApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      for (const pluginPassiveThreshold of [-2, 4, 0]) {
        const rerank = { ...app.config.rerank, provider: "plugin:demo:rank", pluginPassiveThreshold };
        const saved = await server.inject({ method: "PUT", url: "/api/settings", payload: { rerank } });
        expect(saved.statusCode).toBe(200);
        expect((await server.inject({ url: "/api/settings" })).json().config.rerank).toEqual(rerank);
        expect((await server.inject({ url: "/api/search/providers" })).json().config.rerank).toEqual(rerank);
        expect(loadConfig(app.home).rerank).toEqual(rerank);
      }
    } finally {
      await server.close();
      app.db.close();
    }
  });
  it("names only the changed settings that are read at startup", async () => {
    const app = testApp();
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const live = await server.inject({ method: "PUT", url: "/api/settings", payload: { concurrency: 3, agents: { ...app.config.agents, queueTimeoutMinutes: 60 } } });
      expect(live.json().restart).toEqual([]);
      expect(app.config.concurrency).toBe(3);
      const same = await server.inject({ method: "PUT", url: "/api/settings", payload: { embeddings: app.config.embeddings } });
      expect(same.json().restart).toEqual([]);
      const changed = await server.inject({ method: "PUT", url: "/api/settings", payload: { port: app.config.port + 1, lark: { ...app.config.lark, enabled: !app.config.lark.enabled } } });
      expect(changed.json().restart).toEqual(["监听地址和端口", "飞书机器人的开关和应用"]);
    } finally {
      await server.close();
      app.db.close();
    }
  });
});
