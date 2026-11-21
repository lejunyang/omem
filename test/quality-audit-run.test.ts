import { createSpace } from "../src/core/spaces.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { levelOf, reviewQueue, setAttention, setNodeLevel } from "../src/sources/attention.ts";
import { levelCandidates } from "../src/quality/levels.ts";
import { upsertSource } from "../src/sources/store.ts";
import { writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
createSpace(app, { id: "project", name: "项目 A" });
const control = join(mkdtempSync(join(tmpdir(), "omem-audit-run-")), "check");
app.config.agents.default = "fake";
app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "wiki", FAKE_WIKI_CHECK_FILE: control } })];
const server = await startServer(app, { port: 0, quiet: true });
// Inspect the repair handoff without generating more pages.
app.events.on("event", (e: { type: string; runId?: string }) => {
  if (e.type === "run" && e.runId) run(app.db, "update runs set not_before = '2099-01-01T00:00:00.000Z' where id = ? and kind = 'wiki-write' and status = 'queued'", e.runId);
});
afterAll(async () => { stopWorker(); await server.close(); app.db.close(); await rm(dirname(control), { recursive: true, force: true }); });
let seq = 0;
function seed() {
  const writer = createRun(app, { kind: "ingest", spaceId: "project", title: "整理示例材料" });
  // Keep the worker from executing the seed writer, and preserve its provenance.
  run(app.db, "update runs set status = 'done', ai = ? where id = ?", JSON.stringify({ profile: "fake" }), writer.id);
  const source = importText(app, "project", { uri: `audit-${++seq}.md`, text: "示例材料中有转写。" });
  const slug = `audit-${seq}`;
  writePage(app, "project", slug, { meta: { title: "抽检示例", kind: "guide" }, body: `示例正文[材料](src:${source.id}#L1-L1)` }, { actor: "agent", runId: writer.id, commit: false });
  return { slug, writer };
}
async function audit(mode: string, fix: "wrong" | "off" = "wrong") {
  // Each case starts with no unaudited page from another case.
  run(app.db, "delete from page_writes");
  run(app.db, "update runs set status = 'cancelled' where status in ('queued','running')");
  const seeded = seed();
  writeFileSync(control, mode);
  app.config.quality.audit.fix = fix;
  const task = createRun(app, { kind: "quality-audit", spaceId: "project", title: "每晚抽检" });
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
  const answering = createRun(app, { kind: "ask", spaceId: "project", title: "示例提问" });
  run(app.db, "update runs set status = 'done' where id = ?", answering.id);
  const ctx: ToolContext = { app, runId: answering.id, spaceId: "project", spaces: null, tools: null, actor: "agent", role: "assistant" };
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
  addMember(app, "project", member.id, "reader");
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
  const page = await server.inject({ method: "GET", url: `/api/wiki/project/page/${overview.json().recent[0].target}` });
  expect(page.json().audit.verdict).toBe("wrong");
  const memberPage = await server.inject({ method: "GET", url: `/api/wiki/project/page/${overview.json().recent[0].target}`, headers });
  expect(memberPage.statusCode, memberPage.body).toBe(200);
  expect(memberPage.json()).not.toHaveProperty("audit");
  const result = await peerCommands.quality.run(app, peerCommands.quality.schema.parse({}));
  expect(result).toHaveProperty("waiting");
  expect(JSON.stringify(result)).not.toContain('"findings"');
  expect(peerCommands.quality.schema.safeParse({ shell: "anything" }).success).toBe(false);
  expect(all(app.db, "select * from quality_audits")).toHaveLength(4);
});

