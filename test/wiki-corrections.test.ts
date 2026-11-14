import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, getRun, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { releaseBackgroundSessions } from "../src/agents/background-sessions.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { agentProfileSchema, configSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { pullTables } from "../src/core/pull-data.ts";
import { startServer } from "../src/server/http.ts";
import { correctionCandidates, correctionLessons, createCorrection, listCorrections, type Correction } from "../src/wiki/corrections.ts";
import { readPage, writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
for (const id of ["choice", "flow", "foreign", "route"]) createSpace(app, { id, name: "示例空间" });
const controlDir = mkdtempSync(join(tmpdir(), "omem-corrections-"));
const checkFile = join(controlDir, "check"), writeFile = join(controlDir, "write");
writeFileSync(checkFile, "corrections");
writeFileSync(writeFile, "corrections");
app.config.concurrency = 1;
app.config.agents.default = "fake";
app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "wiki", FAKE_WIKI_CHECK_FILE: checkFile, FAKE_WIKI_WRITE_FILE: writeFile, FAKE_DELETE_LOG: join(controlDir, "deleted"), FAKE_EXIT_ON_DELETE: "1" } })];
const server = await startServer(app, { port: 0, quiet: true });
afterAll(async () => {
  stopWorker();
  await releaseBackgroundSessions(app);
  await server.close();
  app.db.close();
  await rm(app.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(controlDir, { recursive: true, force: true });
});

function seed(space: string, slug: string, body = "正确的示例正文", kind: "ingest" | "wiki-lint" = "ingest") {
  const writer = createRun(app, { kind, spaceId: space, title: "整理示例材料" });
  run(app.db, "update runs set status = 'done' where id = ?", writer.id);
  writePage(app, space, slug, { meta: { title: slug, kind: "guide" }, body }, { actor: "agent", runId: writer.id, commit: false });
  return writer.id;
}
function correction(space = "choice", slug = "guides/original"): Correction {
  return { id: "selection", space_id: space, slug, wrong: "needlecorrection", right: "正确说法", by: "owner", at: new Date().toISOString(), pipeline: "ingest", status: "open", sweep_run_id: null, checked: 0, fixed: 0 };
}
const payload = { slug: "overview", wrong: "转写未取得", right: "原件里有转写" };
const ctx: ToolContext = { app, runId: null, spaceId: "route", spaces: ["route"], writable: ["route"], tools: null, actor: "agent", userId: "owner" };
function cancelQueued() { run(app.db, "update runs set status = 'cancelled' where status = 'queued'"); }

it("records a web correction with latest pipeline, validates input and lists it", async () => {
  seed("route", "overview");
  const response = await server.inject({ method: "POST", url: "/api/wiki/route/corrections", payload });
  expect(response.statusCode, response.body).toBe(200);
  const saved = listCorrections(app, "route")[0];
  expect(saved).toMatchObject({ ...payload, space_id: "route", by: "owner", pipeline: "ingest", status: "open", checked: 0, fixed: 0, sweep_run_id: response.json().sweepRunId });
  expect(getRun(app, response.json().writeRuns[0]).input.instructions).toContain("转写未取得 → 应该是 原件里有转写");
  expect((await server.inject({ method: "GET", url: "/api/wiki/route/corrections" })).json()[0].id).toBe(saved.id);
  for (const data of [{ ...payload, wrong: " " }, { ...payload, right: "" }, { ...payload, slug: "missing" }]) {
    expect((await server.inject({ method: "POST", url: "/api/wiki/route/corrections", payload: data })).statusCode).toBe(data.slug === "missing" ? 404 : 400);
  }
  writePage(app, "route", "owner-written", { meta: { title: "本人写的示例页" }, body: "旧说法" }, { actor: "user", commit: false });
  const unknown = createCorrection(app, "route", { ...payload, slug: "owner-written" });
  expect(listCorrections(app, "route").find((c) => c.id === unknown.id)?.pipeline).toBeNull();
  cancelQueued();
});

it("offers correct_page as a scoped write, refuses read-only and outside spaces", async () => {
  const result = await callTool(ctx, "correct_page", { page: "overview", wrong: "口径不对", right: "使用新口径" });
  expect(result.isError, JSON.stringify(result)).toBe(false);
  const before = listCorrections(app, "route").length;
  for (const [context, args] of [
    [ctx, { space: "foreign", page: "overview", wrong: "错", right: "对" }],
    [{ ...ctx, writable: [] }, { page: "overview", wrong: "错", right: "对" }],
  ] as [ToolContext, Record<string, string>][]) expect((await callTool(context, "correct_page", args)).isError).toBe(true);
  const user = createUser(app, { id: "correction-reader", name: "示例读者" });
  addMember(app, "route", user.id, "reader");
  const headers = { authorization: `Bearer ${createApiToken(app, user.id, "权限测试")}` };
  for (const space of ["route", "foreign"]) {
    expect((await server.inject({ method: "GET", url: `/api/wiki/${space}/corrections`, headers })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: `/api/wiki/${space}/corrections`, headers, payload })).statusCode).toBe(403);
  }
  expect((await callTool({ ...ctx, userId: user.id }, "correct_page", { page: "overview", wrong: "错", right: "对" })).isError).toBe(true);
  expect(listCorrections(app, "route")).toHaveLength(before);
  cancelQueued();
});

