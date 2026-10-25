import { describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import type { AgentProfile } from "../src/core/config.ts";
import { acquire, excluded, holdForRun, limitOf, releaseRun, sourceOf, usedOf } from "../src/agents/capacity.ts";

const fakeApp = (perModel: number, limits: { profile: string; model?: string; max: number }[] = []) =>
  ({ config: { agents: { capacity: { perModel, limits } } } }) as unknown as App;
const p = (id: string, model?: string, source?: string): AgentProfile => ({ id, transport: "acp", command: id, args: [], env: {}, idleTimeoutMs: 1000, model, source });

describe("model capacity", () => {
  it("waits for a slot on a full model and takes it when one is released", async () => {
    const app = fakeApp(1);
    const a = await acquire(app, [p("codex", "m1")], { runId: "r1" });
    let waited = "";
    let got = false;
    const second = acquire(app, [p("codex", "m1")], { runId: "r2", onWait: (t) => { waited = t; } }).then((s) => { got = true; return s; });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBe(false);
    expect(waited).toMatch(/codex · m1 1\/1/);
    a.release();
    (await second).release();
    expect(got).toBe(true);
    expect(usedOf(app, p("codex", "m1"))).toBe(0);
  });

  it("moves to the first alternative with room, and never to one set to 0", async () => {
    const app = fakeApp(1, [{ profile: "traex", model: "cheap", max: 0 }]);
    const hold = await acquire(app, [p("codex", "m1")], { runId: "r1" });
    const s = await acquire(app, [p("codex", "m1"), p("traex", "cheap"), p("traex", "good")], { runId: "r2" });
    expect(s.index).toBe(2);
    expect(excluded(app, p("traex", "cheap"))).toBe(true);
    // Pinned to an excluded model only: it runs anyway.
    expect((await acquire(app, [p("traex", "cheap")], { runId: "r3" })).index).toBe(0);
    hold.release();
    s.release();
  });

  it("counts an ACP agent and its CLI fallback as one account, and caps a backend across its models", async () => {
    const app = fakeApp(2, [{ profile: "codex", max: 2 }, { profile: "codex", model: "m1", max: 1 }]);
    expect(sourceOf(p("codex-cli"))).toBe("codex");
    expect(limitOf(app, p("codex", "m1"))).toBe(1);
    expect(limitOf(app, p("codex", "m2"))).toBe(2);
    const a = await acquire(app, [p("codex", "m1")], { runId: "r1" });
    holdForRun(app, p("codex-cli", "m2", "codex"), "turn");
    let got = false;
    const third = acquire(app, [p("codex", "m2")], { runId: "r3" }).then((s) => { got = true; return s; });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBe(false); // backend total 2 reached (m1 + the CLI turn on m2)
    releaseRun("turn");
    (await third).release();
    a.release();
  });

  it("gives up waiting when the run is cancelled", async () => {
    const app = fakeApp(1);
    const a = await acquire(app, [p("codex", "m1")], { runId: "r1" });
    const ctrl = new AbortController();
    const w = acquire(app, [p("codex", "m1")], { runId: "r2", signal: ctrl.signal });
    ctrl.abort();
    await expect(w).rejects.toThrow("CANCELLED");
    a.release();
  });
});
