import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { deleteArtifacts, type Artifact } from "../agents/artifacts.ts";

/**
 * Test results (docs/v2/requirements.md “测试结果”): what a run's agent ran against requirement and
 * test points, and how it went. omem knows no test framework: the project's own way of running its
 * tests (a skill on the space, the repository's scripts) tells the agent how to run them and turn
 * their output into `report_tests`; the host only checks the ids, keeps the rows and the artifacts
 * handed in with them, and shows them on the point, the item and to the review.
 *
 * Growth stays bounded: a test (same point, file and name) keeps the artifacts of its latest
 * `KEEP_ARTIFACTS` results; older results keep their row (status, when, which run) and lose theirs.
 */

export const TEST_STATUS = ["passed", "failed", "skipped"] as const;
export type TestStatus = (typeof TEST_STATUS)[number];
export const TEST_STATUS_LABEL: Record<TestStatus, string> = { passed: "通过", failed: "失败", skipped: "跳过" };
/** Results of one test that keep their screenshots and recordings. */
export const KEEP_ARTIFACTS = 3;

export type TestResult = {
  id: string;
  nodeId: string | null;
  spaceId: string | null;
  runId: string;
  workId: string | null;
  round: number;
  name: string;
  file: string;
  status: TestStatus;
  mode: string;
  note: string;
  commit: string;
  /** Artifact ids; empty once pruned (`pruned`). */
  artifacts: string[];
  pruned: boolean;
  createdBy: string;
  at: string;
};

type Row = {
  id: string; node_id: string | null; space_id: string | null; run_id: string; work_id: string | null; round: number; name: string; file: string;
  status: string; mode: string; note: string; commit_sha: string; artifacts: string; pruned: number; created_by: string; at: string;
};
const toResult = (r: Row): TestResult => ({
  id: r.id, nodeId: r.node_id, spaceId: r.space_id, runId: r.run_id, workId: r.work_id, round: r.round, name: r.name, file: r.file,
  status: r.status as TestStatus, mode: r.mode, note: r.note, commit: r.commit_sha, artifacts: json(r.artifacts, []), pruned: !!r.pruned, createdBy: r.created_by, at: r.at,
});

export type TestInput = { req?: string | null; name: string; file?: string; status: TestStatus; mode?: string; note?: string; artifacts?: Artifact[] };

