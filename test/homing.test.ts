import { afterEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createRun, getRun, listRuns } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { now } from "../src/core/util.ts";
import { upsertItem } from "../src/items/store.ts";
import { search } from "../src/search/search.ts";
import { vectorIndex } from "../src/search/vectors.ts";
import { moveSource, prepareArchive, saveArchiveRule, sourceRoute } from "../src/sources/archive.ts";
import { assignSources, collectRecheck, followWorkFiles, homingOverview, matterSpace, returnSource, sweepHoming } from "../src/sources/homing.ts";
import { citationReach, queueUnreachable } from "../src/sources/reach.ts";
import { getSource, readSource, sourceText, upsertSource } from "../src/sources/store.ts";
import { writeWorkFile } from "../src/sources/work.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
function setup() {
  const app = testApp();
  apps.push(app);
  createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
  createSpace(app, { id: "project-b", name: "项目 B", kind: "project" });
  return app;
}
afterEach(async () => {
  apps.splice(0).forEach((a) => a.db.close());
  vectorIndex().clear();
  await setImmediate();
});
type App = ReturnType<typeof setup>;
/** A source in the personal space the archivist already kept there. */
function kept(app: App, uri: string, title = uri) {
  const s = upsertSource(app, { spaceId: "personal", kind: "doc", uri, title, text: `${title}：退款流程说明` });
  run(app.db, "update source_routes set mode = 'fallback', reason = '未命中归档规则，暂存个人空间', decision_hash = (select hash from sources where id = ?) where source_id = ?", s.id, s.id);
  return s.id;
}
const page = (app: App, space: string, slug: string, cites: string[]) => {
  run(app.db, "insert or replace into pages(id, space_id, slug, title, body, hash, updated_at) values(?,?,?,?,?,?,?)", `${space}/${slug}`, space, slug, `页面 ${slug}`, "正文", "h", now());
  for (const id of cites) run(app.db, "insert into page_cites(page_id, source_id, line_start, line_end, hash) values(?,?,1,1,'h')", `${space}/${slug}`, id);
};

describe("judging kept sources again", () => {
  it("queues by evidence priority, hands at most the budget to the archivist, and keeps the rest for later nights", () => {
    const app = setup();
    const ids = ["a", "b", "c"].map((x) => kept(app, `doc/${x}`));
    const memo = kept(app, "doc/memo");
    for (const id of ids) page(app, "project-a", `p-${id}`, [id]);
    run(app.db, "insert into memories(id, space_id, kind, content, source_refs, created_at, updated_at) values('m1', 'project-b', 'fact', '退款走原路', ?, ?, ?)", JSON.stringify([`src:${memo}#L1`]), now(), now());
    const report = sweepHoming(app, { budget: 2 });
    expect(report.found).toMatchObject({ citedByPage: 3, cited: 1 });
    expect(report).toMatchObject({ queued: 2, left: 2 });
    const archive = listRuns(app, { kind: "archive" });
    expect(archive).toHaveLength(1);
    // Cited by pages first; the memory-cited one waits.
    expect((archive[0].input.sourceIds as string[]).every((id) => ids.includes(id))).toBe(true);
    expect(one<{ priority: number }>(app.db, "select priority from archive_recheck where source_id = ?", memo)?.priority).toBe(1);
    expect(homingOverview(app).queue.reduce((a, q) => a + q.n, 0)).toBe(2);
  });

  it("starts no run when there is nothing to judge, and records the first state of spaces and rules without queueing", () => {
    const app = setup();
    kept(app, "doc/a");
    expect(sweepHoming(app)).toMatchObject({ queued: 0, left: 0 });
    expect(listRuns(app, { kind: "archive" })).toHaveLength(0);
    // A new space (or archive rule) puts every kept source back in line, last.
    createSpace(app, { id: "project-c", name: "项目 C", kind: "project", description: "退款改造" });
    expect(collectRecheck(app).context).toBe(1);
    expect(one<{ priority: number }>(app.db, "select priority from archive_recheck")?.priority).toBe(3);
  });

  it("moves what an archive rule now decides without spending the budget", () => {
    const app = setup();
    const id = kept(app, "doc/rule", "项目 A 周报");
    collectRecheck(app);
    saveArchiveRule(app, { name: "项目 A", description: "", enabled: true, target: "project-a", conditions: { field: "title", op: "contains", value: "项目 A" } });
    expect(sweepHoming(app, { budget: 0 })).toMatchObject({ byRule: 1, queued: 0 });
    expect(getSource(app, id).spaceId).toBe("project-a");
    expect(sourceRoute(app, id)?.mode).toBe("rule");
  });
});