it("audits levels in the page audit's run via ACP, offers owner suggestions, and reports separate accuracy", async () => {
  run(app.db, "delete from page_writes");
  run(app.db, "update runs set status = 'cancelled' where status in ('queued','running')");
  const { writer } = seed();
  const source = upsertSource(app, { spaceId: "project", kind: "doc", uri: "level-review/a.md", title: "流程说明", text: "本周仍使用的流程说明。" });
  setAttention(app, [source.id], "ignore", "agent", { reason: "只作存档", runId: writer.id });
  setNodeLevel(app, "project", "dir:level-review", "reference", "agent", { reason: "历史材料", runId: writer.id });
  writeFileSync(control, "level-wrong");
  const task = scheduleAudit(app)!;
  expect(task).toBeTruthy();
  startWorker(app);
  const done = await waitForRun(app, task.id);
  expect(done.status, done.error ?? "").toBe("done");
  expect(done.output).toMatchObject({ audited: 1, levels: { audited: 2, wrong: 2, unchecked: 0 } });
  expect(done.output.summary).toContain("定级：抽了 2 个，2 个不对（见原件 → 待复核）");
  expect(one<{ body: string }>(app.db, "select body from notifications where json_extract(context, '$.runId') = ?", task.id)?.body).toContain("定级：抽了 2 个，2 个不对");
  const rows = qualityOverview(app).recent.filter((r) => r.category === "level");
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.auditRun === task.id && r.pipeline === "ingest" && r.verdict === "wrong" && r.suggestedLevel === "normal" && r.fixRun === null)).toBe(true);
  const overview = await server.inject({ method: "GET", url: "/api/quality" });
  expect(overview.statusCode, overview.body).toBe(200);
  expect(overview.json().recent.find((r: { target: string }) => r.target === "level-node:dir:level-review").title).toBe("level-review");
  expect(levelOf(app, source.id)).toMatchObject({ level: "ignore", by: "agent" });
  const queue = (await server.inject({ method: "GET", url: "/api/sources/review?space=project" })).json().levels;
  expect(queue).toHaveLength(2);
  expect(queue.every((r: { suggestedLevel: string }) => r.suggestedLevel === "normal")).toBe(true);
  const member = createUser(app, { id: "level-reader", name: "示例成员" });
  addMember(app, "project", member.id, "editor");
  const payload = { space: "project", auditId: queue.find((r: { type: string }) => r.type === "source").auditId, decision: "accept" };
  const headers = { authorization: `Bearer ${createApiToken(app, member.id, "定级建议权限测试")}` };
  expect((await server.inject({ method: "POST", url: "/api/sources/level-audit/review", headers, payload })).statusCode).toBe(403);
  expect((await server.inject({ method: "POST", url: "/api/sources/level-audit/review", payload })).statusCode).toBe(200);
  expect(levelOf(app, source.id)).toMatchObject({ level: "normal", by: "owner" });
  const folder = queue.find((r: { type: string }) => r.type === "node");
  expect((await server.inject({ method: "POST", url: "/api/sources/level-audit/review", payload: { ...payload, auditId: folder.auditId, decision: "keep" } })).statusCode).toBe(200);
  expect(levelOf(app, source.id, true)).toMatchObject({ level: "normal", by: "owner" });
  expect(reviewQueue(app, "project").levels).toEqual([]);
  expect(levelCandidates(app)).toEqual([]);
  expect(qualityOverview(app).pipelines.find((r) => r.pipeline === "level")).toMatchObject({ audited: 2, wrong: 2, accuracy: 0, flagged: false });
  expect(qualityOverview(app).flagged).not.toContain("level");
}, 120000);

it("schedules a level-only audit, records unsure once, and disables level sampling with zero", async () => {
  run(app.db, "delete from page_writes");
  const source = importText(app, "project", { uri: "unsure-level.md", text: "只有标题的示例材料。" });
  setAttention(app, [source.id], "reference", "agent");
  app.config.quality.audit.levels = 0;
  expect(scheduleAudit(app)).toBeNull();
  app.config.quality.audit.levels = 6;
  writeFileSync(control, "level-unsure");
  const task = scheduleAudit(app)!;
  expect(task).toBeTruthy();
  startWorker(app);
  const done = await waitForRun(app, task.id);
  expect(done.status, done.error ?? "").toBe("done");
  expect(done.output).toMatchObject({ audited: 0, levels: { audited: 1, wrong: 0, unchecked: 1 } });
  expect(qualityOverview(app).pipelines.find((r) => r.pipeline === "level")).toMatchObject({ audited: 3, wrong: 2, unchecked: 1, accuracy: 0 });
  expect(scheduleAudit(app)).toBeNull();
  expect(reviewQueue(app, "project").levels).toEqual([]);
}, 120000);

it("restricts the level hand-in tool to its scoped checker sub-step", async () => {
  const task = createRun(app, { kind: "quality-audit", spaceId: "project", title: "提交边界" });
  run(app.db, "update runs set status = 'running', output = ? where id = ?", JSON.stringify({ levelTarget: { spaceId: "project", target: "level-source:demo" } }), task.id);
  const ctx: ToolContext = { app, runId: task.id, spaceId: "project", spaces: ["project"], tools: new Set(["submit_level_check"]), actor: "agent", role: "wiki-checker" };
  const verdict = { verdict: "wrong", suggestedLevel: "normal", reason: "示例依据" };
  expect((await callTool({ ...ctx, role: "assistant" }, "submit_level_check", verdict)).isError).toBe(true);
  expect((await callTool({ ...ctx, spaces: [] }, "submit_level_check", verdict)).isError).toBe(true);
  expect((await callTool(ctx, "submit_level_check", { verdict: "wrong", reason: "未给级别" })).isError).toBe(true);
  expect((await callTool(ctx, "submit_level_check", verdict)).isError).toBe(false);
  run(app.db, "update runs set status = 'done', output = '{}' where id = ?", task.id);
  expect((await callTool(ctx, "submit_level_check", verdict)).isError).toBe(true);
});
