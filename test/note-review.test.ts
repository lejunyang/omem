import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scheduleNoteReview } from "../src/agents/jobs.ts";
import { __testHandlers, createRun, getRun } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { ensureDefaultSchedules, listSchedules } from "../src/core/scheduler.ts";
import { addSourceNote, noteFactor, noteReviewCandidates, noteStrength, noteText, reviewQueue, reviewSourceNote, sourceNotes, type NoteStatus } from "../src/sources/attention.ts";
import { upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const fresh = () => { const app = testApp(); apps.push(app); return app; };
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const app of apps.splice(0)) app.db.close(); });
const source = (app: ReturnType<typeof testApp>, spaceId = "personal") => upsertSource(app, { spaceId, kind: "note", uri: `note:${spaceId}`, title: "项目 A 约定", text: "第一行\n第二行\n第三行" });
const note = (app: ReturnType<typeof testApp>, sourceId: string, extra: Partial<Parameters<typeof addSourceNote>[1]> = {}) =>
  addSourceNote(app, { sourceId, kind: "wrong", note: "以更新的约定为准", by: "agent", lineStart: 1, ...extra }).id;
const ctx = (app: ReturnType<typeof testApp>, extra = {}) => toolContextForToken(app, issueToolToken({ runId: null, actor: "agent", role: "note-reviewer", spaceId: "personal", spaces: ["personal"], tools: null, agentProfile: "judge", model: "model-b", ...extra }))!;