/** Records a run's results; then drops the artifacts of results older than the latest few of each test. */
export function recordTests(app: App, o: { runId: string; workId: string | null; spaceId: string | null; round: number; commit?: string; by: string; tests: TestInput[] }): TestResult[] {
  const at = now();
  const made: TestResult[] = [];
  for (const t of o.tests) {
    const row: Row = {
      id: newId("qt"), node_id: t.req ?? null, space_id: o.spaceId, run_id: o.runId, work_id: o.workId, round: o.round, name: truncate(t.name, 300), file: truncate(t.file ?? "", 500),
      status: t.status, mode: truncate(t.mode ?? "", 40), note: truncate(t.note ?? "", 1000), commit_sha: (o.commit ?? "").slice(0, 64),
      artifacts: JSON.stringify((t.artifacts ?? []).map((a) => a.id)), pruned: 0, created_by: o.by, at,
    };
    run(app.db, `insert into req_tests (id, node_id, space_id, run_id, work_id, round, name, file, status, mode, note, commit_sha, artifacts, pruned, created_by, at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.node_id, row.space_id, row.run_id, row.work_id, row.round, row.name, row.file, row.status, row.mode, row.note, row.commit_sha, row.artifacts, row.pruned, row.created_by, row.at);
    made.push(toResult(row));
  }
  for (const t of made) pruneTest(app, t);
  for (const id of new Set(made.flatMap((t) => (t.nodeId ? [t.nodeId] : [])))) {
    const n = one<{ space_id: string }>(app.db, "select space_id from req_nodes where id = ?", id);
    if (n) app.emit({ type: "changed", entity: "requirement", id, spaceId: n.space_id });
  }
  return made;
}

/** One test's earlier results beyond the latest few lose their artifacts (files and rows). */
export function pruneTest(app: App, t: Pick<TestResult, "nodeId" | "spaceId" | "file" | "name">) {
  const rows = all<Row>(
    app.db,
    `select * from req_tests where ${t.nodeId ? "node_id = ?" : "node_id is null and space_id is ?"} and file = ? and name = ? and pruned = 0 and artifacts != '[]' order by at desc, id desc`,
    t.nodeId ?? t.spaceId, t.file, t.name,
  );
  const old = rows.slice(KEEP_ARTIFACTS);
  if (!old.length) return 0;
  const keep = new Set(rows.slice(0, KEEP_ARTIFACTS).flatMap((r) => json<string[]>(r.artifacts, [])));
  const drop = [...new Set(old.flatMap((r) => json<string[]>(r.artifacts, [])))].filter((id) => !keep.has(id));
  for (const r of old) run(app.db, "update req_tests set artifacts = '[]', pruned = 1 where id = ?", r.id);
  // A later result may share an artifact (handed in again by path): only ones no kept result names go.
  const gone = drop.filter((id) => !one(app.db, "select 1 from req_tests where pruned = 0 and artifacts like ?", `%"${id}"%`));
  if (gone.length) deleteArtifacts(app, { ids: gone });
  return old.length;
}

/** A point's results, newest first (`limit` per point). */
export function testsOf(app: App, nodeIds: string[], limit = 50): Map<string, TestResult[]> {
  const out = new Map<string, TestResult[]>();
  if (!nodeIds.length) return out;
  const rows = all<Row>(app.db, `select * from req_tests where node_id in (${nodeIds.map(() => "?").join(",")}) order by at desc, id desc`, ...nodeIds);
  for (const r of rows) {
    const list = out.get(r.node_id!) ?? [];
    if (list.length < limit) list.push(toResult(r));
    out.set(r.node_id!, list);
  }
  return out;
}

/** The latest result of each test (point, file, name) among `results` (newest first). */
export function latestEach(results: TestResult[]): TestResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.nodeId}\n${r.file}\n${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A point's state from its tests' latest results: failed if any failed, passed if all that ran passed. */
export function testState(results: TestResult[]): { status: TestStatus; passed: number; failed: number; skipped: number; at: string } | null {
  const latest = latestEach(results);
  if (!latest.length) return null;
  const count = (s: TestStatus) => latest.filter((r) => r.status === s).length;
  const failed = count("failed");
  const passed = count("passed");
  return { status: failed ? "failed" : passed ? "passed" : "skipped", passed, failed, skipped: count("skipped"), at: latest[0].at };
}

/** Results of a delegation (all its rounds) or of one run, newest first. */
export function testsOfWork(app: App, o: { workId?: string | null; runId?: string }): TestResult[] {
  const rows = o.workId
    ? all<Row>(app.db, "select * from req_tests where work_id = ? order by at desc, id desc", o.workId)
    : all<Row>(app.db, "select * from req_tests where run_id = ? order by at desc, id desc", o.runId!);
  return rows.map(toResult);
}

/**
 * Results as text for an agent (the review, the next round): the latest result of each test, failed
 * first, with the point it is for and the files of its artifacts on this machine.
 */
export function testsText(app: App, results: TestResult[], opts: { max?: number; artifactPath?: (id: string) => string | null } = {}): string {
  const max = opts.max ?? 60;
  const latest = latestEach(results).sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));
  const titles = new Map<string, string>();
  for (const id of new Set(latest.flatMap((r) => (r.nodeId ? [r.nodeId] : [])))) {
    const n = one<{ title: string }>(app.db, "select title from req_nodes where id = ?", id);
    if (n) titles.set(id, n.title);
  }
  const lines = latest.slice(0, max).map((r) => {
    const files = r.artifacts.map((id) => opts.artifactPath?.(id)).filter(Boolean);
    return `- ${TEST_STATUS_LABEL[r.status]}：${r.file ? `${r.file} › ` : ""}${r.name}${r.mode ? `（${r.mode}）` : ""}${r.nodeId ? ` → ${r.nodeId}${titles.has(r.nodeId) ? `「${titles.get(r.nodeId)}」` : ""}` : ""}，第 ${r.round} 轮${r.commit ? `，提交 ${r.commit.slice(0, 8)}` : ""}${r.note ? `\n  ${r.note.replace(/\n/g, "\n  ")}` : ""}${files.length ? `\n  产物：${files.join("、")}` : ""}`;
  });
  const failed = latest.filter((r) => r.status === "failed").length;
  return `${latest.length} 个测试的最近结果${failed ? `，${failed} 个失败` : ""}${latest.length > max ? `（列出 ${max} 个，失败的在前）` : ""}：\n\n${lines.join("\n")}`;
}
