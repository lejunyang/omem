import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { boot } from "../src/main.ts";
import { issueToolToken } from "../src/agents/tools.ts";
import { createRun, runEvents } from "../src/agents/runs.ts";

describe("tool calls from outside the process", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-trace-"));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const call = (token: string, name: string, body: unknown) =>
    fetch(`${app.baseUrl}/api/tools/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("records on the run when each call arrives and returns, and says so when a token is unknown", async () => {
    const run = createRun(app, { kind: "agent", spaceId: "personal", title: "排查", input: {} });
    const token = issueToolToken({ runId: run.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" });
    expect((await call(token, "omem_call", { tool: "list_spaces", args: {} })).status).toBe(200);
    const calls = runEvents(app, run.id).filter((e) => e.type === "tool-call").map((e) => e.data as { name: string; phase: string; ok?: boolean; ms?: number });
    expect(calls).toMatchObject([{ name: "omem_call → list_spaces", phase: "start" }, { name: "omem_call → list_spaces", phase: "end", ok: true }]);
    expect(calls[1].ms).toBeGreaterThanOrEqual(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await call("ot_from_before_a_restart", "list_spaces", {})).status).toBe(401);
    expect(warn.mock.calls.some(([m]) => String(m).includes("令牌无效"))).toBe(true);
    warn.mockRestore();
  });
});
