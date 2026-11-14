import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import "../src/quality/audit.ts";
import { createRun, getRun, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { peerCommands } from "../src/core/peer-exec.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { qualityOverview, scheduleAudit } from "../src/quality/audit.ts";
import { registeredRoutes, startServer } from "../src/server/http.ts";
import { importText } from "../src/sources/import.ts";
import { writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
const control = join(mkdtempSync(join(tmpdir(), "omem-audit-run-")), "check");
app.config.agents.default = "fake";
app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "wiki", FAKE_WIKI_CHECK_FILE: control } })];
const server = await startServer(app, { port: 0, quiet: true });
// Inspect the repair handoff without generating more pages.
app.events.on("event", (e: { type: string; runId?: string }) => {
  if (e.type === "run" && e.runId) run(app.db, "update runs set not_before = '2099-01-01T00:00:00.000Z' where id = ? and kind = 'wiki-write' and status = 'queued'", e.runId);
});
afterAll(async () => { stopWorker(); await server.close(); });
let seq = 0;
function seed() {
  const writer = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理示例材料" });
  // Keep the worker from executing the seed writer, and preserve its provenance.
  run(app.db, "update runs set status = 'done', ai = ? where id = ?", JSON.stringify({ profile: "fake" }), writer.id);
  const source = importText(app, "personal", { uri: `audit-${++seq}.md`, text: "示例材料中有转写。" });
  const slug = `audit-${seq}`;
  writePage(app, "personal", slug, { meta: { title: "抽检示例", kind: "guide" }, body: `示例正文[材料](src:${source.id}#L1-L1)` }, { actor: "agent", runId: writer.id, commit: false });
  return { slug, writer };
}
async function audit(mode: string, fix: "wrong" | "off" = "wrong") {
  // Each case starts with no unaudited page from another case.
  run(app.db, "delete from page_writes");
  run(app.db, "update runs set status = 'cancelled' where status in ('queued','running')");
  const seeded = seed();
  writeFileSync(control, mode);
  app.config.quality.audit.fix = fix;
  const task = createRun(app, { kind: "quality-audit", spaceId: "personal", title: "每晚抽检" });
  startWorker(app);
  const done = await waitForRun(app, task.id);
  expect(done.status, done.error ?? "").toBe("done");
  return { ...seeded, done, row: qualityOverview(app).recent.find((r) => r.auditRun === task.id)! };
}

it("audits an ingest page through ACP and hands a cite finding back to a checked writer", async () => {
  const { done, row, writer } = await audit("cite");
  expect(row).toMatchObject({ verdict: "wrong", pipeline: "ingest", writerRun: writer.id, findings: [expect.objectContaining({ kind: "cite", problem: "说没有转写，原件里有转写" })] });
  expect(row.fixRun).toBeTruthy();
  const fix = getRun(app, row.fixRun!);
  expect(fix).toMatchObject({ kind: "wiki-write", status: "queued" });
  expect(JSON.stringify(fix.input)).toContain("说没有转写，原件里有转写");
  expect(String(fix.input.instructions).split("说没有转写，原件里有转写")).toHaveLength(2);
  expect(done.output).toMatchObject({ audited: 1, wrong: 1, fixing: 1 });
  expect(one<{ link: string }>(app.db, "select link from notifications where json_extract(context, '$.runId') = ?", done.id)?.link).toBe("#/quality");
}, 120000);

it("records ok with no fix and a silent notification", async () => {
  const { row, done } = await audit("pass");
  expect(row).toMatchObject({ verdict: "ok", fixRun: null, findings: [] });
  const n = one<{ context: string }>(app.db, "select context from notifications where json_extract(context, '$.runId') = ?", done.id)!;
  expect(JSON.parse(n.context).urgency).toBe("silent");
}, 120000);

it("keeps a checker that submits nothing unchecked and outside accuracy and flags", async () => {
  app.config.quality.audit.minSamples = 3;
  const { row, done } = await audit("nothing");
  expect(row).toMatchObject({ verdict: "unchecked", fixRun: null });
  expect(done.output).toMatchObject({ audited: 1, unchecked: 1, wrong: 0 });
  const stats = qualityOverview(app).pipelines.find((s) => s.pipeline === "ingest")!;
  expect(stats.accuracy).toBe(0.5); // One wrong and one ok; this unchecked page adds neither.
  expect(qualityOverview(app).flagged).toEqual([]);
  app.config.quality.audit.minSamples = 6;
}, 120000);

it("does not hand wrong pages back when fix is off", async () => {
  const { row, done } = await audit("cite", "off");
  expect(row).toMatchObject({ verdict: "wrong", fixRun: null });
  expect(done.output).toMatchObject({ fixing: 0 });
}, 120000);

