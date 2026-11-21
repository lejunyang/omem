import { expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { agentProfileSchema, type RoleName } from "../src/core/config.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { seedBuiltinSkills } from "../src/agents/specs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { testApp } from "./helpers.ts";

it("bounds standing instructions for a fixed space, skill library and four lessons", () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  createSpace(app, { id: "project-a", name: "项目 A" });
  seedBuiltinSkills(app, process.cwd());
  const lessons = "- 偏好：直接回答。\n- 偏好：日期写全。\n- 偏好：列出依据。\n- 经验：先核对版本。";
  type Budget = { role: RoleName; target: number; temporaryLimit?: number };
  const budgets: Record<"acp" | "doubao-cli" | "doubao", Budget[]> = {
    acp: [
      { role: "assistant", target: 34976 },
      { role: "item-keeper", target: 6090 },
      { role: "memory-reviewer", target: 5879 },
    ],
    "doubao-cli": [
      { role: "assistant", target: 35055 },
      { role: "item-keeper", target: 6169 },
      { role: "memory-reviewer", target: 5958 },
    ],
    // No tools on this kind of backend: every section about a tool is gone (measured 1,851–2,442 after the role files were split).
    doubao: [
      { role: "assistant", target: 3000 },
      { role: "gatekeeper", target: 3000 },
      { role: "replay-judge", target: 3000 },
      { role: "summarizer", target: 3000 },
      { role: "mention-triage", target: 3000 },
    ],
  };
  for (const [transport, roles] of Object.entries(budgets)) {
    const profile = agentProfileSchema.parse({ id: "candidate", command: "test", transport });
    app.config.agents.profiles = [profile];
    for (const { role, target, temporaryLimit } of roles) {
      const prep = prepareRun(app, { actor: { role }, profileId: profile.id, spaceId: "project-a", runId: null, lessons });
      revokeToolToken(prep.token);
      const largest = Object.entries(prep.parts).filter(([k]) => k !== "lessonCount").sort((a, b) => b[1] - a[1]).slice(0, 3);

      expect.soft(prep.system.length, JSON.stringify({ transport, role, target, temporaryLimit, largest })).toBeLessThanOrEqual(temporaryLimit ?? target);
    }
  }
  app.db.close();
});

it("bounds the HTTP instructions for each cloud role including every allowed tool", async () => {
  const { confirmProbe, probeCloud, probeReceipt } = await import("../src/agents/cloud-probe.ts");
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  app.config.webUrl = "https://8.8.8.8";
  const cfg = app.config.agents.cloudTools;
  cfg.backends = ["doubao"];
  cfg.tools = ["search", "read_source", "read_page", "read_item"];
  cfg.credentialIn = "message";
  const probe = await probeCloud(app, "doubao", async (_app, _p, req) => {
    const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
    return { text: probeReceipt(app, nonce, nonce), agent: "test", stopReason: "end_turn" };
  });
  confirmProbe(app, "doubao", probe.id);
  for (const role of ["assistant", "gatekeeper", "summarizer", "replay-judge", "mention-triage"] as const) {
    const prepare = () => prepareRun(app, { actor: { role }, profileId: "doubao", spaceId: "personal", runId: "budget" });
    cfg.enabled = false;
    const off = prepare();
    expect(off.capabilities.omemAccess).toBe("none");
    cfg.enabled = true;
    const on = prepare();
    expect(on.capabilities.omemAccess).toBe("http");
    expect(on.system).toContain("云端只读工具");
    expect(on.parts.common - off.parts.common).toBeLessThan(400);
    expect(on.system.length).toBeLessThan(3400);
    revokeToolToken(off.token);
    revokeToolToken(on.token);
  }
  app.db.close();
});
