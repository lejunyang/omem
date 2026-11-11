import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, listRuns, startWorker, stopWorker } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all } from "../src/core/db.ts";
import { createSpace, relateSpaces, updateSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { importText } from "../src/sources/import.ts";
import { pageExists, readPage } from "../src/wiki/store.ts";
import { getGeneration, pageChecks, reportText, startGeneration } from "../src/wiki/verify.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { getRun } from "../src/agents/runs.ts";
import { listQuestions } from "../src/wiki/questions.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
for (const id of ["project", "materials"]) createSpace(app, { id, name: id === "project" ? "项目 A" : "材料", kind: "project" });
relateSpaces(app, "project", "materials", { origin: "owner" });
importText(app, "materials", { uri: "README.md", text: "项目 A 的示例材料" });
const dir = mkdtempSync(join(tmpdir(), "omem-wiki-verify-"));
const checkFile = join(dir, "check");
const writeFile = join(dir, "write");
app.config.agents.default = "fake";
app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "wiki", FAKE_WIKI_CHECK_FILE: checkFile, FAKE_WIKI_WRITE_FILE: writeFile } })];
const server = await startServer(app, { port: 0, quiet: true });
startWorker(app);
afterAll(async () => {
  stopWorker();
  await server.close();
});

const brief = (slug: string, title: string) => ({ slug, title, kind: "guide", question: "怎么开始？", outline: "以示例说明", entry_points: ["materials:README.md"] });
/** A generation of writing runs, as a plan queues them; resolves with its report once settled. */
async function generate(id: string, pages: { slug: string; title: string }[]) {
  const writes = pages.map((p) => ({ ...p, runId: createRun(app, { kind: "wiki-write", spaceId: "project", title: `写作：${p.title}`, input: { brief: brief(p.slug, p.title), readSpaces: ["project", "materials"] } }).id }));
  startGeneration(app, { id, spaceId: "project", writes });
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const g = getGeneration(app, id);
    if (g?.reportedAt) return g;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("generation did not settle");
}
const lastNotice = () => all<{ title: string; body: string; context: string }>(app.db, "select title, body, context from notifications order by at desc limit 1")[0];

it("revises a page the checker found wrong, publishes it once it passes, and reports quietly", async () => {
  writeFileSync(checkFile, "once");
  const g = await generate("g1", [{ slug: "overview", title: "概览" }]);
  expect(readPage(app, "project", "overview").body).toBe("示例正文（已按核对改）\n");
  const rec = pageChecks(app, "project", "overview")[0];
  expect(rec).toMatchObject({ status: "passed", rounds: 2, fixed: 1, open: [] });
  expect(rec.history[0].findings[0]).toMatchObject({ kind: "negative" });
  expect(g.report).toMatchObject({ written: [{ slug: "overview" }], fixed: 1, open: [], missing: [] });
  const n = lastNotice();
  expect(n.title).toContain("写完了 1 页");
  expect(JSON.parse(n.context).urgency).toBe("silent");
  expect(n.body).toContain("核对后改正 1 处");
}, 120000);

it("leaves what is still wrong after the last round in the record and in the one message to the owner", async () => {
  writeFileSync(checkFile, "always");
  const g = await generate("g2", [{ slug: "overview", title: "概览" }]);
  const rec = pageChecks(app, "project", "overview")[0];
  expect(rec).toMatchObject({ status: "open", rounds: 3 });
  expect(rec.open).toHaveLength(1);
  expect(g.report!.open[0]).toMatchObject({ slug: "overview" });
  const n = lastNotice();
  expect(n.title).toContain("1 条要你看");
  expect(JSON.parse(n.context).urgency).toBe("normal");
  expect(n.body).toContain("说没有转写，原件里有转写");
  expect(n.body).toContain("#/wiki/project/overview");
}, 120000);

it("tries a planned page that was not written once more, then reports it as missing", async () => {
  writeFileSync(checkFile, "pass");
  // The fake writer always writes `overview`: the page `faq` never gets its draft.
  const g = await generate("g3", [{ slug: "overview", title: "概览" }, { slug: "faq", title: "常见问题" }]);
  expect(pageExists(app, "project", "faq")).toBe(false);
  expect(g.pages.find((p) => p.slug === "faq")!.runs).toHaveLength(2);
  expect(listRuns(app, { kind: "wiki-write", limit: 50 }).filter((r) => r.title.startsWith("重写：常见问题"))).toHaveLength(1);
  expect(g.report!.missing).toEqual([{ slug: "faq", title: "常见问题", reason: expect.stringContaining("没有提交页面") }]);
  expect(g.report!.written.map((p) => p.slug)).toEqual(["overview"]);
  expect(reportText(g, g.report!)).toContain("没写成「常见问题」");
  expect(lastNotice().title).toContain("要你看");
}, 120000);

