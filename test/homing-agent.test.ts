import { resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { listRuns, startWorker, waitForRun, type Run } from "../src/agents/runs.ts";
import { setChatSettings } from "../src/agents/threads.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { now } from "../src/core/util.ts";
import { startServer } from "../src/server/http.ts";
import { REJUDGE, sourceRoute } from "../src/sources/archive.ts";
import { collectRecheck, sweepHoming } from "../src/sources/homing.ts";
import { getSource, upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

// The archivist through the real ACP + MCP path (test/fake-acp-agent.ts FAKE_MODE=archive): the
// host's evidence reaches the task, the agent files by it, and new evidence sends a kept source back.
const app = testApp();
createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
createSpace(app, { id: "project-b", name: "项目 B", kind: "project" });
app.config.agents.default = "fake";
app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "archive" } })];
const server = await startServer(app, { port: 0, quiet: true });
afterAll(() => server.close());

const page = (space: string, slug: string, cites: string[]) => {
  run(app.db, "insert or replace into pages(id, space_id, slug, title, body, hash, updated_at) values(?,?,?,?,?,?,?)", `${space}/${slug}`, space, slug, slug, "正文", "h", now());
  for (const id of cites) run(app.db, "insert into page_cites(page_id, source_id, line_start, line_end, hash) values(?,?,1,1,'h')", `${space}/${slug}`, id);
};
const doc = (uri: string, title: string, meta: Record<string, unknown> = {}, spaceId = "personal", archive = true) =>
  upsertSource(app, { spaceId, kind: "doc", uri, title, text: `${title}\n会议记录与安排`, meta, archive });
async function finish(r: Run) {
  const done = await waitForRun(app, r.id);
  expect(done.status, done.error ?? "").toBe("done");
  return JSON.parse(String(done.output.summary)) as { id: string; again: string | null; evidence: string[]; space: string; verdict: string; error: unknown }[];
}

it("hands the archivist the evidence and files by it; contradictions and no evidence stay with a verdict", async () => {
  // A knowledge base the owner filed under project A, a folder whose other page is already there.
  run(app.db, "insert into wiki_spaces(id, name, status, target_space, discovered_at) values('kb1', '项目 A 知识库', 'mapped', 'project-a', ?)", now());
  doc("https://tenant.larkoffice.com/wiki/SIBLING00001", "周会 9 月", { wikiSpaceId: "kb1", wikiParentNodeToken: "P1" }, "project-a", false);
  const wiki = doc("https://tenant.larkoffice.com/wiki/WEEKLY000001", "周会 10 月", { wikiSpaceId: "kb1", wikiSpaceName: "项目 A 知识库", wikiPath: "项目 A / 周会", wikiParentTitle: "周会", wikiParentNodeToken: "P1" });
  const plain = doc("note/books", "读书笔记");
  const mixed = doc("https://tenant.larkoffice.com/docx/MIXED0000001", "排期草稿");
  const linked = doc("https://tenant.larkoffice.com/docx/LINKED000001", "接口说明");
  page("project-a", "plan", [mixed.id]);
  run(app.db, "insert into items(id, space_id, kind, title, source_refs, created_at, updated_at) values('it1', 'project-b', 'todo', '核对排期', ?, ?, ?)", JSON.stringify([`src:${mixed.id}#L1`]), now(), now());
  setChatSettings(app, "lark", "oc_b", { spaceId: "project-b" });
  run(app.db, "insert into lark_messages(message_id, chat_id, content, create_ms) values('m1', 'oc_b', '接口说明见 https://tenant.larkoffice.com/docx/LINKED000001', 1)");

  const archive = listRuns(app, { kind: "archive" });
  expect(archive).toHaveLength(1);
  startWorker(app);
  const out = await finish(archive[0]);
  expect(out.every((r) => !r.error)).toBe(true);
  expect(out.find((r) => r.id === wiki.id)?.evidence).toEqual(expect.arrayContaining(["wiki", "siblings"]));
  expect(out.find((r) => r.id === linked.id)?.evidence).toEqual(["linkedIn"]);

  expect(getSource(app, wiki.id).spaceId).toBe("project-a");
  expect(getSource(app, linked.id).spaceId).toBe("project-b");
  const move = one<{ mode: string; detail: string }>(app.db, "select mode, detail from source_moves where source_id = ? order by id desc limit 1", wiki.id)!;
  expect(move.mode).toBe("ai");
  expect(JSON.parse(move.detail)).toMatchObject({ wiki: { kbSpace: "project-a" }, siblings: [{ space: "project-a", n: 1 }] });

  expect(getSource(app, plain.id).spaceId).toBe("personal");
  expect(sourceRoute(app, plain.id)).toMatchObject({ mode: "fallback", verdict: "personal", pending: 0 });
  expect(getSource(app, mixed.id).spaceId).toBe("personal");
  expect(sourceRoute(app, mixed.id)).toMatchObject({ verdict: "unsure" });
  expect(JSON.parse(sourceRoute(app, mixed.id)!.suggested as unknown as string).sort()).toEqual(["project-a", "project-b"]);
  // What each was judged with is kept: the same evidence does not queue it again.
  expect(one(app.db, "select 1 from archive_evidence where source_id = ?", mixed.id)).toBeTruthy();
  expect(collectRecheck(app).citedByPage).toBe(0);
});

it("judges a kept source again when new evidence appears, within the nightly budget, and starts nothing without any", async () => {
  const plain = all<{ id: string }>(app.db, "select id from sources where uri = 'note/books'")[0];
  page("project-b", "reading", [plain.id]);
  const before = listRuns(app, { kind: "archive" }).length;
  const report = sweepHoming(app, { budget: 5 });
  expect(report).toMatchObject({ queued: 1, left: 0, found: { citedByPage: 1 } });
  expect(sourceRoute(app, plain.id)?.reason.startsWith(REJUDGE)).toBe(true);
  const again = listRuns(app, { kind: "archive" }).filter((r) => r.status !== "done");
  expect(again).toHaveLength(1);
  const out = await finish(again[0]);
  expect(out[0]).toMatchObject({ id: plain.id, space: "project-b" });
  expect(out[0].again).toContain("Wiki 页面引用");
  expect(getSource(app, plain.id).spaceId).toBe("project-b");

  // Nothing new: no run.
  const runs = listRuns(app, { kind: "archive" }).length;
  expect(sweepHoming(app, { budget: 5 })).toMatchObject({ queued: 0 });
  expect(listRuns(app, { kind: "archive" })).toHaveLength(runs);
  expect(runs).toBe(before + 1);
});
