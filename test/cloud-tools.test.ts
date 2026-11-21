import { expect, it, vi } from "vitest";
import { cloudRequest, cloudTurn, cloudUsage, revokeCloud } from "../src/agents/cloud-tools.ts";
import { confirmProbe, probeCloud, probeReceipt } from "../src/agents/cloud-probe.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { createRun, runEvents } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { all, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

it.each(["header", "url"] as const)("binds %s grants to one member, scope and turn", async mode => {
  const app = testApp();
  const profile = agentProfileSchema.parse({ id: "cloud-a", command: "unused", transport: "doubao" });
  app.config.agents.profiles = [profile];
  app.config.webUrl = "https://8.8.8.8";
  Object.assign(app.config.agents.cloudTools, { enabled: true, backends: [profile.id], credentialIn: "message", maxCalls: 5 });
  const probe = await probeCloud(app, profile.id, async (_app, _p, req) => {
    const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
    return { text: probeReceipt(app, nonce, mode === "header" ? nonce : ""), agent: "test", stopReason: "end_turn" };
  });
  confirmProbe(app, profile.id, probe.id);
  createSpace(app, { id: "team", name: "项目 A" });
  createUser(app, { id: "reader", name: "读者" });
  addMember(app, "team", "reader", "reader");
  const id = createRun(app, { kind: "ask", title: "测试", userId: "reader" }).id;
  run(app.db, "update runs set status='running' where id=?", id);
  const data = (spaceId: string) => upsertSource(app, { spaceId, kind: "doc", title: "材料", uri: "doc", text: "项目说明" }).id;
  const inside = data("team"), outside = data("personal");
  const ctx: ToolContext = { app, actor: "agent", userId: "reader", runId: id, spaceId: "team", spaces: ["team"], tools: new Set(["read_source"]) };
  const large = upsertSource(app, { spaceId: "team", kind: "doc", uri: "large", title: "大原件", text: "资料".repeat(10000) });
  const args = { source: inside };
  const expected = await callTool(ctx, "read_source", args);
  expect(expected.isError).toBe(false);
  const events: unknown[] = [];
  let first = "";
  const req = { cwd: app.home, prompt: "任务", system: "常驻说明", runId: id };
  const perform = async (choice: "read" | "revoke" | "expire" | "cancel" | "finished" | "large", ctrl = new AbortController()) => cloudTurn(app, profile, ctx, { ...req, signal: ctrl.signal }, e => events.push(e), async (turn, emit) => {
    first = turn.prompt.match(/oct_[\w-]+/)![0];
    expect(turn.system).toBe(req.system);
    expect(turn.mcp).toBeUndefined();
    expect(turn.cloudChannel).toBeUndefined();
    if (choice === "large") {
      const result = await cloudRequest(app, first, id, mode, "read_source", { source: large.id });
      expect(result).toMatchObject({ text: expect.stringContaining("已截断") });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32000);
    } else if (choice === "cancel") {
      ctrl.abort();
      await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("作废");
    } else if (choice === "finished") {
      run(app.db, "update runs set status='done' where id=?", id);
      try { await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("授权已结束"); }
      finally { run(app.db, "update runs set status='running' where id=?", id); }
    } else if (choice === "expire") {
      const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60000);
      try { await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("过期"); } finally { time.mockRestore(); }
    } else if (choice === "revoke") {
      expect(revokeCloud(app)).toBe(1);
      await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("作废");
    } else {
      await expect(cloudRequest(app, first, "another", mode)).rejects.toThrow("不符");
      const list = await cloudRequest(app, first, id, mode);
      expect(list).toMatchObject({ tools: [{ name: "read_source" }] });
      let secret = list.next?.split("/").pop() ?? first;
      if (mode === "url") await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("已使用");
      const result = await cloudRequest(app, secret, id, mode, "read_source", args);
      expect(result).toMatchObject(expected);
      secret = result.next?.split("/").pop() ?? first;
      const denied = await cloudRequest(app, secret, id, mode, "read_source", { source: outside });
      expect(denied).toMatchObject({ isError: true });
      secret = denied.next?.split("/").pop() ?? first;
      await expect(cloudRequest(app, secret, id, mode, "remember", {})).rejects.toThrow("名单");
      if (mode === "header") await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("用完");
    }
    emit({ type: "thought", text: first });
    return { text: first, agent: "test", stopReason: "end_turn" };
  });
  try {
    await perform("large");
    await perform("cancel");
    await perform("finished");
    await perform("expire");
    await perform("revoke");
    const result = await perform("read");
    expect(result.text).not.toContain(first);
    await expect(cloudRequest(app, first, id, mode)).rejects.toThrow("作废");
    expect(cloudUsage(app).activeCredentials).toBe(0);
    const recorded = JSON.stringify(runEvents(app, id));
    expect(recorded).toContain("cloud-http");
    expect(recorded).toContain(inside);
    expect(JSON.stringify([events, recorded, all(app.db, "select * from audit_events")])).not.toContain("oct_");
  } finally { app.db.close(); }
});
