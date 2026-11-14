import { afterEach, expect, it, vi } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { all, one, run } from "../src/core/db.ts";
import { levelCandidates, levelEvidence, type LevelCandidate } from "../src/quality/levels.ts";
import { levelOf, levelSql, reviewLevelAudit, reviewQueue, setAttention, setNodeLevel } from "../src/sources/attention.ts";
import { upsertSource } from "../src/sources/store.ts";
import { catalog, ROW_SQL } from "../src/sources/catalog.ts";
import { rmSync } from "node:fs";
import { auditCandidates, flaggedPipelines, pickSamples, pipelineStats, updateFlags, verdictOf, type Candidate } from "../src/quality/audit.ts";
import { writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

type TestApp = ReturnType<typeof testApp>;
const apps: TestApp[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); } });
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

const doc = (app: TestApp, path: string, text = "示例材料正文") => upsertSource(app, { spaceId: "personal", kind: "doc", uri: path, title: path, text }).id;
function levelRecord(app: TestApp, c: LevelCandidate, verdict: "ok" | "wrong" | "unchecked" = "wrong") {
  const id = `level-audit-${++seq}`;
  run(app.db, `insert into quality_audits(id,at,pipeline,space_id,target,written_at,verdict,category,level,suggested_level,review_reason,wrong)
    values(?,?,?,?,?,?,?,'level',?,'normal','材料仍有日常使用价值',?)`, id, new Date().toISOString(), c.pipeline, c.spaceId, c.target, c.writtenAt, verdict, c.level, verdict === "wrong" ? 1 : 0);
  return id;
}

it("samples folders before documents, hiding levels before others, larger folders then newer decisions, within the cap", () => {
  const app = setup();
  const writer = runOf(app, "ingest");
  const a = doc(app, "large/a.md"), b = doc(app, "large/b.md"), c = doc(app, "small/c.md");
  const d = doc(app, "focus/d.md"), mine = doc(app, "owner/e.md");
  setNodeLevel(app, "personal", "dir:large", "reference", "agent", { runId: writer });
  setNodeLevel(app, "personal", "dir:small", "ignore", "agent");
  setNodeLevel(app, "personal", "dir:focus", "focus", "agent");
  setNodeLevel(app, "personal", "dir:owner", "ignore", "owner");
  setAttention(app, [a, b], "focus", "agent");
  setAttention(app, [c], "ignore", "agent");
  setAttention(app, [d], "reference", "agent", { reason: "历史背景", runId: writer });
  setAttention(app, [mine], "ignore", "owner");
  run(app.db, "update sources set attention_at = '2026-11-15T02:00:00Z' where id = ?", c);
  run(app.db, "update sources set attention_at = '2026-11-15T01:00:00Z' where id = ?", d);
  const picked = levelCandidates(app);
  expect(picked.map((r) => r.key)).toEqual(["dir:large", "dir:small", "dir:focus", c, d, expect.any(String)]);
  expect(picked[0]).toMatchObject({ sources: 2, pipeline: "ingest" });
  expect(picked[1]).toMatchObject({ sources: 1, pipeline: "level" });
  expect(picked.find((r) => r.key === d)).toMatchObject({ pipeline: "ingest", reason: "历史背景" });
  expect(levelCandidates(app, 2).map((r) => r.key)).toEqual(["dir:large", "dir:small"]);
  expect(levelCandidates(app, 100).some((r) => r.key === mine || r.key === "dir:owner")).toBe(false);
  app.config.quality.audit.levels = 0;
  expect(levelCandidates(app)).toEqual([]);
});

it("audits each decision once including legacy timestamps and unchecked results, and picks a changed decision again", () => {
  const app = setup();
  const id = doc(app, "legacy/a.md");
  setAttention(app, [id], "ignore", "agent");
  run(app.db, "update sources set attention_at = null where id = ?", id);
  setNodeLevel(app, "personal", "dir:legacy", "reference", "agent");
  for (const c of levelCandidates(app)) levelRecord(app, c, "unchecked");
  expect(levelCandidates(app)).toEqual([]);
  setAttention(app, [id], "focus", "agent");
  expect(levelCandidates(app).map((r) => r.key)).toEqual([id]);
  const c = levelCandidates(app)[0];
  levelRecord(app, c, "ok");
  expect(levelCandidates(app)).toEqual([]);
  setNodeLevel(app, "personal", "dir:legacy", "ignore", "agent");
  expect(levelCandidates(app).map((r) => r.key)).toEqual(["dir:legacy"]);
  levelRecord(app, levelCandidates(app)[0], "ok");
  // Direct legacy writes (for example merging duplicate copies) also get a fresh timestamp.
  run(app.db, "update sources set attention = 'reference' where id = ?", id);
  expect(levelCandidates(app).map((r) => r.key)).toEqual([id]);
});

