import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { addPeer, invite, peerJson } from "../src/core/peers.ts";
import { PEER_DENY, peerToolNames } from "../src/agents/peer-agent.ts";
import { ROLE_TOOLS, TOOL_GROUPS } from "../src/agents/tool-help.ts";
import { toolList } from "../src/agents/tools.ts";
import { createSpace } from "../src/core/spaces.ts";
import { listRuns, runEvents } from "../src/agents/runs.ts";
import { listMemories } from "../src/memory/store.ts";
import { all } from "../src/core/db.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function node(id: string) {
  const home = mkdtempSync(join(tmpdir(), `omem-peertools-${id}-`));
  const b = await boot(home, { port: 0, quiet: true, background: false });
  b.app.config.node = { id };
  b.app.config.token = `owner-${id}`;
  servers.push(b.server);
  return b.app;
}

type Call = { node: string; runId: string | null; text: string; isError: boolean };

describe("an outside Agent on another device uses this instance's tools", () => {
  it("lists the tool set, reads and writes as the owner into one run per session, refuses outward tools and keeps to the spaces", async () => {
    const server = await node("server");
    const relay = await node("relay");
    const laptop = await node("laptop");
    // laptop reaches server only through relay: relay just forwards /api/ calls.
    await addPeer(relay, invite(server, { url: server.baseUrl! }).code);
    await addPeer(laptop, invite(relay, { url: relay.baseUrl! }).code);
    await addPeer(laptop, invite(server, { url: "http://unreachable.invalid" }).code, { via: "relay" });
    createSpace(server, { id: "proj-b", name: "项目 B" });

    const call = (name: string, args?: unknown, scope: Record<string, unknown> = {}, session = "s1") =>
      peerJson<Call>(laptop, "server", "/api/peer/tool", { caller: "laptop", session, name, args, ...scope });

    // ---- list: what `omem mcp` gives, without the outward and role-only tools
    const listed = await peerJson<{ node: string; tools: { name: string }[] }>(laptop, "server", "/api/peer/tools?caller=laptop");
    const names = listed.tools.map((t) => t.name);
    expect(listed.node).toBe("server");
    expect(names).toEqual(expect.arrayContaining(["search", "read_source", "remember", "write_page", "omem_help", "omem_call"]));
    for (const n of ["lark_send", "notify", "delegate_code", "submit_plan"]) expect(names).not.toContain(n);
    // Reviewing a branch itself: review_branch from a device, and the hand-ins it needs for that.
    expect(["review_branch", "review_task", "submit_review", "submit_change_points"].every((n) => peerToolNames().has(n))).toBe(true);
    expect(peerToolNames().has("rule_review") || peerToolNames({ readOnly: true }).has("submit_review")).toBe(false);
    const full = peerToolNames();
    expect(full.has("upsert_item") && full.has("set_source_attention") && full.has("organize_memories") && full.has("supersede") && full.has("forget")).toBe(true);
    expect(full.has("run_agent") || full.has("wake_later") || full.has("lark_card")).toBe(false);
    const ro = await peerJson<{ tools: { name: string }[] }>(laptop, "server", "/api/peer/tools?readOnly=1");
    expect(ro.tools.map((t) => t.name)).not.toContain("remember");
    // help does not open a run
    const help = await call("omem_help", { topic: "memory" }, {}, "help-only");
    expect(help.isError).toBe(false);
    expect(help.runId).toBeNull();
    expect(listRuns(server, { kind: "peer-agent", includeQuiet: true })).toHaveLength(0);

    // ---- a read call: a run of its own, with a tool event
    const read = await call("list_spaces");
    expect(read.isError).toBe(false);
    expect(read.text).toContain("personal");
    expect(read.runId).toMatch(/^r/);
    const runs = listRuns(server, { kind: "peer-agent", includeQuiet: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: read.runId, status: "running", title: expect.stringContaining("设备 laptop 的外部 Agent") });
    expect(runs[0].input).toMatchObject({ caller: "laptop", session: "s1" });
    expect(runEvents(server, read.runId!).map((e) => e.type)).toContain("tool");

    // ---- a write call (through omem_call): same session, same run; the memory carries the run and the peer as its agent
    const w = await call("omem_call", { tool: "remember", args: { content: "项目 A 每周二下午发布。", kind: "fact" } }, { agent: "claude-code", model: "claude-test", effort: "medium" });
    expect(w.isError).toBe(false);
    expect(w.runId).toBe(read.runId);
    const mem = listMemories(server, { status: "active" }).find((m) => m.content === "项目 A 每周二下午发布。")!;
    expect(mem).toMatchObject({ runId: read.runId, agentProfile: "peer:laptop", model: "claude-test", effort: "medium", createdBy: "agent" });
    // The run shows what ran on the other side, like any run's AI.
    expect(listRuns(server, { kind: "peer-agent", includeQuiet: true })[0].ai).toEqual({ profile: "peer:laptop:claude-code", model: "claude-test", effort: "medium" });
    const events = runEvents(server, read.runId!);
    expect(events.filter((e) => e.type === "tool")).toHaveLength(2);
    expect(events.some((e) => e.type === "tool-write" && (e.data as { name?: string }).name === "remember")).toBe(true);
    expect(listRuns(server, { kind: "peer-agent", includeQuiet: true })).toHaveLength(1);
    // another session is another run
    const other = await call("list_spaces", {}, {}, "s2");
    expect(other.runId).not.toBe(read.runId);
    expect(listRuns(server, { kind: "peer-agent", includeQuiet: true })).toHaveLength(2);

    // ---- outward tools are refused, directly and through omem_call, and the refusal is in the run
    const before = all<{ n: number }>(server.db, "select count(*) n from notifications")[0].n;
    for (const [name, args] of [
      ["lark_send", { text: "hi" }],
      ["notify", { title: "t", body: "b" }],
      ["delegate_code", { task: "x" }],
      ["run_agent", { name: "x", task: "y" }],
      ["wake_later", { minutes: 1, note: "n" }],
      ["omem_call", { tool: "lark_send", args: { text: "hi" } }],
      ["omem_call", { tool: "notify", args: { title: "t", body: "b" } }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/不对设备的外部 Agent 开放|不可用/);
    }
    expect((await call("lark_send", { text: "hi" })).text).toMatch(/不对设备的外部 Agent 开放/);
    expect(all<{ n: number }>(server.db, "select count(*) n from notifications")[0].n).toBe(before);
    expect(runEvents(server, read.runId!).some((e) => e.type === "tool" && (e.data as { refused?: boolean }).refused === true)).toBe(true);
    // a role-only tool is not available either
    expect((await call("submit_plan", { pages: [] })).text).toMatch(/不可用/);

    // ---- bad names and arguments
    await expect(call("Bad Name!")).rejects.toThrow(/工具名不合法/);
    await expect(call("search", ["not", "an", "object"])).rejects.toThrow(/JSON 对象/);
    await expect(peerJson(laptop, "server", "/api/peer/tool", { session: "s1" })).rejects.toThrow(/name/);
    await expect(peerJson(laptop, "server", "/api/peer/tool", { name: "search" })).rejects.toThrow(/session/);
    const unknown = await call("no_such_tool", {});
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toMatch(/不可用/);
    const wrongArgs = await call("remember", { content: 5 });
    expect(wrongArgs.isError).toBe(true);
    expect(wrongArgs.text).toMatch(/参数错误/);

    // ---- read-only: writes are unavailable
    const roWrite = await call("remember", { content: "项目 B 每周三发布。", kind: "fact" }, { readOnly: true }, "ro");
    expect(roWrite).toMatchObject({ isError: true });
    expect(roWrite.text).toMatch(/不可用/);

    // ---- spaces: a default space that exists, writes stay inside the narrowed spaces
    await expect(call("list_spaces", {}, { space: "no-such-space" })).rejects.toThrow(/没有空间|不存在/);
    await expect(call("list_spaces", {}, { space: "proj-b", spaces: ["personal"] })).rejects.toThrow(/不在限定/);
    const inB = await call("omem_call", { tool: "remember", args: { content: "项目 B 每周三发布。", kind: "fact", space: "proj-b" } }, { space: "proj-b" }, "b");
    expect(inB.isError).toBe(false);
    expect(listMemories(server, { spaceId: "proj-b" }).map((m) => m.content)).toContain("项目 B 每周三发布。");
    const narrowed = await call("omem_call", { tool: "remember", args: { content: "项目 B 每周四发布。", kind: "fact", space: "proj-b" } }, { spaces: ["personal"] }, "narrow");
    expect(narrowed.isError).toBe(true);
    expect(narrowed.text).toMatch(/不能访问空间 proj-b/);
    expect(listMemories(server, { spaceId: "proj-b" }).map((m) => m.content)).not.toContain("项目 B 每周四发布。");
    const readB = await call("search", { query: "项目 B 发布", space: "proj-b" }, { spaces: ["personal"] }, "narrow");
    expect(readB.isError).toBe(true);
    expect(readB.text).toMatch(/不能访问空间 proj-b/);

    // ---- only the owner: a member's token is refused
    const { createApiToken, createUser } = await import("../src/core/users.ts");
    const member = createUser(server, { id: "demo-member", name: "示例成员" });
    const res = await fetch(`${server.baseUrl}/api/peer/tool`, { method: "POST", headers: { authorization: `Bearer ${createApiToken(server, member.id)}`, "content-type": "application/json" }, body: JSON.stringify({ session: "m", name: "list_spaces" }) });
    expect(res.status).toBe(403);
    expect((await fetch(`${server.baseUrl}/api/peer/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  }, 90000);

  it("classifies every built-in tool: outside Agents get it, or it is listed as outward / role-only", () => {
    const grouped = new Set(TOOL_GROUPS.filter((g) => g.id !== "plugins").flatMap((g) => g.tools));
    const allowed = peerToolNames();
    expect([...allowed].filter((n) => n.startsWith("lark_") || n.startsWith("meeting_") || n.startsWith("wake_"))).toEqual([]);
    const registered = new Set(toolList().map((t) => t.name));
    expect([...PEER_DENY].filter((n) => !registered.has(n))).toEqual([]);
    expect(toolList().map((t) => t.name).filter((n) => !grouped.has(n) && !n.startsWith("plugin"))).toEqual([]);
  });
});
