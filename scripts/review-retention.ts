/** Retention for reproducible verification outputs, never original/knowledge revisions. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const reviewRetention = { reportsPerOutcome: 2, completedRuns: 3 };
const marker = ".review-run.json";
type Run = {
  version: 1;
  kind: string;
  pid: number;
  startedAt: string;
  finishedAt?: string;
};
export type PruneCandidate = { path: string; bytes: number; reason: string };
function bytes(path: string): number {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return 0;
  return entry.isDirectory()
    ? readdirSync(path).reduce((n, name) => n + bytes(join(path, name)), 0)
    : entry.size;
}
function readRun(directory: string): Run | undefined {
  try {
    if (lstatSync(directory).isSymbolicLink()) return;
    const run = JSON.parse(readFileSync(join(directory, marker), "utf8"));
    if (
      run.version === 1 &&
      typeof run.kind === "string" &&
      typeof run.startedAt === "string"
    )
      return run;
  } catch {
    /* Unmanaged and incomplete outputs require explicit inspection. */
  }
}
export function completedReviewRuns(
  parent: string,
  kind: string,
): PruneCandidate[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((name) => {
      const path = join(parent, name),
        run = readRun(path);
      return { path, run };
    })
    .filter((row) => row.run?.kind === kind && row.run.finishedAt)
    .sort((a, b) => b.run!.finishedAt!.localeCompare(a.run!.finishedAt!))
    .slice(reviewRetention.completedRuns)
    .map((row) => ({
      path: row.path,
      bytes: bytes(row.path),
      reason: `超过最近 ${reviewRetention.completedRuns} 次已结束的 ${kind} 运行`,
    }));
}
export function beginReviewRun(directory: string, kind: string) {
  if (existsSync(join(directory, marker)))
    throw Error("Choose a fresh review output directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run: Run = {
    version: 1,
    kind,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const write = () =>
    writeFileSync(
      join(directory, marker),
      JSON.stringify(run, null, 2) + "\n",
      { mode: 0o600 },
    );
  write();
  return () => {
    run.finishedAt = new Date().toISOString();
    write();
  };
}
function markdown(directory: string): string {
  if (!existsSync(directory)) return "";
  return readdirSync(directory, { withFileTypes: true })
    .filter((e) => !e.isSymbolicLink() && e.name !== "archive")
    .map((e) => {
      const path = join(directory, e.name);
      return e.isDirectory()
        ? markdown(path)
        : e.name.endsWith(".md")
          ? readFileSync(path, "utf8")
          : "";
    })
    .join("\n");
}
export function oldVerificationReports(root: string): PruneCandidate[] {
  const directory = join(root, ".repo-review/knowledge/verification/history");
  if (!existsSync(directory)) return [];
  const references =
    markdown(join(root, "docs")) +
    markdown(join(root, ".repo-review/knowledge/verification"));
  const rows = readdirSync(directory)
    .filter((name) => /^\d{4}-\d\d-\d\dT.*-[a-f\d]{8}\.json$/.test(name))
    .flatMap((name) => {
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) return [];
      try {
        const report = JSON.parse(readFileSync(path, "utf8"));
        return typeof report.passed === "boolean" &&
          typeof report.recordedAt === "string"
          ? [
              {
                name,
                path,
                passed: report.passed as boolean,
                at: report.recordedAt as string,
              },
            ]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  const retained = new Set(
    [true, false].flatMap((passed) =>
      rows
        .filter((r) => r.passed === passed)
        .slice(0, reviewRetention.reportsPerOutcome)
        .map((r) => r.path),
    ),
  );
  return rows
    .filter(
      (row) =>
        !retained.has(row.path) && !references.includes(`history/${row.name}`),
    )
    .map((row) => ({
      path: row.path,
      bytes: bytes(row.path),
      reason: "较旧的自动检查报告；当前说明未直接引用",
    }));
}
export function pruneCandidates(candidates: PruneCandidate[]) {
  for (const candidate of candidates)
    rmSync(candidate.path, { recursive: true, force: true });
}
export function reviewCleanupPlan(root: string) {
  return [
    ...oldVerificationReports(root),
    ...completedReviewRuns(
      join(root, ".repo-review/runtime/verification"),
      "verification",
    ),
    ...completedReviewRuns(
      join(root, ".repo-review/runtime/assistant-compare"),
      "assistant",
    ),
  ];
}