it("selects latest same-pipeline pages within 90 days plus search hits, with directory priority and cap", async () => {
  seed("choice", "guides/original", "needlecorrection");
  seed("choice", "guides/sibling");
  seed("choice", "elsewhere/recent");
  seed("choice", "guides/search", "needlecorrection", "wiki-lint");
  seed("choice", "other-search", "needlecorrection", "wiki-lint");
  seed("foreign", "guides/foreign", "needlecorrection");
  seed("choice", "old");
  run(app.db, "update page_writes set at = '2000-01-01T00:00:00.000Z' where space_id = 'choice' and slug = 'old'");
  seed("choice", "replaced");
  seed("choice", "replaced", "正确正文", "wiki-lint");
  app.config.wiki.corrections.sweep = 15;
  const chosen = await correctionCandidates(app, correction());
  expect(new Set(chosen)).toEqual(new Set(["guides/sibling", "elsewhere/recent", "guides/search", "other-search"]));
  expect(chosen.slice(0, 2)).toEqual(expect.arrayContaining(["guides/sibling", "guides/search"]));
  app.config.wiki.corrections.sweep = 2;
  expect(await correctionCandidates(app, correction())).toEqual(expect.arrayContaining(["guides/sibling", "guides/search"]));
  app.config.wiki.corrections.sweep = 0;
  expect(await correctionCandidates(app, correction())).toEqual([]);
  app.config.wiki.corrections.sweep = 15;
});

it("handles unknown provenance using search only and applies the total cap", async () => {
  const unknown = { ...correction(), pipeline: null };
  expect(new Set(await correctionCandidates(app, unknown))).toEqual(new Set(["guides/search", "other-search"]));
  for (let i = 0; i < 22; i++) seed("choice", `many-${i}`, "needlecorrection", "wiki-lint");
  expect(await correctionCandidates(app, unknown)).toHaveLength(15);
  app.config.wiki.corrections.sweep = 100;
  // The search's 20 hits include the corrected page, which is then excluded.
  expect(await correctionCandidates(app, unknown)).toHaveLength(19);
  app.config.wiki.corrections.sweep = 15;
});

it("keeps the last 20 short one-line lessons within their space and registers the portable table", () => {
  for (let i = 0; i < 22; i++) run(app.db, 'insert into page_corrections(id,space_id,slug,wrong,right,"by",at,updated_at) values(?,?,?,?,?,?,?,?)', `lesson-${i}`, "foreign", "example", `独立口径${i}\n${"长".repeat(250)}`, "独立答案", "owner", new Date(i * 1000).toISOString(), new Date().toISOString());
  const lessons = correctionLessons(app, "foreign").split("\n").filter((s) => s.startsWith("- "));
  expect(lessons).toHaveLength(20);
  expect(lessons[0]).toContain("独立口径21");
  expect(lessons.every((s) => s.length <= 202)).toBe(true);
  expect(correctionLessons(app, "flow")).toBe("");
  expect(pullTables.find((t) => t.name === "page_corrections")).toMatchObject({ key: ["id"], newer: "updated_at" });
  expect(configSchema.parse({}).wiki.corrections.sweep).toBe(15);
});