describe("the owner's say", () => {
  it("moves an automatic move back, remembers it, and never queues it again", () => {
    const app = setup();
    const id = kept(app, "doc/back");
    moveSource(app, id, "project-a", "旁证都指向项目 A", "ai", undefined, undefined, { citedBy: [{ space: "project-a" }] });
    const entry = homingOverview(app).moved[0];
    expect(entry).toMatchObject({ sourceId: id, from: "personal", to: "project-a", mode: "ai", returnable: true, detail: { citedBy: [{ space: "project-a" }] } });
    returnSource(app, id);
    expect(getSource(app, id).spaceId).toBe("personal");
    expect(sourceRoute(app, id)?.mode).toBe("manual");
    expect(homingOverview(app).moved[0].returnable).toBe(false);
    page(app, "project-a", "cites", [id]);
    expect(collectRecheck(app).citedByPage).toBe(0);
    // Captured again: stays where the owner put it.
    const s = getSource(app, id);
    expect(prepareArchive(app, { ...s, text: sourceText(app, id), archive: true })?.input.spaceId).toBe("personal");
  });

  it("files undecided sources in a batch, or keeps them here, pinned either way", async () => {
    const app = setup();
    const r = createRun(app, { kind: "archive", spaceId: "personal", title: "判断材料归属", input: { sourceIds: [] } });
    const ids = ["x", "y", "z"].map((x) => kept(app, `doc/${x}`));
    run(app.db, "update runs set input = ? where id = ?", JSON.stringify({ sourceIds: ids }), r.id);
    run(app.db, "update source_routes set pending = 1 where source_id in (?,?,?)", ...ids);
    const ctx: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "archivist" };
    for (const id of ids) {
      const res = await callTool(ctx, "classify_source", { source_id: id, hash: getSource(app, id).hash, space: "personal", verdict: "unsure", candidates: ["project-a", "project-b"], reason: "两个项目都提到" });
      expect(res.isError).toBe(false);
    }
    expect(homingOverview(app).undecided.map((u) => u.id).sort()).toEqual([...ids].sort());
    expect(assignSources(app, ids.slice(0, 2), "project-b").every((x) => x.ok)).toBe(true);
    expect(assignSources(app, [ids[2]], "personal")[0].ok).toBe(true);
    expect(ids.map((id) => getSource(app, id).spaceId)).toEqual(["project-b", "project-b", "personal"]);
    expect(ids.map((id) => sourceRoute(app, id)?.mode)).toEqual(["manual", "manual", "manual"]);
    expect(homingOverview(app).undecided).toHaveLength(0);
  });

  it("with automatic moves off, the archivist's call for a business space waits for the owner", async () => {
    const app = setup();
    app.config.archive.autoMove = false;
    const s = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "doc/off", title: "接口说明", text: "项目 A 的接口", archive: true });
    const r = listRuns(app, { kind: "archive" })[0];
    const ctx: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "archivist" };
    expect((await callTool(ctx, "classify_source", { source_id: s.id, hash: getSource(app, s.id).hash, space: "project-a", verdict: "business", reason: "讲项目 A 的接口" })).isError).toBe(false);
    expect(getSource(app, s.id).spaceId).toBe("personal");
    expect(homingOverview(app).undecided[0]).toMatchObject({ id: s.id, verdict: "proposed", suggested: ["project-a"] });
  });
});

