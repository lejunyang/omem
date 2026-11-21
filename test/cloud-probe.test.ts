import { expect, it } from "vitest";
import { agentProfileSchema, cloudToolsSchema } from "../src/core/config.ts";
import { cloudAccess, cloudAddress, confirmProbe, probeCloud, probeReceipt } from "../src/agents/cloud-probe.ts";
import { testApp } from "./helpers.ts";

it("requires a confirmed callback and an independently returned receipt", async () => {
  const app = testApp();
  const profile = agentProfileSchema.parse({ transport: "doubao", id: "cloud-a", command: "unused" });
  app.config.agents.profiles = [profile];
  Object.assign(app.config.agents.cloudTools, { enabled: true, backends: [profile.id] });
  app.config.webUrl = "https://8.8.8.8";
  for (const expected of [false, "url", "header"] as const) {
    const probe = await probeCloud(app, profile.id, async (_app, _p, req) => {
      expect(req.mcp).toBeUndefined();
      const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
      const text = expected ? probeReceipt(app, nonce, expected === "header" ? nonce : "") : "";
      return { text, agent: "test", stopReason: "end_turn" };
    });
    expect(probe.mode).toBe(expected);
    expect(cloudAccess(app, profile).mode).toBeUndefined();
    if (expected) {
      confirmProbe(app, profile.id, probe.id);
      expect(cloudAccess(app, profile).reason).toContain("安全凭据通道");
      app.config.agents.cloudTools.credentialIn = "message";
      expect(cloudAccess(app, profile).mode).toBe(expected);
      app.config.agents.cloudTools.credentialIn = "channel";
    }
    expect(() => probeReceipt(app, probe.id, "")).toThrow("已结束");
  }
  app.db.close();
});

it("limits credentials to selected read tools and public HTTPS", () => {
  expect(cloudToolsSchema.parse({})).toMatchObject({ enabled: false, credentialIn: "channel", backends: [] });
  for (const bad of [{ tools: ["write_page"] }, { tools: ["peer_read"] }, { ttlMinutes: 31 }, { maxCalls: 0 }])
    expect(cloudToolsSchema.safeParse(bad).success).toBe(false);
  const app = testApp();
  for (const url of ["http://public.example.com", "https://localhost", "https://10.1.2.3", "https://[::1]", "https://x.local"]) {
    app.config.webUrl = url;
    expect(cloudAddress(app)).toBeNull();
  }
  app.db.close();
});
