import { it, expect } from "vitest";
import { assessPassages, passagePolicy } from "../src/decision/passages.js";
import type { DecisionService, DecisionResult } from "../src/decision/service.js";
import type { RetrievalHit } from "../src/retrieval/port.js";
const hit = (id:string) => ({id,text:id,title:id,kind:"source",headingPath:[],context:"",score:1,routes:[],references:[],target:{kind:"source",key:id,revisionId:id,startLine:1,endLine:1,digest:id}} as RetrievalHit);
const result = (change: Record<string, Record<string, number>> = {}) => ({ model:{size:"2b"}, answers: Object.fromEntries(Object.entries({ relevance: { unrelated: .999 }, answer_coverage: { none: .999 }, evidence: { none: .999 }, premise: { no_conflict: .999 }, parent_context: { not_needed: .999 }, ...change }).map(([k, probabilities]) => [k, { probabilities }])), } as unknown as DecisionResult);
it("omits clearly irrelevant passages but keeps contradictory evidence and missing conditions", () => {
  expect(passagePolicy(result()).omit).toBe(true);
  expect(passagePolicy(result({premise:{contradicts:.98}})).omit).toBe(false);
  expect(passagePolicy(result({parent_context:{needed:.8}})).omit).toBe(false);
  expect(passagePolicy(result({relevance:{unrelated:.5,uncertain:.4}})).omit).toBe(false);
});
it("keeps 0.8B rejection as advice", () => {
  const advice = result({relevance:{unrelated:.999,answer:.001}});
  advice.model.size = "0.8b";
  expect(passagePolicy(advice).omit).toBe(false);
  expect(passagePolicy(advice).priority).toBe(.001);
});
it("attaches small-model advice without dropping or reordering retrieved evidence", async () => {
  const hits=[hit("a"),hit("b")];
  let call=0;
  const service={status:()=>({status:"ready"}),decide:async()=>{
    const r=result({relevance:call++ ? {answer:1}:{unrelated:1}});r.model.size="0.8b";return r;
  }} as unknown as DecisionService;
  const out=(await assessPassages(service,"问题",hits)).hits;
  expect(out.map(h=>h.id)).toEqual(["a","b"]);
  expect(out.every(h=>h.assessment?.advisoryOnly)).toBe(true);
  expect(out[1]!.assessment!.priority).toBeGreaterThan(out[0]!.assessment!.priority);
});
it("keeps a mixed-model batch advisory rather than comparing its scores or omitting evidence", async () => {
  const hits=[hit("a"),hit("b")];
  let call=0;
  const service={status:()=>({status:"ready"}),decide:async()=>{
    const r=result(call++ ? {relevance:{answer:1}}:{});r.model.size=call===1?"2b":"4b";r.model.alias=call===1?"two":"four";r.model.revision="fixed";return r;
  }} as unknown as DecisionService;
  const assessed=await assessPassages(service,"问题",hits);
  const out=assessed.hits;
  expect(assessed.decisions.every(d=>d.policy?.advisoryOnly && !d.policy.omit)).toBe(true);
  expect(out.map(h=>h.id)).toEqual(["a","b"]);
  expect(out.every(h=>h.assessment?.advisoryOnly)).toBe(true);
});
it("keeps the original candidates when the optional decision model cannot run", async () => {
  const hits = [{id:"a"}, {id:"b"}] as RetrievalHit[];
  const service = {decide:async()=>null,status:()=>({status:"unavailable"})} as unknown as DecisionService;
  expect((await assessPassages(service,"问题",hits)).hits).toBe(hits);
});
