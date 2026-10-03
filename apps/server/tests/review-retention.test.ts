import { expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reviewCleanupPlan,
  pruneCandidates,
} from "../../../scripts/review-retention.js";

it("bounds completed verification outputs while preserving cited reports, active runs and source history", () => {
  const root = mkdtempSync(join(tmpdir(), "omem-retention-"));
  const put = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  try {
    const reports: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const date = `2026-10-0${i}T00-00-00-000Z`;
      reports.push(
        put(
          `.repo-review/knowledge/verification/history/${date}-abcdef12.json`,
          JSON.stringify({ passed: i % 2 === 0, recordedAt: date }),
        ),
      );
    }
    put(
      "docs/reader-first/progress.md",
      "[原始失败](../../.repo-review/knowledge/verification/history/2026-10-01T00-00-00-000Z-abcdef12.json)",
    );
    for (let i = 1; i <= 5; i++) {
      put(
        `.repo-review/runtime/assistant-compare/run-${i}/.review-run.json`,
        JSON.stringify({
          version: 1,
          kind: "assistant",
          startedAt: String(i),
          ...(i < 5 ? { finishedAt: String(i) } : {}),
        }),
      );
      put(
        `.repo-review/runtime/assistant-compare/run-${i}/result.json`,
        "result",
      );
    }
    const original = put(
      ".repo-review/runtime/data/omem.sqlite",
      "fixed original revisions",
    );
    const article = put(
      ".repo-review/knowledge/articles/old.json",
      "fixed cited article",
    );
    const candidates = reviewCleanupPlan(root);
    expect(candidates).toHaveLength(4); // 3 obsolete reports, 1 completed run
    expect(existsSync(reports[1]!)).toBe(true); // preview has no effects
    pruneCandidates(candidates);
    expect(existsSync(reports[0]!)).toBe(true);
    expect(existsSync(reports[1]!)).toBe(false);
    expect(
      existsSync(
        join(root, ".repo-review/runtime/assistant-compare/run-5/result.json"),
      ),
    ).toBe(true);
    expect(readFileSync(original, "utf8")).toBe("fixed original revisions");
    expect(readFileSync(article, "utf8")).toBe("fixed cited article");
    expect(reviewCleanupPlan(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