it("does not schedule when disabled, empty, queued or running", async () => {
  run(app.db, "delete from page_writes");
  app.config.quality.audit.enabled = false;
  expect(scheduleAudit(app)).toBeNull();
  expect((await server.inject({ method: "POST", url: "/api/quality/audit" })).json()).toEqual({ runId: null, reason: "disabled" });
  app.config.quality.audit.enabled = true;
  expect(scheduleAudit(app)).toBeNull();
  expect((await server.inject({ method: "POST", url: "/api/quality/audit" })).json()).toEqual({ runId: null, reason: "nothing to audit" });
  seed();
  // Hold this audit while testing duplicate scheduling through HTTP.
  const hold = (e: { type: string; runId?: string }) => {
    if (e.type === "run" && e.runId) run(app.db, "update runs set not_before = '2099-01-01T00:00:00.000Z' where id = ? and kind = 'quality-audit' and status = 'queued'", e.runId);
  };
  app.events.on("event", hold);
  const response = await server.inject({ method: "POST", url: "/api/quality/audit" });
  expect(response.statusCode).toBe(200);
  const queued = getRun(app, response.json().runId);
  expect(queued.id).toBeTruthy();
  expect(scheduleAudit(app)).toBeNull();
  expect((await server.inject({ method: "POST", url: "/api/quality/audit" })).json()).toEqual({ runId: null, reason: "already under way" });
  run(app.db, "update runs set status = 'running' where id = ?", queued.id);
  expect(scheduleAudit(app)).toBeNull();
  run(app.db, "update runs set status = 'cancelled' where id = ?", queued.id);
  app.events.off("event", hold);
});

it("records reads only for answering roles and write provenance through tools", async () => {
  const { slug } = seed();
  const answering = createRun(app, { kind: "ask", spaceId: "personal", title: "示例提问" });
  run(app.db, "update runs set status = 'done' where id = ?", answering.id);
  const ctx: ToolContext = { app, runId: answering.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "assistant" };
  expect((await callTool(ctx, "read_page", { page: slug })).isError).toBe(false);
  expect((await callTool({ ...ctx, role: "ingest" }, "read_page", { page: slug })).isError).toBe(false);
  expect(one<{ n: number }>(app.db, "select n from page_reads where slug = ?", slug)?.n).toBe(1);
  const result = await callTool(ctx, "write_page", { page: "tool-written", title: "工具写入", summary: "示例约定", body: "这是本人要求记录的示例约定。" });
  expect(result.isError, JSON.stringify(result)).toBe(false);
  expect(one(app.db, "select run_id from page_writes where slug = 'tool-written' order by id desc limit 1")).toMatchObject({ run_id: answering.id });
});

it("exposes owner routes, settings round trips, page titles and a validated read-only peer summary", async () => {
  expect(ROUTE_RULES["GET /api/quality"]).toBe("owner");
  expect(ROUTE_RULES["POST /api/quality/audit"]).toBe("owner");
  expect(registeredRoutes.has("GET /api/quality")).toBe(true);
  expect(registeredRoutes.has("POST /api/quality/audit")).toBe(true);
  const member = createUser(app, { id: "audit-reader", name: "示例读者" });
  addMember(app, "personal", member.id, "reader");
  const headers = { authorization: `Bearer ${createApiToken(app, member.id, "抽检权限测试")}` };
  expect((await server.inject({ method: "GET", url: "/api/quality", headers })).statusCode).toBe(403);
  expect((await server.inject({ method: "POST", url: "/api/quality/audit", headers })).statusCode).toBe(403);
  const before = await server.inject({ method: "GET", url: "/api/settings" });
  const quality = { audit: { ...before.json().config.quality.audit, max: 9, threshold: 0.85, fix: "all" } };
  const saved = await server.inject({ method: "PUT", url: "/api/settings", payload: { quality } });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await server.inject({ method: "GET", url: "/api/settings" })).json().config.quality).toEqual(quality);
  const overview = await server.inject({ method: "GET", url: "/api/quality" });
  expect(overview.statusCode, overview.body).toBe(200);
  expect(overview.json().recent[0].title).toBe("抽检示例");
  const page = await server.inject({ method: "GET", url: `/api/wiki/personal/page/${overview.json().recent[0].target}` });
  expect(page.json().audit.verdict).toBe("wrong");
  const memberPage = await server.inject({ method: "GET", url: `/api/wiki/personal/page/${overview.json().recent[0].target}`, headers });
  expect(memberPage.statusCode, memberPage.body).toBe(200);
  expect(memberPage.json()).not.toHaveProperty("audit");
  const result = await peerCommands.quality.run(app, peerCommands.quality.schema.parse({}));
  expect(result).toHaveProperty("waiting");
  expect(JSON.stringify(result)).not.toContain('"findings"');
  expect(peerCommands.quality.schema.safeParse({ shell: "anything" }).success).toBe(false);
  expect(all(app.db, "select * from quality_audits")).toHaveLength(4);
});
