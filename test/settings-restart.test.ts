import { describe, expect, it } from "vitest";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("PUT /api/settings", () => {
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