it.each(["source", "node"] as const)("lets the owner accept or keep a wrong %s level and ignores superseded suggestions", (type) => {
  const app = setup();
  const id = doc(app, "review/a.md");
  const key = type === "source" ? id : "dir:review";
  const set = (level: "ignore" | "focus") => type === "source" ? setAttention(app, [id], level, "agent") : setNodeLevel(app, "personal", key, level, "agent");
  set("ignore");
  const a = levelRecord(app, levelCandidates(app)[0]);
  expect(reviewQueue(app, "personal").levels.find((r) => r.key === key)).toMatchObject({ auditId: a, suggestedLevel: "normal", reviewReason: "材料仍有日常使用价值" });
  set("focus");
  expect(reviewQueue(app, "personal").levels.some((r) => r.auditId === a)).toBe(false);
  expect(() => reviewLevelAudit(app, "personal", a, "accept")).toThrow("原定级已变化");
  // A current suggestion can be kept: same level, now owned, no queue entry.
  const kept = levelRecord(app, levelCandidates(app)[0]);
  reviewLevelAudit(app, "personal", kept, "keep");
  expect(reviewQueue(app, "personal").levels).toEqual([]);
  expect(levelOf(app, id, type === "node")).toMatchObject({ level: "focus", by: "owner" });
  // A separate decision exercises acceptance without overriding that owner's choice.
  const next = doc(app, "accept/b.md");
  if (type === "source") setAttention(app, [next], "ignore", "agent");
  else setNodeLevel(app, "personal", "dir:accept", "ignore", "agent");
  const accepted = levelRecord(app, levelCandidates(app)[0]);
  reviewLevelAudit(app, "personal", accepted, "accept");
  expect(levelOf(app, next, type === "node")).toMatchObject({ level: "normal", by: "owner" });
  expect(one(app.db, `select ${levelSql()} level from sources s where s.id = ?`, next)).toMatchObject({ level: null });
  expect(reviewQueue(app, "personal").levels).toEqual([]);
  expect(() => reviewLevelAudit(app, "personal", accepted, "accept")).toThrow();
});

it("uses bounded source evidence and 15 titles spread over a folder, updating nested membership after arrivals and moves", () => {
  const app = setup();
  const ids = Array.from({ length: 30 }, (_, i) => doc(app, `spread/sub/${String(i).padStart(2, '0')}.md`, "正文".repeat(5000)));
  setNodeLevel(app, "personal", "dir:spread", "ignore", "agent");
  setNodeLevel(app, "personal", "dir:spread/sub", "reference", "agent");
  let picked = levelCandidates(app);
  expect(picked.map((r) => r.sources)).toEqual([30, 30]);
  const evidence = levelEvidence(app, picked[0]);
  expect(evidence.split("\n").filter((s) => s.startsWith("- "))).toHaveLength(15);
  expect(evidence).toContain("00.md");
  expect(evidence).toContain("29.md");
  doc(app, "spread/new.md");
  run(app.db, "update sources set uri = 'elsewhere/a.md' where id = ?", ids[0]);
  picked = levelCandidates(app);
  expect(picked.find((r) => r.key === "dir:spread")?.sources).toBe(30);
  expect(picked.find((r) => r.key === "dir:spread/sub")?.sources).toBe(29);
  setAttention(app, [ids[1]], "ignore", "agent");
  const source = levelCandidates(app).find((r) => r.key === ids[1])!;
  expect(levelEvidence(app, source).length).toBeLessThan(4500);
  expect(all(app.db, "select name from sqlite_master where name glob 'source_catalog_*'")).toEqual([]);
});

