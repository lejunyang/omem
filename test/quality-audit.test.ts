import { afterEach, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { auditCandidates, flaggedPipelines, pickSamples, pipelineStats, updateFlags, verdictOf, type Candidate } from "../src/quality/audit.ts";
import { writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

type TestApp = ReturnType<typeof testApp>;
const apps: TestApp[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });
function setup() {
  const app = testApp();
  apps.push(app);
  return app;
}
const write = (app: TestApp, slug: string, by: { runId?: string; actor?: "agent" | "user"; kind?: string } = {}) =>
  writePage(app, "personal", slug, { meta: { title: slug, summary: "", kind: by.kind ?? "howto" }, body: `关于 ${slug} 的内容。` }, { actor: by.actor ?? "agent", runId: by.runId, commit: false });
const runOf = (app: TestApp, kind: string) => createRun(app, { kind: kind as never, spaceId: "personal", title: kind }).id;
let seq = 0;
function audited(app: TestApp, pipeline: string, verdict: string, extra: { target?: string; writerRun?: string; writtenAt?: string; at?: string } = {}) {
  run(
    app.db,
    "insert into quality_audits(id, at, pipeline, space_id, target, written_at, writer_run, verdict, wrong) values(?,?,?,?,?,?,?,?,?)",
    `qa${++seq}`, extra.at ?? new Date().toISOString(), pipeline, "personal", extra.target ?? `p${seq}`, extra.writtenAt ?? new Date().toISOString(), extra.writerRun ?? null, verdict, verdict === "wrong" ? 1 : 0,
  );
}

it("calls a page wrong only for findings about facts", () => {
  const f = (kind: string) => ({ quote: "x", kind, problem: "p", basis: "b" });
  expect(verdictOf(null)).toEqual({ verdict: "unchecked", wrong: 0, style: 0 });
  expect(verdictOf([])).toEqual({ verdict: "ok", wrong: 0, style: 0 });
  expect(verdictOf([f("hedge"), f("length")])).toEqual({ verdict: "style", wrong: 0, style: 2 });
  expect(verdictOf([f("wording"), f("cite"), f("code")])).toEqual({ verdict: "wrong", wrong: 2, style: 1 });
});

it("takes pages whose latest version an agent wrote outside a checked writing run, once per version", () => {
  const app = setup();
  const ingest = runOf(app, "ingest");
  write(app, "cases/a", { runId: ingest });
  write(app, "cases/checked", { runId: runOf(app, "wiki-write") });
  write(app, "cases/mine", { runId: ingest });
  write(app, "cases/mine", { actor: "user" });
  write(app, "state/work", { runId: ingest, kind: "log" });
  write(app, "cases/index", { runId: ingest });
  write(app, "outside", {});
  const got = auditCandidates(app);
  expect(got.map((c) => [c.slug, c.pipeline]).sort()).toEqual([["cases/a", "ingest"], ["outside", "external"]]);
  // Looked at in this version: not again, until it is rewritten.
  audited(app, "ingest", "ok", { target: "cases/a", writtenAt: new Date(Date.now() + 1000).toISOString() });
  expect(auditCandidates(app).map((c) => c.slug)).toEqual(["outside"]);
  run(app.db, "update quality_audits set written_at = ? where target = 'cases/a'", new Date(Date.now() - 60_000).toISOString());
  expect(auditCandidates(app).map((c) => c.slug).sort()).toEqual(["cases/a", "outside"]);
  // An audit the checker did not finish does not count as looked at: once more, then no more.
  run(app.db, "update quality_audits set verdict = 'unchecked', written_at = ? where target = 'cases/a'", new Date(Date.now() + 1000).toISOString());
  expect(auditCandidates(app).map((c) => c.slug).sort()).toEqual(["cases/a", "outside"]);
  audited(app, "ingest", "unchecked", { target: "cases/a", writtenAt: new Date(Date.now() + 1000).toISOString() });
  expect(auditCandidates(app).map((c) => c.slug)).toEqual(["outside"]);
  run(app.db, "delete from quality_audits where target = 'cases/a'");
  // Older than the look-back: left alone.
  run(app.db, "update page_writes set at = ?", new Date(Date.now() - 5 * 86400_000).toISOString());
  expect(auditCandidates(app)).toEqual([]);
});

it("puts first the other pages of a run that got one wrong or was corrected by the owner, then pages that are read", () => {
  const app = setup();
  const bad = runOf(app, "ingest");
  const fixed = runOf(app, "digest");
  const plain = runOf(app, "ingest");
  write(app, "cases/sibling", { runId: bad });
  audited(app, "ingest", "wrong", { target: "cases/gone", writerRun: bad });
  write(app, "cases/corrected", { runId: fixed });
  run(app.db, "update page_writes set at = ? where slug = 'cases/corrected'", new Date(Date.now() - 3600_000).toISOString());
  write(app, "cases/corrected", { actor: "user" });
  write(app, "cases/same-run", { runId: fixed });
  write(app, "cases/read", { runId: plain });
  write(app, "cases/unread", { runId: plain });
  run(app.db, "insert into page_reads(space_id, slug, day, n) values('personal', 'cases/read', ?, 4)", new Date().toISOString().slice(0, 10));
  const by = new Map(auditCandidates(app).map((c) => [c.slug, c]));
  expect(by.get("cases/sibling")).toMatchObject({ rank: 0 });
  expect(by.get("cases/same-run")).toMatchObject({ rank: 1 });
  expect(by.get("cases/read")).toMatchObject({ rank: 2, reads: 4 });
  expect(by.get("cases/unread")).toMatchObject({ rank: 3 });
  // The owner's own version is not a candidate.
  expect(by.has("cases/corrected")).toBe(false);
});

it("samples within the nightly budget, a few per kind of run, and everything of a flagged kind", () => {
  const c = (slug: string, pipeline: string, rank = 3, reads = 0): Candidate => ({ spaceId: "personal", slug, writtenAt: "", pipeline, runId: null, ai: "", reads, rank, why: "随机抽到" });
  const cands = [
    ...Array.from({ length: 6 }, (_, i) => c(`i${i}`, "ingest")),
    ...Array.from({ length: 3 }, (_, i) => c(`l${i}`, "wiki-lint")),
    c("read", "ingest", 2, 9),
    c("s1", "ingest", 0),
    c("s2", "ingest", 0),
    c("s3", "ingest", 0),
  ];
  const opts = { max: 6, perPipeline: 2, strictMax: 4, flagged: new Set<string>() };
  const got = pickSamples(cands, opts, () => 0.5).map((x) => x.slug);
  // Siblings of a wrong page go in whatever the per-kind cap; they count towards it, so nothing more of that kind tonight.
  expect(got.slice(0, 3)).toEqual(["s1", "s2", "s3"]);
  expect(got).toHaveLength(5);
  expect(got.filter((s) => s.startsWith("i") || s === "read")).toEqual([]);
  expect(got.filter((s) => s.startsWith("l"))).toHaveLength(2);
  // Without siblings: the read page first, then two per kind at most.
  const plain = pickSamples(cands.filter((x) => x.rank > 0), opts, () => 0.5).map((x) => x.slug);
  expect(plain[0]).toBe("read");
  expect(plain.filter((s) => s.startsWith("i") || s === "read")).toHaveLength(2);
  expect(plain.filter((s) => s.startsWith("l"))).toHaveLength(2);
  // A flagged kind is looked at in full, up to its own budget, and does not use up the others'.
  const strict = pickSamples(cands.filter((x) => x.rank > 0), { ...opts, flagged: new Set(["ingest"]) }, () => 0.5);
  expect(strict.filter((x) => x.pipeline === "ingest")).toHaveLength(4);
  expect(strict.filter((x) => x.pipeline === "wiki-lint")).toHaveLength(2);
  expect(strict.find((x) => x.pipeline === "ingest" && x.rank === 3)?.why).toContain("加严");
});

it("flags a kind of run when too many of its pages are wrong, and lifts the flag when it is back", () => {
  const app = setup();
  for (let i = 0; i < 3; i++) audited(app, "ingest", "wrong");
  for (let i = 0; i < 2; i++) audited(app, "ingest", "ok");
  // Not enough judged yet (minSamples 6); unchecked pages do not count.
  audited(app, "ingest", "unchecked");
  expect(updateFlags(app).flagged).toEqual([]);
  audited(app, "ingest", "style");
  const first = updateFlags(app);
  expect(first.flagged).toEqual(["ingest"]);
  expect(first.added[0]).toMatchObject({ pipeline: "ingest", wrong: 3, ok: 2, style: 1, unchecked: 1 });
  expect(pipelineStats(app).find((s) => s.pipeline === "ingest")).toMatchObject({ accuracy: 0.5, flagged: true });
  // Said once, kept while it stays low.
  expect(updateFlags(app).added).toEqual([]);
  for (let i = 0; i < 10; i++) audited(app, "ingest", "ok");
  const later = updateFlags(app);
  expect(later.cleared.map((s) => s.pipeline)).toEqual(["ingest"]);
  expect(flaggedPipelines(app)).toEqual([]);
});
