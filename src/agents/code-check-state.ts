import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import type { Check } from "./code.ts";
import type { Run } from "./runs.ts";

export type CheckEvidence = { space: string; full: string; head: string; passed: boolean; baseline?: string; mode: "full" | "focused" | "skip"; reason: string; checks: Check[]; summary: string };

export function checkCommandOf(app: App, run: Run, space: string): string | undefined {
  const input = run.input as { checks?: Record<string, string>; checkCommand?: string };
  return input.checks?.[space] ?? input.checkCommand ?? ((findSpace(app, space)?.settings.checkCommand as string | undefined) || undefined);
}

export function checkHistoryOf(app: App, root: string) {
  return all<{ evidence: string }>(app.db, `select json_extract(output, '$.repositoryCheckEvidence') as evidence from runs
    where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) and evidence is not null order by rowid desc`, root, root)
    .flatMap(row => JSON.parse(row.evidence) as CheckEvidence[]);
}

export function requireCheckEvidence(app: App, root: string, space: string, command: string, head: string) {
  const evidence = checkHistoryOf(app, root).find(row => row.space === space && row.full === command && row.head === head);
  if (!head || !evidence?.passed) throw new HttpError(409, `${space} 的当前提交还没有完整的仓库检查依据，请继续交办或重新评审后再交付`);
}
