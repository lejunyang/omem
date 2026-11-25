/**
 * What a run's artifacts are for the person looking (docs/v2/artifacts.md): screenshots, recordings,
 * reports and test results are worth opening; logs, scripts, data exports and intermediate files are
 * kept but folded away. Decided by the artifact's kind and the file's extension only.
 */
export type ArtifactLike = { kind: "image" | "video" | "html" | "site" | "text" | "file"; name: string };
export type ArtifactClass = "shot" | "video" | "report" | "test" | "other";
export const CLASS_LABEL: Record<ArtifactClass, string> = { shot: "截图", video: "录屏", report: "报告", test: "测试结果", other: "其他" };

const REPORT_EXT = new Set(["md", "markdown", "pdf", "html", "htm"]);
/** Test result formats: JUnit / xUnit XML (`*.junit.xml`, `*.xunit.xml`), TRX, TAP. */
const TEST_EXT = new Set(["trx", "tap"]);
const TEST_SUFFIX = /\.(junit|xunit)\.xml$/i;

const extOf = (name: string) => {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export function artifactClass(a: ArtifactLike): ArtifactClass {
  if (a.kind === "image") return "shot";
  if (a.kind === "video") return "video";
  if (a.kind === "html" || a.kind === "site") return "report";
  const ext = extOf(a.name);
  if (TEST_EXT.has(ext) || TEST_SUFFIX.test(a.name)) return "test";
  if (REPORT_EXT.has(ext)) return "report";
  return "other";
}

export const worthSeeing = (a: ArtifactLike) => artifactClass(a) !== "other";

/** Worth seeing first (screenshots, recordings, then reports and test results), the rest after; stable inside each. */
const RANK: Record<ArtifactClass, number> = { shot: 0, video: 1, report: 2, test: 3, other: 4 };
export function splitArtifacts<T extends ArtifactLike>(list: T[]): { worth: T[]; other: T[] } {
  const worth = list.filter(worthSeeing).map((a, i) => ({ a, i })).sort((x, y) => RANK[artifactClass(x.a)] - RANK[artifactClass(y.a)] || x.i - y.i).map((x) => x.a);
  return { worth, other: list.filter((a) => !worthSeeing(a)) };
}

/** “截图 3 · 报告 1”. */
export function classCounts(list: ArtifactLike[]) {
  const n = new Map<ArtifactClass, number>();
  for (const a of list) n.set(artifactClass(a), (n.get(artifactClass(a)) ?? 0) + 1);
  return (["shot", "video", "report", "test"] as const).filter((c) => n.get(c)).map((c) => `${CLASS_LABEL[c]} ${n.get(c)}`).join(" · ");
}
