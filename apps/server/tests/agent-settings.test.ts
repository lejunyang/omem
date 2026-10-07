import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AgentSettings, agentRoles } from "../src/agent-settings.js";
import {
  assistantProfile,
  knowledgeProfile,
  developmentProfiles,
  parseConfig,
  type Config,
} from "../src/config.js";
import { LearningPipeline } from "../src/learning/pipeline.js";
import { Store } from "../src/store.js";
import { MemoryService, FeedbackService } from "../src/memory/service.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omem-agent-settings-"));
  const input = {
    profiles: [
      {
        id: "custom",
        name: "Protocol fixture",
        transport: "acp",
        command: process.execPath,
        args: [resolve("apps/server/tests/fixtures/acp-agent.mjs")],
        model: "alpha",
        effort: "low",
      },
    ],
    assistant: { profileId: "custom" },
    learning: { enabled: false, profileId: "custom" },
    lark: { enabled: false },
    captureRoots: ["retained-root"],
  };
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(input));
  const config: Config = {
    ...parseConfig(input),
    configFile: file,
    dataDir: dir,
    agentCwd: join(dir, "agent"),
    host: "127.0.0.1",
    port: 0,
  };
  return { dir, file, config, settings: new AgentSettings(config) };
}
it("reads model-dependent effort options and distinguishes discovery from inference", async () => {
  const f = fixture();
  try {
    const alpha = await f.settings.probe({
      candidateId: "custom",
      model: "alpha",
      test: false,
    });
    expect(alpha.inference).toBe("untested");
    expect(alpha.effort.values.map((o) => o.value)).toEqual(["low"]);
    const beta = await f.settings.probe({
      candidateId: "custom",
      model: "beta",
      effort: "high",
      test: true,
    });
    expect(beta.inference).toBe("passed");
    expect(beta.effort.values.map((o) => o.value)).toEqual(["low", "high"]);
    await expect(
      f.settings.probe({
        candidateId: "custom",
        model: "alpha",
        effort: "high",
        test: false,
      }),
    ).rejects.toThrow("Unsupported reasoning_effort");
    expect(f.settings.status().configured).toBe(false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it("persists independent role selections, changes live configuration and preserves unrelated switches", async () => {
  const f = fixture();
  try {
    const roles = Object.fromEntries(
      agentRoles.map((r) => [
        r,
        {
          candidateId: "custom",
          model: r === "assistant" ? "alpha" : "beta",
          effort: r === "assistant" ? "low" : "high",
        },
      ]),
    ) as Parameters<AgentSettings["save"]>[0]["roles"];
    const status = await f.settings.save({ roles });
    expect(status.configured).toBe(true);
    expect(assistantProfile(f.config)?.model).toBe("alpha");
    expect(knowledgeProfile(f.config)?.model).toBe("beta");
    expect(developmentProfiles(f.config)?.coding.effort).toBe("high");
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    expect(saved.learning.enabled).toBe(false);
    expect(saved.lark.enabled).toBe(false);
    expect(saved.captureRoots).toEqual(["retained-root"]);
    expect(saved).not.toHaveProperty("dataDir");
    expect(parseConfig(saved).assistant?.profileId).toBe("omem-assistant");
    expect(JSON.stringify(status)).not.toContain("acp-agent.mjs");
    const store = new Store(join(f.dir, "learning"));
    try {
      // A trusted role selection no longer needs the literal profile ID traex.
      const pipeline = new LearningPipeline({
        store,
        memory: new MemoryService(store),
        feedback: new FeedbackService(store),
        profile: f.config.profiles.find((p) => p.id === "omem-learning")!,
        workspaceRoot: f.config.agentCwd,
      });
      await pipeline.stop();
    } finally {
      store.close();
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it("an unsupported role selection leaves disk and live settings untouched", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.file, "utf8");
    const roles = Object.fromEntries(
      agentRoles.map((r) => [
        r,
        { candidateId: "custom", model: "alpha", effort: "high" },
      ]),
    ) as Parameters<AgentSettings["save"]>[0]["roles"];
    await expect(f.settings.save({ roles })).rejects.toThrow(
      "Unsupported reasoning_effort",
    );
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(assistantProfile(f.config)?.id).toBe("custom");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