describe("working files follow the work", () => {
  it("writes into the item's space from a personal run, moves older files along, and leaves files the owner put back", async () => {
    const app = setup();
    const item = upsertItem(app, undefined, { spaceId: "project-a", kind: "todo", title: "退款对账" });
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "对账", input: { itemId: item.id } });
    expect(matterSpace(app, r.id, "personal")).toMatchObject({ space: "project-a" });
    const earlier = writeWorkFile(app, { spaceId: "personal", path: "recon/progress", text: "第一批" });
    const ctx: ToolContext = { app, runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "assistant" };
    const res = await callTool(ctx, "write_file", { path: "recon/progress", content: "第二批", mode: "append" });
    expect(res.text).toContain("跟着事项「退款对账」");
    expect(getSource(app, earlier.id)).toMatchObject({ spaceId: "project-a" });
    expect(sourceText(app, earlier.id)).toContain("第一批");
    // Asked for the personal space: stays there.
    await callTool(ctx, "write_file", { path: "notes/mine", content: "自己的", space: "personal" });
    expect(all<{ space_id: string }>(app.db, "select space_id from sources where uri = 'work/notes/mine'")[0].space_id).toBe("personal");
    // A run about two spaces names none.
    const two = createRun(app, { kind: "agent", spaceId: "personal", title: "两件事", input: { itemId: item.id, conversationId: "c1" } });
    run(app.db, "insert into conversations(id, space_id, title, created_at, updated_at) values('c1', 'project-b', '项目 B', ?, ?)", now(), now());
    run(app.db, "delete from run_scope where run_id = ?", two.id);
    expect(matterSpace(app, two.id, "personal")).toBeNull();
    expect(getRun(app, two.id)).toBeTruthy();
  });

  it("moves earlier working files of a business item out of the personal space each night; one moved back stays", () => {
    const app = setup();
    const item = upsertItem(app, undefined, { spaceId: "project-b", kind: "todo", title: "上线检查" });
    const f = writeWorkFile(app, { spaceId: "personal", path: "launch/check", text: "清单", links: { item: item.id } });
    expect(followWorkFiles(app)).toBe(1);
    expect(getSource(app, f.id).spaceId).toBe("project-b");
    expect(homingOverview(app).moved[0]).toMatchObject({ sourceId: f.id, mode: "follow", returnable: true });
    returnSource(app, f.id);
    expect(getSource(app, f.id).spaceId).toBe("personal");
    expect(followWorkFiles(app)).toBe(0);
  });
});

describe("citations readers cannot open", () => {
  it("goes by the space's readers, resolves merged duplicates, and sends personal ones to be judged first", () => {
    const app = setup();
    const mine = kept(app, "doc/mine", "退款方案草稿");
    const own = upsertSource(app, { spaceId: "project-a", kind: "doc", uri: "doc/own", title: "项目 A 文档", text: "正文" }).id;
    const other = upsertSource(app, { spaceId: "project-b", kind: "doc", uri: "doc/other", title: "项目 B 文档", text: "正文" }).id;
    run(app.db, "insert into source_aliases(alias_id, source_id, reason, created_at) values('s_old', ?, 'merge', ?)", mine, now());
    page(app, "project-a", "refund", ["s_old", own, other]);
    // Only the owner reads project A: nothing is out of reach.
    expect(citationReach(app, "project-a").entries).toHaveLength(0);
    createUser(app, { id: "colleague", name: "小王" });
    addMember(app, "project-a", "colleague", "reader");
    const r = citationReach(app, "project-a");
    expect(r.readers.sort()).toEqual(["colleague", "owner"]);
    expect(r.entries.map((e) => [e.sourceId, e.blocked, e.rejudgeable]).sort()).toEqual([[mine, ["colleague"], true], [other, ["colleague"], false]].sort());
    // The colleague asking sees no title of what they may not read.
    expect(citationReach(app, "project-a", "colleague").entries.every((e) => e.title === "")).toBe(true);
    expect(queueUnreachable(app, "project-a")).toEqual({ queued: 1, found: 1 });
    expect(one<{ priority: number; source_id: string }>(app.db, "select priority, source_id from archive_recheck")).toEqual({ priority: 0, source_id: mine });
    // Readable once it is filed into project A.
    moveSource(app, mine, "project-a", "本人指定");
    expect(citationReach(app, "project-a").entries.map((e) => e.sourceId)).toEqual([other]);
  });
});

describe("a moved source is still found", () => {
  it("search, reading and citations by id follow it into the new space; a recapture reaches the same original", async () => {
    const app = setup();
    const s = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://example.com/refund", title: "退款对账说明", text: "退款对账每天凌晨跑一次", archive: true });
    page(app, "project-a", "x", [s.id]);
    moveSource(app, s.id, "project-a", "旁证都指向项目 A", "ai");
    const inA = await search(app, "退款对账", { spaces: ["project-a"] });
    expect(inA.some((h) => h.sourceId === s.id)).toBe(true);
    const inPersonal = await search(app, "退款对账", { spaces: ["personal"] });
    expect(inPersonal.some((h) => h.sourceId === s.id)).toBe(false);
    expect(readSource(app, s.id).source.spaceId).toBe("project-a");
    expect(citationReach(app, "project-a").citedSources).toBe(1);
    const again = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://example.com/refund", title: "退款对账说明", text: "退款对账每天凌晨两点跑一次", archive: true });
    expect(again.id).toBe(s.id);
    expect(getSource(app, s.id).spaceId).toBe("project-a");
    expect(all(app.db, "select id from sources where uri = 'https://example.com/refund'")).toHaveLength(1);
    // Not waiting for the archivist again for the new text: the AI's decision stands.
    expect(sourceRoute(app, s.id)).toMatchObject({ mode: "ai", pending: 0 });
  });
});
