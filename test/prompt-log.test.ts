import { existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptOfEvent, prunePromptLog } from "../src/agents/prompt-log.ts";
import { addRunEvent, createRun, runEvents } from "../src/agents/runs.ts";
import { sessionPrompt } from "../src/agents/types.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).flatMap((sub) => readdirSync(join(dir, sub)).map((f) => join(dir, sub, f))) : []);

describe("prompt log", () => {
  it("keeps what a turn sent and gives it back by run and event", () => {
    const app = testApp();
    const run = createRun(app, { kind: "agent", spaceId: "personal", title: "t", input: {} });
    const record = (e: AgentEvent) => addRunEvent(app, run.id, e.type, e);
    const system = "# 共同约定\n\n先读再写\n\n---\n\n# 角色：助手\n\n回答问题";
    sessionPrompt({ resumed: false }, { system }, "（现在）\n\n# 任务\n\n查一下", record);
    sessionPrompt({ resumed: true }, { system }, "接着查", record);

    const events = runEvents(app, run.id).filter((e) => e.type === "prompt");
    expect(events).toHaveLength(2);
    // The stored event carries hashes, not the texts.
    expect(JSON.stringify(events)).not.toContain("先读再写");
    expect((events[0].data as { kept?: { system?: string } }).kept?.system).toMatch(/^[0-9a-f]{32}$/);

    const first = promptOfEvent(app, run.id, events[0].seq)!;
    expect(first).toMatchObject({ via: "message", systemSent: true, system, message: "（现在）\n\n# 任务\n\n查一下", kept: true, expired: false });
    const second = promptOfEvent(app, run.id, events[1].seq)!;
    expect(second).toMatchObject({ via: "resumed", systemSent: false, system, message: "接着查" });
    // The same instructions are one file however many turns carried them.
    expect(files(join(app.home, "prompt-log"))).toHaveLength(3);
    expect(promptOfEvent(app, run.id, 9999)).toBeNull();
  });

  it("drops the texts when the log is off, and prunes what was not used for a while", () => {
    const app = testApp();
    const run = createRun(app, { kind: "agent", spaceId: "personal", title: "t", input: {} });
    const record = (e: AgentEvent) => addRunEvent(app, run.id, e.type, e);
    sessionPrompt({ resumed: false }, { system: "说明" }, "任务一", record);
    const dir = join(app.home, "prompt-log");
    const old = new Date(Date.now() - 20 * 86_400_000);
    for (const f of files(dir)) utimesSync(f, old, old);
    // Used again by a later turn: the instructions stay, the old message goes.
    sessionPrompt({ resumed: false }, { system: "说明" }, "任务二", record);
    expect(prunePromptLog(app)).toBe(1);
    const [a, b] = runEvents(app, run.id).filter((e) => e.type === "prompt");
    expect(promptOfEvent(app, run.id, a.seq)).toMatchObject({ system: "说明", message: null, expired: true });
    expect(promptOfEvent(app, run.id, b.seq)).toMatchObject({ system: "说明", message: "任务二", expired: false });

    app.config.agents.promptLog.enabled = false;
    sessionPrompt({ resumed: false }, { system: "说明" }, "任务三", record);
    const last = runEvents(app, run.id).filter((e) => e.type === "prompt").at(-1)!;
    expect(JSON.stringify(last)).not.toContain("任务三");
    expect(promptOfEvent(app, run.id, last.seq)).toMatchObject({ kept: false, system: null, message: null });
  });
});
