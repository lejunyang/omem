import type { App } from "../core/app.ts";
import { webLink } from "../core/util.ts";
import { worktreesOf } from "./code.ts";
import { getRun, type Run } from "./runs.ts";

export function reviewCardLinks(app: App, run: Run) {
  const root = typeof run.input.continueFrom === "string" ? getRun(app, run.input.continueFrom) : run;
  const itemId = run.input.itemId ?? root.input.itemId;
  const branches = worktreesOf(app, root.id).filter(w => w.branch).map(w => `${w.space} \`${w.branch}\``);
  return [
    `[看改动](${webLink(app, `#/code/${run.id}?tab=change`)})`,
    typeof itemId === "string" && itemId ? `[所属事项](${webLink(app, `#/items/${itemId}`)})` : "",
    branches.length ? `分支：${branches.join("、")}` : "",
  ].filter(Boolean).join("　");
}
