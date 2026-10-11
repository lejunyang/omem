import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import { scoringPassages } from "../src/retrieval/rerank-passages.js";
import { readParentContext } from "../src/retrieval/reading-context.js";
import { readingExcerpt } from "../src/retrieval/reading-excerpt.js";
import { captureRepositoryMaterials } from "../src/review/materials.js";
import { runCodeSync } from "../src/code/sync.js";
import type { RetrievalUnit } from "../src/retrieval/units.js";
import { createRetrieval } from "../src/retrieval/factory.js";
import type { DecisionService } from "../src/decision/service.js";

it("plans all original bytes of long operations instead of sampling away their middle", () => {
  const text = Array.from({ length: 700 }, (_, i) => `performStep(${i});`).join(
    "\n",
  );
  const unit = {
    text,
    title: "Work",
    headingPath: [],
    target: { kind: "source", startLine: 1, endLine: 700 },
  } as RetrievalUnit;
  const passages = scoringPassages(unit, "performStep", text.slice(0, 100), [
    { start: 0, end: text.length },
  ]);
  const covered = new Set(
    passages.flatMap((p) =>
      Array.from({ length: p.end - p.start }, (_, i) => p.start + i),
    ),
  );
  expect(covered.size).toBe(text.length);
  expect(passages.every((p) => p.text === text.slice(p.start, p.end))).toBe(
    true,
  );
});

it("sends Decision the full eligible operation after cross-encoder display excerpt selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-reading-")),
    store = new Store(join(dir, "data"));
  let material = "";
  const r = new UnifiedRetrieval(
    store.db,
    undefined,
    async () => ({
      id: "fixture",
      close: async () => {},
      score: async (_q, texts) =>
        texts.map((t) => (t.includes("保存状态") ? 0.9 : 0.1)),
    }),
    false,
    async (_q, hits) => {
      material = hits.find((h) => h.headingPath.at(-1) === "saveState")!.text;
      return hits;
    },
  );
  try {
    writeFileSync(
      join(dir, "work.ts"),
      "export function saveState() {\n // 保存状态\n" +
        Array.from({ length: 250 }, (_, i) => ` prepare(${i});`).join("\n") +
        '\n if (!currentLease()) throw Error("LEASE_EXPIRED");\n commit();\n}\n',
    );
    captureRepositoryMaterials(store, dir);
    await runCodeSync(store, dir);
    const traces: import("../src/retrieval/unified.js").RetrievalTrace[] = [];
    const hits = await r.search(
      { text: "保存状态的条件如何检查", diversify: false },
      (t) => traces.push(t),
    );
    expect(material).toContain('throw Error("LEASE_EXPIRED")');
    expect(material).toContain("commit();");
    const operation = hits.find((h) => h.headingPath.at(-1) === "saveState")!;
    expect(operation.text).toContain('throw Error("LEASE_EXPIRED")');
    expect(operation.readingRange?.complete).toBe(true);
    const candidate = (
      await r.searchSourcesAsync({
        text: "保存状态的条件如何检查",
        diversify: false,
      })
    ).find((h) => h.snippet.includes('throw Error("LEASE_EXPIRED")'))!;
    expect(candidate.sourceTarget?.kind).toBe("source");
    expect(candidate.readingRange?.complete).toBe(true);
    // Full returned context must not be mistaken for a successful model input.
    expect(
      traces
        .filter((t) => t.stage === "reranker-input")
        .flatMap((t) => t.hits)
        .some((h) => h.text.length < operation.text.length),
    ).toBe(true);
  } finally {
    await r.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("bounds a long reading excerpt without inventing text or silently claiming completeness", () => {
  const text = Array.from(
    { length: 900 },
    (_, i) => `step(${i}); // original line`,
  ).join("\n");
  const anchor = text.indexOf("step(500)");
  const excerpt = readingExcerpt(text, anchor);
  expect(excerpt.complete).toBe(false);
  expect(excerpt.text.length).toBeLessThanOrEqual(6000);
  expect(excerpt.text).toBe(text.slice(excerpt.start, excerpt.end));
  expect(excerpt.text).toContain("step(500)");
  expect(excerpt.text.startsWith("step(")).toBe(true);
  expect(excerpt.text.endsWith("original line")).toBe(true);
});

it("returns the host-approved fixed parent actually reread by Decision, preserving hidden-parent protection", async () => {
  const dir=mkdtempSync(join(tmpdir(),"omem-return-parent-")),store=new Store(dir);
  const service={status:()=>({status:"ready"}),decide:async(state:{material:string})=>({
    model:{alias:"fixture",revision:"fixed",size:"2b"},answers:{
      relevance:{choice:"answer",confidence:1,probabilities:{answer:.95}},
      evidence:{choice:"statement",confidence:1,probabilities:{statement:.95}},
      parent_context:{choice:state.material.includes("活动开始前")?"present":"needed",confidence:1,probabilities:{needed:state.material.includes("活动开始前")?0:.9}},
    }})} as unknown as DecisionService;
  const shared=createRetrieval(store.db,undefined,process.cwd(),service);
  try{
    const captured=store.capture({source:"file",externalId:"refund",title:"退款.md",context:{captureFormat:"verbatim-v1"},parts:[
      {type:"text",text:"# 退款\n仅限活动开始前申请。\n\n"},
      {type:"text",text:"退款入口在报名页，点击后提交申请。"},
    ]},{learning:false,notify:false});
    const [hit]=await shared.retrieval.search!({text:"退款入口",diversify:false,limit:1});
    expect(hit!.text).toContain("活动开始前");
    expect(hit!.assessment?.contextRead).toBe("expanded");
    expect(hit!.target).toEqual(hit!.assessment?.input?.target);
    expect(hit!.readingRange?.complete).toBe(true);
    const [hidden]=await shared.retrieval.search!({text:"退款入口",diversify:false,limit:1,visible:id=>id!==captured.revision.fragments[0]!.id});
    expect(hidden!.text).not.toContain("活动开始前");
    expect(hidden!.assessment?.contextRead).toBe("unavailable");
  }finally{await shared.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

it("supplements a fixed section but refuses hidden parent fragments or a replaced revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-parent-reading-")),
    store = new Store(dir),
    r = new UnifiedRetrieval(store.db);
  try {
    const captured = store.capture(
      {
        source: "file",
        externalId: "policy",
        title: "policy.md",
        context: { captureFormat: "verbatim-v1" },
        parts: [
          { type: "text", text: "# 退款条件\n退款需要在活动开始前申请。\n\n" },
          {
            type: "text",
            text: "退款入口在报名页。满足上面的条件后提交申请。",
          },
        ],
      },
      { learning: false, notify: false },
    );
    const hits = await r.search({ text: "退款入口", diversify: false });
    const hit = hits.find((h) => h.text.includes("退款入口"))!;
    expect(
      readParentContext(store.db, hit, { text: "退款入口" })?.text,
    ).toContain("活动开始前");
    const hidden = captured.revision.fragments[0]!.id;
    expect(
      readParentContext(store.db, hit, {
        text: "退款入口",
        visible: (id) => id !== hidden,
      }),
    ).toBeUndefined();
    store.capture({
      source: "file",
      externalId: "policy",
      title: "policy.md",
      parts: [{ type: "text", text: "新版材料只有新的规则。" }],
    });
    expect(
      readParentContext(store.db, hit, { text: "退款入口" }),
    ).toBeUndefined();
  } finally {
    await r.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
