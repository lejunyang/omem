import { resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, listRuns, startWorker, waitForRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createThread, threadMessages } from "../src/agents/threads.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { runDesigner } from "../src/designs/designer.ts";
import { createDesign, getDesign } from "../src/designs/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
createSpace(app, { id: "shop-api", name: "商城接口", kind: "repo" });
const doc = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/refund-design.md", title: "退款改造技术方案", text: "# 退款改造\n\n退款金额改由订单服务计算。" });
const fake = (id: string, env: Record<string, string>) => agentProfileSchema.parse({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "design", ...env }, idleTimeoutMs: 60000 });
app.config.agents.default = "fake";
app.config.agents.profiles = [fake("fake", {}), fake("fake-none", { FAKE_DESIGN: "none" })];
const server = await startServer(app, { port: 0, quiet: true });
afterAll(() => server.close());

it("assesses someone else's design through ACP/MCP, notifies, reports back, and reassesses with every concern accounted for", async () => {
  const t = createThread(app, { spaceId: "shop", channel: "web" });
  const ask = createRun(app, { kind: "ask", spaceId: "shop", title: "跟进方案", input: { conversationId: t.id, messageIds: [] } });
  run(app.db, "update runs set status = 'done' where id = ?", ask.id);
  const ctx: ToolContext = { app, runId: ask.id, spaceId: "shop", spaces: null, tools: null, actor: "agent", userId: OWNER };
  const started = await callTool(ctx, "assess_design", { title: "退款改造技术方案", sources: [`src:${doc.id}`], repo_spaces: ["shop-api"], author: "小王", note: "重点看对账" });
  expect(started.isError, started.text).toBe(false);
  const job = listRuns(app, { parentId: ask.id, kind: "design" })[0];
  startWorker(app);
  const done = await waitForRun(app, job.id);
  expect(done.status, done.error ?? "").toBe("done");
  const said = JSON.parse(String(done.output.summary).replace(/^评估完成 /, ""));
  expect(said).toEqual({ read: true, submitted: "ok", hasDoc: true, hasRepo: true, hasNote: true });
  const d = getDesign(app, job.input.designId as string);
  expect(d).toMatchObject({ origin: "external", status: "assessed", revision: 1, runId: job.id });
  expect(d.body.decisions.map((x) => [x.id, x.stated])).toEqual([["D1", undefined], ["D2", false]]);
  const notes = all<{ title: string; body: string; link: string }>(app.db, "select title, body, link from notifications");
  expect(notes).toContainEqual({ title: "方案评估完成：《退款改造技术方案》", body: "2 个决定；问题 1 风险 1 要问 1", link: `#/design/${d.id}` });
  expect(threadMessages(app, t.id).map((m) => m.text).join("\n")).toContain("方案评估完成：《退款改造技术方案》");

  // The document changed: the same design again; leaving out the old concerns is refused, then each is given its state.
  const again = await callTool(ctx, "assess_design", { title: "退款改造技术方案", sources: [`src:${doc.id}`], design_id: d.id });
  expect(again.isError, again.text).toBe(false);
  const second = listRuns(app, { parentId: ask.id, kind: "design" }).find((r) => r.id !== job.id)!;
  const reran = await waitForRun(app, second.id);
  expect(reran.status, reran.error ?? "").toBe("done");
  const out = JSON.parse(String(reran.output.summary).replace(/^重新评估 /, ""));
  expect(out.missing).toMatch(/C1.*C2.*C3/s);
  expect(out.done).toBe("ok");
  const d2 = getDesign(app, d.id);
  expect(d2).toMatchObject({ status: "assessed", revision: 2 });
  expect(d2.body.decisions[0].concerns!.map((c) => [c.id, c.state])).toEqual([["C2", "resolved"], ["C3", "open"]]);

  // Handing nothing in fails the run and leaves the design as it was.
  const third = await callTool(ctx, "assess_design", { title: "退款改造技术方案", sources: [`src:${doc.id}`], design_id: d.id, execution: { profile: "fake-none", source: "user", reason: "测试" } });
  expect(third.isError, third.text).toBe(false);
  const failedRun = listRuns(app, { parentId: ask.id, kind: "design" }).find((r) => ![job.id, second.id].includes(r.id))!;
  const failed = await waitForRun(app, failedRun.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("没有交方案");
  expect(getDesign(app, d.id)).toMatchObject({ status: "assessed", revision: 2 });
});

it("runs the designer for an own design bound to a run", async () => {
  const d = createDesign(app, { spaceId: "shop", title: "退款改造", origin: "own" });
  const r = createRun(app, { kind: "code", spaceId: "shop", title: "交办：退款", input: { designId: d.id, task: "退款只算已发货行" } });
  const events: string[] = [];
  const res = await runDesigner(app, { design: d, run: r, task: "退款只算已发货行", spaces: ["shop"], signal: new AbortController().signal, event: (type, data) => { if (type === "status") events.push((data as { text: string }).text); } });
  expect(res.design, res.text).not.toBeNull();
  expect(res.design).toMatchObject({ status: "review", revision: 1, runId: r.id });
  expect(res.design!.body.decisions[0]).toMatchObject({ id: "D1", kind: "change", question: { text: "运费怎么退" } });
  expect(events[0]).toContain("写方案");
});
