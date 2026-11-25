import { fakeCloudReceipt } from "./fake-cloud-probe.ts";
import { expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { agentProfileSchema, roleNames, type RoleName } from "../src/core/config.ts";
import type { RunKind } from "../src/agents/runs.ts";
import { prepareRun, type PreparedRun } from "../src/agents/runner.ts";
import { seedBuiltinSkills } from "../src/agents/specs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { testApp } from "./helpers.ts";

// Measurements with the fixed fixture below. The shell bridge preamble is 39 characters
// longer than MCP's. Allow each measurement up to 64 extra characters across all five blocks.
// Re-measured affected roles after integrating quiet outcomes, change receipts and the new role sections.
const measured: Record<RoleName, [kind: RunKind, mcpChat: number, mcpBackground: number, noneChat: number, noneBackground: number]> = {
  "commit-claim": ["commit-claim", 4630, 4735, 2206, 2206],
  // The item-follow role now classifies actual next steps and records their completion conditions.
  "item-follow": ["item-follow", 5978, 6083, 3576, 3576],
  // 实测：加上“等外部恢复 / 助手能做 / 只有本人能做”三种下一步的分法之后。
  "flow-reconcile": ["flow-reconcile", 5806, 5806, 3126, 3126],
  // Mid-round branch sync: the assistant passes `sync` and waits on the round, the coder calls sync_branch.
  // 情境 became 持续跟进的规则: the assistant's note on save_situation says what to call it with the owner.
  // 实测 2026-11-25：中途交付和编码补充的说明已计入。
  "assistant": ["agent", 20690, 19991, 1679, 1581],
  "ingest": ["ingest", 10342, 10251, 4763, 4763],
  "archivist": ["archive", 4743, 4743, 2570, 2570],
  "archive-rule-writer": ["archive-rule-draft", 3091, 3091, 2091, 2091],
  "wiki-planner": ["wiki-plan", 5896, 5896, 3723, 3723],
  "wiki-writer": ["wiki-write", 6090, 6090, 3722, 3722],
  "wiki-linter": ["wiki-lint", 5111, 5216, 2492, 2492],
  "wiki-organizer": ["wiki-organize", 4349, 4454, 2446, 2446],
  "wiki-checker": ["wiki-write", 6403, 6403, 4035, 4035],
  "heartbeat": ["heartbeat", 7546, 7455, 3407, 3407],
  "dreamer": ["dream", 10446, 10250, 4908, 4908],
  // 实测 2026-11-25：同一会话处理同步冲突后，固定场景为 7344 / 2915 字符（不含专用交办工具）。
  "coder": ["code", 7344, 7344, 2915, 2915],
  "reviewer": ["review", 4762, 4762, 2589, 2589],
  "tutor": ["tutor", 4513, 4513, 1954, 1954],
  "brief": ["brief", 7971, 7775, 3732, 3732],
  "curator": ["curate", 5597, 5506, 1821, 1821],
  "triager": ["triage", 4935, 5040, 2511, 2511],
  "distiller": ["digest", 8292, 8397, 3484, 3484],
  "summarizer": ["thread-summary", 2851, 2851, 1851, 1851],
  "memory-reviewer": ["memory-review", 5097, 5097, 2538, 2538],
  "note-reviewer": ["note-review", 4923, 4923, 2750, 2750],
  "memory-organizer": ["memory-organize", 4601, 4706, 2312, 2312],
  "skill-organizer": ["skill-organize", 3830, 3935, 2579, 2579],
  "item-keeper": ["item-settle", 5557, 5466, 2167, 2167],
  "coach": ["profile-review", 6521, 6686, 1704, 1704],
  "gatekeeper": ["guest", 3313, 3313, 2313, 2313],
  "guest": ["guest", 3907, 3907, 2003, 2003],
  "review-business": ["review", 4815, 4815, 2256, 2256],
  "review-arch": ["review", 4797, 4797, 2238, 2238],
  "review-style": ["review", 4958, 4958, 2785, 2785],
  "review-history": ["review", 4629, 4629, 2070, 2070],
  "review-simplify": ["review", 5562, 5562, 3389, 3389],
  // 实测：共同说明加了“什么算评审问题”、负责人接受前先核对触发前提之后。
  "review-lead": ["review", 6712, 6712, 4138, 4138],
  "replay-judge": ["replay-judge", 3442, 3442, 2442, 2442],
  "kb-scout": ["kb-scout", 4766, 4766, 2728, 2728],
  "req-splitter": ["req-split", 5988, 5988, 3429, 3429],
  "business-analyst": ["code", 5326, 5326, 2767, 2767],
  "designer": ["design", 5875, 5875, 3200, 3200],
  "mention-triage": ["mention", 3242, 3242, 2242, 2242],
  "work-state": ["work-state", 6510, 6510, 3951, 3951],
  "listen-coach": ["listen-coach", 6049, 6154, 3044, 3044],
  "outcome-reviewer": ["outcome-review", 4925, 4925, 2752, 2752],
  // 实测：首句、短要点和改写对照后，MCP 为 4822 字符，无工具为 2248。
  "first-look": ["first-look", 4822, 4822, 2248, 2248],
};

function checkBudget(prep: PreparedRun, measuredSize: number, role: RoleName) {
  const largest = Object.entries(prep.parts).filter(([name]) => name !== "lessonCount").sort((a, b) => b[1] - a[1]).slice(0, 3);
  const target = measuredSize + 64;
  expect.soft(prep.system.length, JSON.stringify({ role, scene: prep.scene, access: prep.capabilities.omemAccess, target, largest })).toBeLessThanOrEqual(target);
}

it("bounds standing instructions for a fixed space, skill library and four lessons", () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  createSpace(app, { id: "project-a", name: "项目 A" });
  seedBuiltinSkills(app, process.cwd());
  const lessons = "- 偏好：直接回答。\n- 偏好：日期写全。\n- 偏好：列出依据。\n- 经验：先核对版本。";
  for (const transport of ["acp", "doubao-cli", "doubao"] as const) {
    const profile = agentProfileSchema.parse({ id: "candidate", command: "test", transport });
    app.config.agents.profiles = [profile];
    for (const role of roleNames) {
      const [kind, mcpChat, mcpBackground, noneChat, noneBackground] = measured[role];
      for (const chat of [true, false]) {
        const scene = { chat, kind: chat ? "ask" as const : kind, awareness: chat };
        const prep = prepareRun(app, { actor: { role }, profileId: profile.id, spaceId: "project-a", runId: null, lessons, scene });
        revokeToolToken(prep.token);
        const mcp = chat ? mcpChat : mcpBackground;
        const none = chat ? noneChat : noneBackground;
        checkBudget(prep, transport === "doubao" ? none : mcp + (transport === "doubao-cli" ? 39 : 0), role);
        if (transport === "doubao") {
          expect(prep.system).toContain("## 引用");
          expect(prep.system).not.toContain('omem_help("');
        }
      }
    }
  }
  app.db.close();
});

