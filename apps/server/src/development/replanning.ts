import type { RequirementState } from "../../../../packages/contracts/src/development.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import { stableDigest } from "../storage/digest.js";
import {
  requirementBasis,
  type RequirementBasis,
} from "./requirement-basis.js";

export type RequirementChange = {
  at: string;
  fromRevision: string;
  toRevision: string;
  before: RequirementState;
  after: RequirementState;
  criteria: {
    added: string[];
    removed: string[];
    changed: string[];
    retained: string[];
  };
  materials: { key: string; before: string | null; after: string | null }[];
  planChanged: boolean;
};
/** Describe a real change; the coding agent interprets its impact together with
 * the original assignment and current code, without another planning model. */
export function inspectRequirementChange(
  repository: KnowledgeRepository,
  run: {
    requirementKey: string;
    requirementRevision: string;
    requirementBasis?: RequirementBasis;
  },
) {
  repository.refresh();
  const previous = repository.get(run.requirementKey, run.requirementRevision);
  const current = repository.get(run.requirementKey);
  if (
    !previous?.document.requirement ||
    !current?.document.requirement ||
    !current.current
  )
    throw Error("等待最新需求完成调查与复核；保留当前代码");
  const basis = requirementBasis(repository, current);
  if (
    run.requirementBasis &&
    stableDigest(basis) === stableDigest(run.requirementBasis)
  )
    return null;
  if (!run.requirementBasis && current.revision === run.requirementRevision)
    return null;
  const before = previous.document.requirement,
    after = current.document.requirement;
  const old = new Map(before.criteria.map((c) => [c.id, c.description]));
  const next = new Map(after.criteria.map((c) => [c.id, c.description]));
  const inputs = new Map(
    (run.requirementBasis?.inputs ?? []).map((m) => [m.key, m.digest]),
  );
  const latest = new Map(basis.inputs.map((m) => [m.key, m.digest]));
  const change: RequirementChange = {
    at: new Date().toISOString(),
    fromRevision: previous.revision,
    toRevision: current.revision,
    before,
    after,
    criteria: {
      added: [...next.keys()].filter((k) => !old.has(k)),
      removed: [...old.keys()].filter((k) => !next.has(k)),
      changed: [...next.keys()].filter(
        (k) => old.has(k) && old.get(k) !== next.get(k),
      ),
      retained: [...next.keys()].filter((k) => old.get(k) === next.get(k)),
    },
    materials: [...new Set([...inputs.keys(), ...latest.keys()])]
      .filter((k) => inputs.get(k) !== latest.get(k))
      .map((key) => ({
        key,
        before: inputs.get(key) ?? null,
        after: latest.get(key) ?? null,
      })),
    planChanged: run.requirementBasis?.plan !== basis.plan,
  };
  return { article: current, basis, change };
}
