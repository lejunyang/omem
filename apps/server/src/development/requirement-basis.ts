import type {
  KnowledgeArticle,
  KnowledgeRepository,
} from "../knowledge/repository.js";
import { stableDigest } from "../storage/digest.js";
import { ensureDevelopmentResults } from "./results.js";

export type RequirementBasis = {
  plan: string;
  selection: string;
  inputs: { key: string; digest: string }[];
  definition: string;
};

function definition(article: KnowledgeArticle) {
  const r = article.document.requirement;
  // Status/evidence/action progress may change after execution. The original
  // objective, exclusions and acceptance conditions still constrain this run.
  return stableDigest(
    r && {
      objective: r.objective,
      nonGoals: [...r.nonGoals].sort(),
      criteria: r.criteria
        .map((c) => ({ id: c.id, description: c.description }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  );
}

export function requirementBasis(
  repository: KnowledgeRepository,
  article: KnowledgeArticle,
): RequirementBasis {
  ensureDevelopmentResults(repository.store);
  const plan = repository
    .pages()
    .find((p) => p.key === article.document.key)?.plan;
  if (!plan) throw Error("需求计划不存在");
  // Registered execution results and the page's host-attached task/run state
  // describe progress. Including the latter would invalidate a review when the
  // review itself changes the run state. Ordinary source updates remain inputs.
  const reports = new Set(
    repository.store.db
      .prepare(
        "SELECT source_id FROM development_results WHERE requirement_key=?",
      )
      .all(article.document.key)
      .map((row) => String(row.source_id)),
  );
  for (const row of repository.store.db
    .prepare(
      "SELECT source_id FROM knowledge_page_inputs WHERE document_key=? AND purpose='followup-state'",
    )
    .all(article.document.key))
    reports.add(String(row.source_id));
  const inputs = new Map(
    repository
      .materialsForPlan(plan)
      .filter((m) => !reports.has(m.sourceId))
      .map((m) => [m.key, m.digest]),
  );
  const selection = stableDigest([...inputs.keys()].sort());
  // Background actually cited by the frozen article can be outside its initial
  // selection. Follow it to original materials, including derived page inputs.
  const visit = (a: KnowledgeArticle, seen = new Set<string>()) => {
    if (seen.has(a.revision)) return;
    seen.add(a.revision);
    for (const d of a.dependencies) {
      if (d.kind === "material") {
        const current = repository.resolveMaterial(d.key)?.material;
        if (!current || !reports.has(current.sourceId))
          inputs.set(d.key, current?.digest ?? "missing");
      } else {
        const dependency = repository.get(d.key, d.digest);
        if (dependency) visit(dependency, seen);
      }
    }
  };
  visit(article);
  return {
    plan: stableDigest(plan),
    selection,
    inputs: [...inputs]
      .map(([key, digest]) => ({ key, digest }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    definition: definition(article),
  };
}

export function assertRequirementBasis(
  repository: KnowledgeRepository,
  run: {
    requirementKey: string;
    requirementRevision: string;
    requirementBasis?: RequirementBasis;
  },
) {
  repository.refresh();
  const current = repository.get(run.requirementKey),
    fixed = repository.get(run.requirementKey, run.requirementRevision);
  if (!current || !fixed || !current.document.requirement)
    throw Error("固定需求版本不可用");
  if (!run.requirementBasis) {
    if (current.revision !== run.requirementRevision || !current.current)
      throw Error("需求已变化；请基于新需求重新评审");
    return;
  }
  // Explicit corrections/invalidations still block; report capture does not
  // create a requirement invalidation or alter the reader's plan.
  const invalidated = repository.store.db
    .prepare("SELECT 1 FROM knowledge_invalidations WHERE document_key=?")
    .get(run.requirementKey);
  const now = requirementBasis(repository, fixed);
  if (
    invalidated ||
    stableDigest(now) !== stableDigest(run.requirementBasis) ||
    definition(current) !== run.requirementBasis.definition
  )
    throw Error(
      "需求范围、原始材料或验收条件已变化；保留现有代码，请基于新需求重新评审",
    );
}