it("bounds the HTTP instructions for each cloud role including every allowed tool", async () => {
  const { confirmProbe, probeCloud } = await import("../src/agents/cloud-probe.ts");
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  app.config.webUrl = "https://8.8.8.8";
  const cfg = app.config.agents.cloudTools;
  cfg.backends = ["doubao"];
  cfg.tools = ["search", "read_source", "read_page", "read_item"];
  cfg.credentialIn = "message";
  const probe = await probeCloud(app, "doubao", async (_app, _p, req) => {
    const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
    return { text: fakeCloudReceipt(app, nonce, "header"), agent: "test", stopReason: "end_turn" };
  });
  confirmProbe(app, "doubao", probe.id);
  // 实测 2026-11-25：补充部分推送的说明后，助手的 HTTP 指令为 1796 / 1698 字符。
  const http = { assistant: [1796, 1698], gatekeeper: [2328, 2328], summarizer: [1866, 1866], "replay-judge": [2457, 2457], "mention-triage": [2257, 2257] } as const;
  for (const role of Object.keys(http) as (keyof typeof http)[]) {
    for (const chat of [true, false]) {
      const scene = { chat, kind: chat ? "ask" as const : measured[role][0], awareness: chat };
      const prepare = () => prepareRun(app, { actor: { role }, profileId: "doubao", spaceId: "personal", runId: "budget", scene });
      cfg.enabled = false;
      const off = prepare();
      expect(off.capabilities.omemAccess).toBe("none");
      cfg.enabled = true;
      const on = prepare();
      expect(on.capabilities.omemAccess).toBe("http");
      expect(on.system).toContain("## 云端工具");
      expect(on.parts.common - off.parts.common).toBeLessThan(400);
      checkBudget(on, http[role][chat ? 0 : 1], role);
      revokeToolToken(off.token);
      revokeToolToken(on.token);
    }
  }
  app.db.close();
});
