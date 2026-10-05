import { it, expect } from "vitest";
import { assessPassages, passagePolicy } from "../src/decision/passages.js";
import type { DecisionService, DecisionResult } from "../src/decision/service.js";
import type { RetrievalHit } from "../src/retrieval/port.js";
const result = (change: Record<string, Record<string, number>> = {}) => ({ answers: Object.fromEntries(Object.entries({ relevance: { unrelated: .999 }, answer_coverage: { none: .999 }, evidence: { none: .999 }, premise: { no_conflict: .999 }, parent_context: { not_needed: .999 }, ...change }).map(([k, probabilities]) => [k, { probabilities }])), } as unknown as DecisionResult);
it("omits clearly irrelevant passages but keeps contradictory evidence and missing conditions", () => {
  expect(passagePolicy(result()).omit).toBe(true);
  expect(passagePolicy(result({premise:{contradicts:.98}})).omit).toBe(false);
  expect(passagePolicy(result({parent_context:{needed:.8}})).omit).toBe(false);
  expect(passagePolicy(result({relevance:{unrelated:.5,uncertain:.4}})).omit).toBe(false);
});
it("keeps the original candidates when the optional decision model cannot run", async () => {
  const hits = [{id:"a"}, {id:"b"}] as RetrievalHit[];
  const service = {decide:async()=>null,status:()=>({status:"unavailable"})} as unknown as DecisionService;
  expect((await assessPassages(service,"问题",hits)).hits).toBe(hits);
});