it("aggregates level accuracy across writer pipelines in the same window without tightening them", () => {
  const app = setup();
  const id = doc(app, "figures.md");
  setAttention(app, [id], "ignore", "agent");
  const c = levelCandidates(app)[0];
  for (let i = 0; i < 6; i++) levelRecord(app, { ...c, pipeline: i % 2 ? "ingest" : "digest" }, i < 3 ? "wrong" : i < 5 ? "ok" : "unchecked");
  const expired = levelRecord(app, c, "wrong");
  run(app.db, "update quality_audits set at = '2000-01-01' where id = ?", expired);
  expect(pipelineStats(app)).toEqual([expect.objectContaining({ pipeline: "level", audited: 6, wrong: 3, unchecked: 1, accuracy: 0.4, flagged: false })]);
  app.config.quality.audit.minSamples = 1;
  expect(updateFlags(app).flagged).toEqual([]);
  expect(one(app.db, "select pipeline from quality_audits where id = ?", expired)).toMatchObject({ pipeline: "level" });
});

it("bounds a nightly pass over 100k sources, sharing one catalog across four folders and reading only sampled titles", () => {
  const app = setup();
  run(app.db, `with recursive n(i) as (values(1) union all select i+1 from n where i<100000)
    insert into sources(id,space_id,kind,uri,title,hash,text,captured_at,updated_at,attention,attention_by,attention_at)
    select 'large-'||i,'personal','doc','library/' || case when i%2=0 then 'a/' else 'b/' end || case when i%4=0 then 'deep/' else '' end || i||'.md',
      '示例材料 '||i,'hash','示例正文',datetime('now'),datetime('now'),
      case when i%14=0 then 'ignore' else null end, case when i%14=0 then 'agent' else 'owner' end,datetime('now') from n`);
  // Seed decisions without warming the catalog: measure the cold nightly pass, not setting levels.
  for (const [key, level] of [['dir:library', 'reference'], ['dir:library/a', 'ignore'], ['dir:library/b', 'normal'], ['dir:library/a/deep', 'focus']])
    run(app.db, "insert into source_node_levels(space_id,node_key,level,by,updated_at) values('personal',?,?,'agent',?)", key, level, new Date().toISOString());
  const prepare = app.db.prepare.bind(app.db);
  let documentRows = 0;
  let titleRows = 0;
  let titleIds = 0;
  const queries = vi.spyOn(app.db, 'prepare').mockImplementation((sql) => {
    const stmt = prepare(sql);
    const documents = sql.includes('from sources s left join runs');
    const titles = sql.startsWith('select s.id, s.title from json_each(?)');
    if (documents || titles) {
      const read = stmt.all.bind(stmt);
      vi.spyOn(stmt, 'all').mockImplementation((...params) => {
        const rows = read(...params);
        if (documents) documentRows += rows.length;
        else {
          titleRows += rows.length;
          titleIds += JSON.parse(String(params[0])).length;
          const plan = prepare('explain query plan ' + sql).all(...params).map((r) => String(r.detail));
          expect(plan.some((detail) => detail.includes('sqlite_autoindex_sources_1 (id=?)'))).toBe(true);
          expect(plan.some((detail) => detail.includes('sources_space'))).toBe(false);
        }
        return rows;
      });
    }
    return stmt;
  });
  const start = performance.now();
  catalog(app, 'personal');
  const built = performance.now();
  const picked = levelCandidates(app);
  const chosen = performance.now();
  const evidence = levelEvidence(app, picked[0]);
  const finished = performance.now();
  expect(picked).toHaveLength(6);
  expect(picked[0]).toMatchObject({ key: "dir:library", sources: 100000 });
  expect(picked.filter((c) => c.type === 'node')).toHaveLength(4);
  expect(picked[0].path).toBe('library');
  expect(documentRows).toBe(2);
  expect(titleRows).toBe(15);
  expect(titleIds).toBe(15);
  expect(queries.mock.calls.filter(([sql]) => sql.startsWith(ROW_SQL))).toHaveLength(1);
  expect(evidence.split("\n").filter((s) => s.startsWith("- "))).toHaveLength(15);
  expect(finished - start).toBeLessThan(10000);
  console.info(`定级审计规模：100000 原件、4 个目录、7142 个单篇定级；冷目录构建 ${(built - start).toFixed(1)} ms；选样 ${(chosen - built).toFixed(1)} ms；15 个标题 ${(finished - chosen).toFixed(1)} ms；主线程合计 ${(finished - start).toFixed(1)} ms`);
  // A folder-only budget never queries single-document candidates.
  queries.mockClear();
  expect(levelCandidates(app, 2).map((c) => c.type)).toEqual(['node', 'node']);
  expect(queries.mock.calls.some(([sql]) => sql.includes('from sources s left join runs'))).toBe(false);
});