it("rewrites now, checks candidates over ACP, fixes only a matching page and notifies once with later urgency", async () => {
  cancelQueued();
  seed("flow", "guides/original", "错误样本");
  seed("flow", "guides/wrong", "错误样本");
  seed("flow", "guides/ok", "正确的示例正文");
  const created = createCorrection(app, "flow", { slug: "guides/original", wrong: "转写未取得", right: "原件里有转写" });
  startWorker(app);
  const done = await waitForRun(app, created.sweepRunId!);
  expect(done.status, done.error ?? "").toBe("done");
  expect(done.output).toMatchObject({ checked: 2, fixed: 1, found: ["guides/wrong"] });
  expect(listCorrections(app, "flow")[0]).toMatchObject({ checked: 2, fixed: 1, status: "swept", pipeline: "ingest" });
  expect(readPage(app, "flow", "guides/original").body).toBe("示例正文\n");
  expect(readPage(app, "flow", "guides/wrong").body).toBe("示例正文\n");
  expect(readPage(app, "flow", "guides/ok").body).toBe("正确的示例正文\n");
  const fixes = done.output.writeRuns as string[];
  expect(fixes).toHaveLength(1);
  expect(getRun(app, fixes[0]).input.instructions).toContain("说没有转写，原件里有转写");
  const events = JSON.stringify(all(app.db, "select data from run_events where run_id in (?,?,?)", done.id, created.writeRuns[0], fixes[0]));
  expect(events).toContain("本人指正过的错误");
  expect(events).toContain("转写未取得 → 原件里有转写");
  expect(events).toContain("本人指出过这类错误");
  expect(events).not.toContain("独立口径");
  const notices = all<{ title: string; body: string; context: string }>(app.db, "select title,body,context from notifications");
  expect(notices).toHaveLength(1);
  expect(notices[0].title).toContain("另外查了 2 页，其中 1 页有同样的问题，已经改了");
  expect(JSON.parse(notices[0].context)).toMatchObject({ urgency: "later", runId: done.id });
  expect(notices[0].body).toContain("#/wiki/flow/guides/wrong");
  expect(getRun(app, done.id).quiet).toBe(false);
}, 120000);

it("disables the sweep without losing the correction or sending an empty report", async () => {
  app.config.wiki.corrections.sweep = 0;
  const before = all(app.db, "select id from notifications").length;
  const created = createCorrection(app, "flow", { slug: "guides/original", wrong: "另一处错误", right: "新的口径" });
  expect(created.sweepRunId).toBeNull();
  const done = await waitForRun(app, created.writeRuns[0]);
  expect(done.status, done.error ?? "").toBe("done");
  expect(listCorrections(app, "flow")[0]).toMatchObject({ status: "swept", checked: 0, fixed: 0 });
  expect(all(app.db, "select id from notifications")).toHaveLength(before);
  expect(correctionLessons(app, "flow")).toContain("另一处错误 → 新的口径");
}, 120000);

it("counts no failed repair as fixed, and reports the failure without claiming it was corrected", async () => {
  createSpace(app, { id: "failed", name: "示例失败空间" });
  seed("failed", "original", "错误样本");
  seed("failed", "sibling", "错误样本");
  app.config.wiki.corrections.sweep = 15;
  writeFileSync(writeFile, "skip");
  const created = createCorrection(app, "failed", { slug: "original", wrong: "转写未取得", right: "原件里有转写" });
  const done = await waitForRun(app, created.sweepRunId!);
  writeFileSync(writeFile, "corrections");
  expect(done.status, done.error ?? "").toBe("done");
  expect(done.output).toMatchObject({ checked: 1, fixed: 0, found: ["sibling"] });
  expect(listCorrections(app, "failed")[0]).toMatchObject({ status: "swept", checked: 1, fixed: 0 });
  expect(readPage(app, "failed", "sibling").body).toBe("错误样本\n");
  const n = one<{ title: string }>(app.db, "select title from notifications where json_extract(context, '$.runId') = ?", done.id)!;
  expect(n.title).toContain("已改 0 页，其余未改成");
  expect(n.title).not.toContain("已经改了");
}, 120000);

it("keeps a sweep with no matching mistakes quiet and still sends one later report when pages were checked", async () => {
  createSpace(app, { id: "clean", name: "示例正确空间" });
  seed("clean", "original");
  seed("clean", "sibling");
  const created = createCorrection(app, "clean", { slug: "original", wrong: "旧口径", right: "新口径" });
  const done = await waitForRun(app, created.sweepRunId!);
  expect(done.status, done.error ?? "").toBe("done");
  expect(done).toMatchObject({ quiet: true, output: { checked: 1, fixed: 0 } });
  expect(listCorrections(app, "clean")[0]).toMatchObject({ checked: 1, fixed: 0, status: "swept" });
  expect(all(app.db, "select id from notifications where json_extract(context, '$.runId') = ?", done.id)).toHaveLength(1);
}, 120000);
