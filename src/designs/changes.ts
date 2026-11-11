import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import type { Design } from "./store.ts";

/**
 * Where each decision landed in the code (docs/v2/coding-plan.md §2.4, §6.4 `changes` / `outside`).
 * So far only what the design itself names: the files put under each decision (a branch review's
 * split, a derived design) and the files outside every decision. The delegation's tasks, their
 * commits, line counts and review findings are filled in here once delegations are tied to designs.
 */
export type ChangedFile = { space: string; path: string; add: number; del: number };
export type DecisionChange = {
  decision: string;
  tasks: { seq: number; title: string; state: string }[];
  commits: number;
  files: ChangedFile[];
  findings: { open: number; total: number };
};

/** `<repo id>/<path>` → its space and path (a path without the repository: the design's only repository, if it has one). */
function splitFile(design: Design, file: string): ChangedFile {
  const slash = file.indexOf("/");
  if (slash > 0) return { space: file.slice(0, slash), path: file.slice(slash + 1), add: 0, del: 0 };
  return { space: design.repos.length === 1 ? design.repos[0] : "", path: file, add: 0, del: 0 };
}

export function designChanges(app: App, design: Design): { changes: DecisionChange[]; outside: ChangedFile[] } {
  void app;
  return {
    changes: design.body.decisions.map((d) => ({ decision: d.id, tasks: [], commits: 0, files: (d.files ?? []).map((f) => splitFile(design, f)), findings: { open: 0, total: 0 } })),
    outside: (design.body.outside ?? []).map((f) => splitFile(design, f)),
  };
}

/** One decision's patch (`outside`: the changes under none). Not tied to any code yet. */
export function designDiff(app: App, design: Design, decision: string): never {
  void app;
  if (decision !== "outside" && !design.body.decisions.some((d) => d.id === decision)) throw new HttpError(404, `方案 ${design.id} 没有决定 ${decision}`);
  throw new HttpError(404, "这份方案还没有关联的代码");
}
