import { fakeCloudReceipt } from "./fake-cloud-probe.ts";
import { expect, it } from "vitest";
import { agentProfileSchema, cloudToolsSchema } from "../src/core/config.ts";
import { checkCloudAddress, cloudAccess, cloudAddress, confirmProbe, probeCloud, probeReceipt } from "../src/agents/cloud-probe.ts";
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
      const text = expected ? fakeCloudReceipt(app, nonce, expected) : "";
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

it.each(["GET only", "stripped Authorization", "missing JSON", "missing receipt", "URL without arguments"])(
  "rejects an incomplete probe (%s)", async limitation => {
    const app = testApp();
    app.config.webUrl = "https://8.8.8.8";
    const probe = await probeCloud(app, "doubao", async (_app, _profile, req) => {
      const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
      const auth = limitation === "URL without arguments" ? undefined : "Bearer probe-" + nonce;
      const { next } = probeReceipt(app, nonce, "GET", auth);
      const call = () => probeReceipt(app, next!.split("/").pop()!, auth ? "POST" : "GET",
        limitation === "stripped Authorization" ? undefined : auth, limitation === "missing JSON" || !auth ? {} : { probe: nonce });
      if (limitation === "missing receipt") call();
      else if (limitation !== "GET only") expect(call).toThrow();
      return { text: "", agent: "test", stopReason: "end_turn" };
    });
    expect(probe.mode).toBe(false);
    expect(probe.reason).toMatch(/Authorization|JSON|回执/);
    app.db.close();
  });

it.each(["Bearer probe-wrong", ""])("rejects an incorrect Authorization value on the initial GET (%j)", async authorization => {
  const app = testApp();
  app.config.webUrl = "https://8.8.8.8";
  try {
    const probe = await probeCloud(app, "doubao", async (_app, _profile, req) => {
      const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
      expect(() => probeReceipt(app, nonce, "GET", authorization)).toThrow("Authorization 测试值不匹配");
      return { text: "", agent: "test", stopReason: "end_turn" };
    });
    expect(probe).toMatchObject({ mode: false, reason: "首个 GET 的 Authorization 测试值不匹配" });
  } finally { app.db.close(); }
});

it("limits credentials to selected read tools and public HTTPS", () => {
  expect(cloudToolsSchema.parse({})).toMatchObject({ enabled: false, credentialIn: "channel", backends: [] });
  for (const bad of [{ tools: ["write_page"] }, { tools: ["peer_read"] }, { ttlMinutes: 31 }, { maxCalls: 0 }])
    expect(cloudToolsSchema.safeParse(bad).success).toBe(false);
  // A study stage hands its result in with these; a run gets them only when its own tool list has them.
  expect(cloudToolsSchema.safeParse({ tools: ["search", "read_ledger", "propose_directions", "trial_report", "record_finding", "close_direction"] }).success).toBe(true);
  const app = testApp();
  for (const url of ["http://public.example.com", "https://localhost", "https://10.1.2.3", "https://[::1]", "https://x.local"]) {
    app.config.webUrl = url;
    expect(cloudAddress(app)).toBeNull();
  }
  app.db.close();
});

it("takes an internal http address only when the owner allows it, and still checks it resolves", async () => {
  expect(cloudToolsSchema.parse({}).privateAddress).toBe(false);
  const app = testApp();
  try {
    app.config.webUrl = "http://10.1.2.3:4317/";
    expect(cloudAddress(app)).toBeNull();
    await expect(checkCloudAddress(app, "http://10.1.2.3:4317")).rejects.toThrow("公网");
    app.config.agents.cloudTools.privateAddress = true;
    expect(cloudAddress(app)).toBe("http://10.1.2.3:4317");
    await expect(checkCloudAddress(app, "http://10.1.2.3:4317")).resolves.toBeUndefined();
    // Credentials, a query or another scheme stay refused either way.
    for (const url of ["http://u:p@10.1.2.3:4317", "http://10.1.2.3:4317/?x=1", "ftp://10.1.2.3"]) {
      app.config.webUrl = url;
      expect(cloudAddress(app)).toBeNull();
    }
  } finally { app.db.close(); }
});
