import { it, expect, vi } from "vitest";
import { assessPassages, passagePolicy } from "../src/decision/passages.js";
import type {
  DecisionService,
  DecisionResult,
} from "../src/decision/service.js";
import type { RetrievalHit } from "../src/retrieval/port.js";
const hit = (id: string) =>
  ({
    id,
    text: id,
    title: id,
    kind: "source",
    headingPath: [],
    context: "",
    score: 1,
    routes: [],
    references: [],
    target: {
      kind: "source",
      key: id,
      revisionId: id,
      startLine: 1,
      endLine: 1,
      digest: id,
    },
  }) as RetrievalHit;
const result = (change: Record<string, Record<string, number>> = {}) =>
  ({
    model: { size: "2b" },
    answers: Object.fromEntries(
      Object.entries({
        relevance: { unrelated: 0.999 },
        answer_coverage: { none: 0.999 },
        evidence: { none: 0.999 },
        premise: { no_conflict: 0.999 },
        parent_context: { not_needed: 0.999 },
        ...change,
      }).map(([k, probabilities]) => [k, { probabilities }]),
    ),
  }) as unknown as DecisionResult;
it("waits for cold and slow decisions without either hidden timeout, and keeps cancellation",async()=>{
  vi.useFakeTimers();
  const controller=new AbortController(),inputs:string[]=[];
  const service={status:()=>({status:"idle"}),decide:async(state:{material:string},_questions:unknown,options:{timeoutMs:number;signal:AbortSignal})=>{
    expect(options.timeoutMs).toBe(0);expect(options.signal).toBe(controller.signal);
    inputs.push(state.material);await new Promise(resolve=>setTimeout(resolve,130_000));
    return result({relevance:{answer:0.99},evidence:{statement:0.99}});
  }} as unknown as DecisionService;
  try{
    const task=assessPassages(service,"问题",[hit("a"),hit("b")],{budgetMs:0,signal:controller.signal});
    await vi.advanceTimersByTimeAsync(260_001);
    const out=await task;expect(inputs).toEqual(["a","b"]);expect(out.decisions).toHaveLength(2);
    controller.abort(Error("cancelled"));
    await expect(assessPassages(service,"问题",[hit("c")],{budgetMs:0,signal:controller.signal})).rejects.toThrow("cancelled");
  }finally{vi.useRealTimers();}
});
it("omits clearly irrelevant passages but keeps contradictory evidence and missing conditions", () => {
  expect(passagePolicy(result()).omit).toBe(true);
  expect(passagePolicy(result({ premise: { contradicts: 0.98 } })).omit).toBe(
    false,
  );
  expect(passagePolicy(result({ parent_context: { needed: 0.8 } })).omit).toBe(
    false,
  );
  expect(
    passagePolicy(result({ relevance: { unrelated: 0.5, uncertain: 0.4 } }))
      .omit,
  ).toBe(false);
});
it("keeps 0.8B rejection as advice", () => {
  const advice = result({ relevance: { unrelated: 0.999, answer: 0.001 } });
  advice.model.size = "0.8b";
  expect(passagePolicy(advice).omit).toBe(false);
  expect(passagePolicy(advice).priority).toBe(0.001);
});
it("distinguishes a low answer option from an irrelevant material and records strong support", () => {
  const background = result({
    relevance: { answer: 0.01, background: 0.96, unrelated: 0.01 },
    evidence: { statement: 0.95 },
  });
  expect(passagePolicy(background).omit).toBe(false);
  const useful = result({
    relevance: { answer: 0.96 },
    evidence: { statement: 0.97 },
    parent_context: { not_needed: 1 },
  });
  expect(passagePolicy(useful).judgment).toBe("strong_answer");
});
it("reads requested fixed context once and records the input actually judged", async () => {
  const initial = hit("a"),
    parent = { ...initial, text: "条件明确后才能申请退款。入口在报名页。" };
  const inputs: string[] = [];
  const service = {
    status: () => ({ status: "ready" }),
    decide: async (state: { material: string }) => {
      inputs.push(state.material);
      return result({
        relevance: { answer: 0.97 },
        evidence: { statement: 0.98 },
        parent_context:
          state.material === initial.text
            ? { needed: 0.99 }
            : { not_needed: 0.99 },
      });
    },
  } as unknown as DecisionService;
  const out = await assessPassages(service, "怎样退款？", [initial], {
    readContext: () => parent,
  });
  expect(inputs).toEqual([initial.text, parent.text]);
  expect(out.hits[0]!.assessment?.contextRead).toBe("expanded");
  expect(out.hits[0]!.assessment?.input?.characters).toBe(parent.text.length);
  expect(out.hits[0]!.assessment?.judgment).toBe("strong_answer");
});
it("attaches small-model advice without dropping or reordering retrieved evidence", async () => {
  const hits = [hit("a"), hit("b")];
  let call = 0;
  const service = {
    status: () => ({ status: "ready" }),
    decide: async () => {
      const r = result({
        relevance: call++ ? { answer: 1 } : { unrelated: 1 },
      });
      r.model.size = "0.8b";
      return r;
    },
  } as unknown as DecisionService;
  const out = (await assessPassages(service, "问题", hits)).hits;
  expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  expect(out.every((h) => h.assessment?.advisoryOnly)).toBe(true);
  expect(out[1]!.assessment!.priority).toBeGreaterThan(
    out[0]!.assessment!.priority,
  );
});
it("keeps a mixed-model batch advisory rather than comparing its scores or omitting evidence", async () => {
  const hits = [hit("a"), hit("b")];
  let call = 0;
  const service = {
    status: () => ({ status: "ready" }),
    decide: async () => {
      const r = result(call++ ? { relevance: { answer: 1 } } : {});
      r.model.size = call === 1 ? "2b" : "4b";
      r.model.alias = call === 1 ? "two" : "four";
      r.model.revision = "fixed";
      return r;
    },
  } as unknown as DecisionService;
  const assessed = await assessPassages(service, "问题", hits);
  const out = assessed.hits;
  expect(
    assessed.decisions.every((d) => d.policy?.advisoryOnly && !d.policy.omit),
  ).toBe(true);
  expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  expect(out.every((h) => h.assessment?.advisoryOnly)).toBe(true);
});
it("keeps the original candidates when the optional decision model cannot run", async () => {
  const hits = [{ id: "a" }, { id: "b" }] as RetrievalHit[];
  const service = {
    decide: async () => null,
    status: () => ({ status: "unavailable" }),
  } as unknown as DecisionService;
  expect((await assessPassages(service, "问题", hits)).hits).toBe(hits);
});
