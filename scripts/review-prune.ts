import { relative } from "node:path";
import { taskFlag } from "./task-args.js";
import { pruneCandidates, reviewCleanupPlan } from "./review-retention.js";

const root = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const candidates = reviewCleanupPlan(root);
const apply = taskFlag("apply");
if (apply) pruneCandidates(candidates);
console.log(
  JSON.stringify(
    {
      applied: apply,
      filesOrRuns: candidates.length,
      bytes: candidates.reduce((n, row) => n + row.bytes, 0),
      candidates: candidates.map((row) => ({
        ...row,
        path: relative(root, row.path),
      })),
      kept: "正式数据库、原件和文章历史、材料说明历史、被当前文档引用的报告、进行中或未登记的运行均不清理。",
    },
    null,
    2,
  ),
);