describe("independent source note review", () => {
  it.each<[NoteStatus, number]>([["pending", 0.5], ["reviewed", 0.8], ["confirmed", 1], ["rejected", 0]])("%s has strength %s", (status, strength) => {
    expect(noteStrength({ by: "agent", status, staleAt: null })).toBe(strength);
    expect(noteStrength({ by: "agent", status, staleAt: "changed" })).toBe(0);
  });

  it("only owner judgements can remove wrong or excluded passages", () => {
    const app = fresh(), s = source(app);
    note(app, s.id);
    const n = sourceNotes(app, s.id)[0];
    expect(noteStrength({ ...n, by: "owner" })).toBe(1);
    for (const kind of ["wrong", "exclude"] as const) {
      expect(noteFactor({ ...n, kind, status: "reviewed" }, 1, 1)).toMatchObject({ drop: false });
      expect(noteFactor({ ...n, kind, status: "confirmed" }, 1, 1).drop).toBe(true);
    }
    expect(noteText({ ...n, status: "reviewed" })).toContain("；Agent 标的，另一个模型复核过");
    expect(noteText(n)).toContain("待本人确认");
    expect(noteText({ ...n, reviewedAt: "today" })).toContain("；复核拿不准，待本人确认");
  });

  it("keeps, rewrites, rejects and leaves uncertain notes for the owner, skipping other states and scopes", async () => {
    const app = fresh(), s = source(app);
    createSpace(app, { id: "other", name: "项目 B" });
    const keep = note(app, s.id), reject = note(app, s.id, { lineStart: 2 }), unsure = note(app, s.id, { lineStart: 3 });
    const owner = note(app, s.id, { kind: "key", by: "owner" });
    const confirmed = note(app, s.id, { kind: "exclude" });
    reviewSourceNote(app, confirmed, "confirm");
    const outside = note(app, source(app, "other").id);
    const r = await callTool(ctx(app), "review_notes", { verdicts: [
      { note_id: keep, verdict: "keep", reason: "新约定第二行支持", note: "现行按第二行执行" },
      { note_id: reject, verdict: "reject", reason: "比较的是不同版本", note: "不该替换" },
      { note_id: unsure, verdict: "unsure", reason: "两个原件口径冲突" },
      ...[owner, confirmed, outside].map((note_id) => ({ note_id, verdict: "reject", reason: "不能修改" })),
    ] });
    expect(r.isError).toBe(false);
    expect(r.text.match(/跳过/g)).toHaveLength(3);
    const rows = sourceNotes(app, s.id);
    expect(rows.find((n) => n.id === keep)).toMatchObject({ status: "reviewed", note: "现行按第二行执行", reviewedBy: "judge · model-b", reviewNote: "新约定第二行支持" });
    expect(rows.find((n) => n.id === reject)).toMatchObject({ status: "rejected", note: "以更新的约定为准" });
    expect(rows.find((n) => n.id === unsure)).toMatchObject({ status: "pending", reviewedAt: expect.any(String) });
    expect(noteReviewCandidates(app, "personal", 20)).toEqual([]);
    expect(sourceNotes(app, s.id).find((n) => n.id === owner)?.status).toBe("confirmed");
    expect(sourceNotes(app, source(app, "other").id)[0].status).toBe("pending");
    expect(note(app, s.id, { lineStart: 2 })).toBe(reject);
    reviewSourceNote(app, reject, "confirm");
    expect(sourceNotes(app, s.id).find((n) => n.id === reject)?.status).toBe("confirmed");
    expect((await callTool(ctx(app, { role: "ingest" }), "review_notes", { verdicts: [] })).isError).toBe(true);
  });

  it("orders ranking judgements before impact and age; excludes stale, deleted and previously reviewed notes", () => {
    const app = fresh(), s = source(app);
    const ordinary = note(app, s.id, { kind: "note" });
    const old = note(app, s.id, { lineStart: 1 }), recent = note(app, s.id, { lineStart: 2 }), impact = note(app, s.id, { lineStart: 3 });
    run(app.db, "update source_notes set created_at = '2020-01-01' where id = ?", old);
    for (const id of [ordinary, impact]) run(app.db, "insert into source_note_hits(note_id,n,at) values(?, ?, '2026-01-01')", id, id === ordinary ? 100 : 3);
    expect(noteReviewCandidates(app, "personal", 20).map((n) => n.id)).toEqual([impact, old, recent, ordinary]);
    expect(noteReviewCandidates(app, "personal", 1)[0].passage).toBe("第三行");
    run(app.db, "update source_notes set stale_at = 'changed' where id = ?", impact);
    run(app.db, "update source_notes set reviewed_at = 'reviewed' where id = ?", old);
    expect(noteReviewCandidates(app, "personal", 20).map((n) => n.id)).toEqual([recent, ordinary]);
    run(app.db, "update sources set deleted_at = 'deleted' where id = ?", s.id);
    expect(noteReviewCandidates(app, "personal", 20)).toEqual([]);
  });

  it("queues one run per candidate space and no further runs while any is queued or running", () => {
    const app = fresh();
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.id === "note-review")).toMatchObject({ cron: "35 * * * *", enabled: true });
    createSpace(app, { id: "other", name: "项目 B" });
    note(app, source(app).id); note(app, source(app, "other").id);
    expect(scheduleNoteReview(app).map((r) => r.spaceId).sort()).toEqual(["other", "personal"]);
    expect(scheduleNoteReview(app)).toEqual([]);
    run(app.db, "update runs set status = 'running' where kind = 'note-review'");
    expect(scheduleNoteReview(app)).toEqual([]);
    run(app.db, "update runs set status = 'done' where kind = 'note-review'");
    app.config.notes.review.enabled = false;
    expect(scheduleNoteReview(app)).toEqual([]);
  });

  it("shows uncertain ranking and stale notes, counts outcomes and offers recent rejections to restore", async () => {
    const app = fresh(), s = source(app);
    const pending = note(app, s.id), unsure = note(app, s.id, { lineStart: 2 }), stale = note(app, s.id, { lineStart: 3 });
    const kept = note(app, s.id, { kind: "key" }), rejected = note(app, s.id, { kind: "exclude" });
    const oldRejection = note(app, s.id, { kind: "outdated" });
    await callTool(ctx(app), "review_notes", { verdicts: [
      { note_id: unsure, verdict: "unsure", reason: "口径冲突" }, { note_id: kept, verdict: "keep", reason: "原文支持" },
      ...[rejected, oldRejection].map((note_id) => ({ note_id, verdict: "reject", reason: "无依据" })),
    ] });
    run(app.db, "update source_notes set stale_at = 'changed' where id = ?", stale);
    run(app.db, "update source_notes set reviewed_at = '2000-01-01' where id = ?", oldRejection);
    const q = reviewQueue(app, "personal");
    expect(q.notes.map((n) => n.id).sort()).toEqual([unsure, stale].sort());
    expect(q.notes.some((n) => n.id === pending)).toBe(false);
    expect(q.counts).toEqual({ pending: 2, reviewed: 1, rejected: 2 });
    expect(q.rejected.map((n) => n.id)).toEqual([rejected]);
    expect(q.notes.find((n) => n.id === unsure)?.reviewNote).toBe("口径冲突");
  });

  it("runs the real ACP/MCP handler, hides authors and retries omitted verdicts", async () => {
    const app = fresh(), s = source(app);
    const id = note(app, s.id), omitted = note(app, s.id, { lineStart: 2 });
    const log = join(app.home, "prompts.jsonl");
    // The fake agent's existing script mode calls tools from @call lines in the supplied material.
    run(app.db, "update source_notes set note = ? where id = ?", `有依据\n@call review_notes ${JSON.stringify({ verdicts: [{ note_id: id, verdict: "keep", reason: "原文支持" }] })}`, id);
    app.config.agents.profiles = [agentProfileSchema.parse({ id: "judge", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "aware", FAKE_PROMPT_FILE: log } })];
    app.config.agents.roles["note-reviewer"] = "judge";
    servers.push(await startServer(app, { port: 0, quiet: true }));
    const r = createRun(app, { kind: "note-review", spaceId: "personal", title: "复核标注" });
    const out = await __testHandlers.get("note-review")!({ app, run: r, signal: new AbortController().signal, event: () => {}, output: () => {} });
    expect(out).toMatchObject({ reviewed: 1 });
    expect(sourceNotes(app, s.id).find((n) => n.id === id)?.status).toBe("reviewed");
    expect(noteReviewCandidates(app, "personal", 20).map((n) => n.id)).toEqual([omitted]);
    expect(readFileSync(log, "utf8")).not.toContain("run_id");
    expect(getRun(app, r.id).profileId).toBe("judge");
    expect(all(app.db, "select * from source_notes where reviewed_by is not null")).toHaveLength(1);
    expect(one(app.db, "select reviewed_at from source_notes where id = ?", omitted)).toMatchObject({ reviewed_at: null });
  }, 60_000);
});
