import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { countDigest, createDigestJob, getDigestJob, listDigestJobs, queueNextBatch, setDigestStatus } from "../src/agents/digest.ts";
import { __testHandlers, addRunEvent, getRun, setRunOutput } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { search } from "../src/search/search.ts";
import {
  addSourceNote, applyAttentionRulesToExisting, levelCounts, levelOf, saveAttentionRule, selectSources, setAttention, sourceNotes,
} from "../src/sources/attention.ts";
import { upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());
createSpace(app, { id: "proj", name: "项目 A", kind: "project" });

const doc = (uri: string, title: string, text: string, meta: Record<string, unknown> = {}) => upsertSource(app, { spaceId: "proj", kind: "doc", uri, title, text, meta }).id;
const current = doc("lark:doc-v2", "退款方案 v2", "# 退款规则\n退款金额按已发货行计算，不含运费。\n审批：组长审批即可。");
const old = doc("lark:doc-v1", "退款方案 v1", "# 退款规则\n退款金额按订单总额计算。\n# 审批\n退款审批要经过财务复核。", { wikiPath: "项目 A / 历史归档" });
const noise = doc("lark:tpl", "周报模板", "# 退款\n（待填写）退款金额");

describe("how much a source matters", () => {
  it("ranks focus up, reference down, and leaves ignore out of search", async () => {
    const before = (await search(app, "退款金额", { spaces: ["proj"] })).map((h) => h.sourceId);
    expect(before).toContain(noise);
    setAttention(app, [noise], "ignore", "owner");
    setAttention(app, [old], "reference", "agent");
    setAttention(app, [current], "focus", "agent");
    const hits = await search(app, "退款金额", { spaces: ["proj"] });
    expect(hits.map((h) => h.sourceId)).not.toContain(noise);
    expect(hits[0].sourceId).toBe(current);
    expect(hits.find((h) => h.sourceId === old)?.attention).toBe("reference");
    expect((await search(app, "退款金额", { spaces: ["proj"], includeIgnored: true })).map((h) => h.sourceId)).toContain(noise);
    expect(levelCounts(app, null, "proj")).toEqual({ focus: 1, normal: 0, reference: 1, ignore: 1 });
  });

  it("never lets an agent or a rule undo the owner's choice", () => {
    expect(setAttention(app, [noise], "focus", "agent")).toEqual({ changed: 0, kept: 1 });
    expect(levelOf(app, noise)).toEqual({ level: "ignore", by: "owner" });
    expect(setAttention(app, [old], "normal", "owner").changed).toBe(1);
    expect(levelOf(app, old)).toEqual({ level: "normal", by: "owner" });
    expect(setAttention(app, [old], "reference", "owner").changed).toBe(1);
  });

  it("notes say which part is outdated and what to read instead; search and read_source carry them", async () => {
    addSourceNote(app, { sourceId: old, lineStart: 4, lineEnd: 4, kind: "outdated", note: "现在组长审批即可", ref: `src:${current}#L3-L3`, by: "agent" });
    const hit = (await search(app, "财务复核", { spaces: ["proj"] })).find((h) => h.sourceId === old)!;
    expect(hit.notes?.[0]).toContain("已过时");
    expect(hit.notes?.[0]).toContain(`src:${current}`);
    const ctx: ToolContext = { app, runId: null, spaceId: "proj", spaces: ["proj"], tools: null, actor: "agent" };
    const read = await callTool(ctx, "read_source", { source: old });
    expect(read.text).toContain("已过时 L4");
    expect(read.text).toContain("仅检索（本人设的）");
    // The same range and kind replaces the earlier note; the owner's note is not replaced by an agent.
    addSourceNote(app, { sourceId: old, lineStart: 4, lineEnd: 4, kind: "outdated", note: "本人：以 v2 为准", by: "owner" });
    expect(addSourceNote(app, { sourceId: old, lineStart: 4, lineEnd: 4, kind: "outdated", note: "agent 再标", by: "agent" }).kept).toBe(true);
    expect(sourceNotes(app, old).map((n) => n.note)).toEqual(["本人：以 v2 为准"]);
  });

  it("gives agents tools to set levels in bulk and annotate, within the spaces they may change", async () => {
    const ctx: ToolContext = { app, runId: null, spaceId: "proj", spaces: ["proj"], tools: null, actor: "agent" };
    const set = await callTool(ctx, "set_source_attention", { level: "reference", reason: "历史归档目录", wiki_path_contains: "历史归档" });
    expect(set.text).toMatch(/1 份是本人定的/);
    const note = await callTool(ctx, "annotate_source", { source: current, kind: "key", from: 2, to: 2, note: "退款口径" });
    expect(note.isError).toBeFalsy();
    const outside: ToolContext = { ...ctx, spaces: ["personal"] };
    expect((await callTool(outside, "annotate_source", { source: current, kind: "key", note: "x" })).isError).toBe(true);
  });

  it("rules give new material a level and can be applied to what is stored", () => {
    saveAttentionRule(app, { name: "历史归档只检索", level: "reference", conditions: { field: "meta.wikiPath", op: "contains", value: "历史归档" } });
    const later = doc("lark:doc-v0", "退款方案 v0", "更早的方案", { wikiPath: "项目 A / 历史归档 / 2023" });
    expect(levelOf(app, later)).toEqual({ level: "reference", by: "rule" });
    run(app.db, "update sources set attention = null, attention_by = null where id = ?", later);
    expect(applyAttentionRulesToExisting(app, "proj").changed).toBe(1);
    expect(levelOf(app, later).by).toBe("rule");
    expect(selectSources(app, { space: "proj", level: "reference" }).map((s) => s.id)).toContain(later);
  });
});

describe("digesting stored material in batches", () => {
  it("works through the matching sources one batch at a time, focus first, skipping reference and ignore", async () => {
    for (let i = 0; i < 5; i++) doc(`lark:chat-${i}`, `值班群 ${i}`, `值班记录 ${i}\n`.repeat(40));
    const job = createDigestJob(app, { mode: "digest", space: "proj", filter: {}, goal: "整理成值班手册", batch: 1 });
    // focus (v2) + normal ones; v1, v0 (reference) and the template (ignore) are skipped.
    expect(countDigest(app, job)).toEqual({ total: 6, left: 6 });
    const first = getRun(app, getDigestJob(app, job.id).runId!);
    expect(first.kind).toBe("digest");
    expect(first.input.sourceIds).toEqual([current]);
    // Nothing new is queued while a batch waits.
    expect(queueNextBatch(app, job.id)).toBeNull();
    setDigestStatus(app, job.id, "stopped");
    expect(listDigestJobs(app).map((j) => j.id)).not.toContain(job.id);
  });

  it("runs a triage batch with an Agent, records what was done and queues the next", async () => {
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_SAY: "分好了：都是一般。" }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const job = createDigestJob(app, { mode: "triage", space: "proj", filter: { title_contains: "值班群" }, batch: 3 });
      expect(job.total).toBe(5);
      const r = getRun(app, job.runId!);
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      const out = await __testHandlers.get("triage")!({ app, run: r, signal: new AbortController().signal, event: (t, d) => addRunEvent(app, r.id, t, d), output: (d) => setRunOutput(app, r.id, d) }) as { summary: string };
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      expect(out.summary).toContain("分好了");
      const after = getDigestJob(app, job.id);
      expect(countDigest(app, after).left).toBe(2);
      expect(after.runId).not.toBe(r.id);
      expect(getRun(app, after.runId!).input.sourceIds).toHaveLength(2);
    } finally {
      await server.close();
    }
  }, 60000);
});