it("saves at once and records it when the space turned checking off", async () => {
  updateSpace(app, "project", { settings: { wikiVerify: false } });
  writeFileSync(checkFile, "always");
  await generate("g4", [{ slug: "overview", title: "概览" }]);
  expect(readPage(app, "project", "overview").body).toBe("示例正文\n");
  expect(pageChecks(app, "project", "overview")[0]).toMatchObject({ status: "off", rounds: 0 });
  updateSpace(app, "project", { settings: { wikiVerify: true } });
}, 120000);

it("sends a page over the length limit back to be split, whatever the checker says", async () => {
  writeFileSync(checkFile, "pass");
  writeFileSync(writeFile, "long");
  await generate("g5", [{ slug: "overview", title: "概览" }]);
  writeFileSync(writeFile, "write");
  const rec = pageChecks(app, "project", "overview")[0];
  // The checker passed it; the host's own length finding sent it back once, and the shorter version passed.
  expect(rec.history[0].findings).toEqual([expect.objectContaining({ kind: "length", basis: expect.stringContaining("宿主") })]);
  expect(rec).toMatchObject({ status: "passed", rounds: 2, fixed: 1 });
  expect(readPage(app, "project", "overview").body).toBe("示例正文（已按核对改）\n");
}, 120000);

it("takes what nobody is sure of out of the page, asks the owner once, and fills the answers in", async () => {
  writeFileSync(checkFile, "unsure");
  writeFileSync(writeFile, "questions");
  const g = await generate("g6", [{ slug: "overview", title: "概览" }]);
  writeFileSync(writeFile, "write");
  writeFileSync(checkFile, "pass");
  const rec = pageChecks(app, "project", "overview")[0];
  expect([...(rec.questions ?? [])].sort()).toEqual(["A 业务的退款上限是多少？", "退款是原路退回还是退到余额？"].sort());
  // Both became the page's open questions, outside the page; an agent looked first and settled one itself.
  expect(readPage(app, "project", "overview").body).not.toMatch(/待确认|还没查清/);
  const qs = listQuestions(app, { spaceId: "project", page: "overview", status: ["open", "needs-owner", "asked", "answered", "resolved"] });
  expect(qs.map((q) => [q.question, q.source, q.status]).sort()).toEqual([
    ["A 业务的退款上限是多少？", "checker", "asked"],
    ["退款是原路退回还是退到余额？", "writer", "resolved"],
  ]);
  expect(g.resolveRunId).toBeTruthy();
  expect(g.report).toMatchObject({ resolvedByAgent: 1, moreInList: 0 });
  expect(g.report!.questions.map((q) => q.question)).toEqual(["A 业务的退款上限是多少？"]);
  const n = lastNotice();
  expect(n.title).toContain("1 个问题要你定");
  expect(n.body).toContain("1 个问题已经查清");
  // One form, opened from that message rather than announced on its own.
  const ask = getAsk(app, g.report!.askId!);
  expect(ask).toMatchObject({ kind: "question", handler: "wiki-questions", status: "pending" });
  expect(ask.ui?.fields).toHaveLength(1);
  const before = listRuns(app, { kind: "wiki-write", limit: 100 }).length;
  await answerAsk(app, ask.id, { value: { [ask.ui!.fields![0].id]: "3000 元" }, by: "owner" });
  const after = listRuns(app, { kind: "wiki-write", limit: 100 });
  expect(after.length).toBe(before + 1);
  const instructions = String((getRun(app, after[0].id).input as { instructions?: string }).instructions);
  expect(instructions).toContain("答：3000 元");
  expect(instructions).not.toContain("原路退回");
  // The page written with the answer closes the question.
  const until = Date.now() + 60_000;
  while (getRun(app, after[0].id).status !== "done" && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  expect(listQuestions(app, { spaceId: "project", page: "overview", status: ["resolved"] }).map((q) => q.question).sort()).toEqual(["A 业务的退款上限是多少？", "退款是原路退回还是退到余额？"].sort());
}, 120000);
