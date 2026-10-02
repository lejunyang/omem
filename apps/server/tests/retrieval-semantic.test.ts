import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { SemanticRetrieval } from "../src/retrieval/semantic.js";
import { captureSchema } from "../../../packages/contracts/src/index.js";
import type { EmbeddingModel } from "../src/retrieval/embedding.js";

it("semantic evidence survives restart, indexes long tails, and excludes stale/derived/invisible sources before top-N", async () => {
  const dir = mkdtempSync(join(tmpdir(),"omem-vectors-")), store = new Store(dir);
  let passages = 0;
  const model: EmbeddingModel = { id: "fixture-v1", close: async () => {}, async embed(texts,purpose) {
    if (purpose === "passage") passages += texts.length;
    return texts.map(t => purpose === "query" || t.includes("智齿") ? [1,0] : [0,1]);
  } };
  const capture = (id: string,text: string,derived = false) => store.capture(captureSchema.parse({ source: "manual",externalId: id,title: id,parts:[{type:"text",text}],provenance:{collectorId:"test",actorId:"owner",actorType:"owner",actorVerifiedBy:"test",sourceUri:null,eventId:null,eventAt:null,timezone:null,quoted:false,forwarded:false,producerKind:derived ? "derived" : "original"} })).revision;
  let retrieval = new SemanticRetrieval(store.db, async () => model);
  try {
    const old = capture("appointment","拔智齿");
    const current = capture("appointment","无关的长段落".repeat(150)+"拔智齿");
    const hidden = capture("hidden","智齿");
    capture("derived","智齿",true);
    while (await retrieval.indexBatch()) {}
    const before = passages;
    await retrieval.close();
    retrieval = new SemanticRetrieval(store.db,async () => model);
    expect(await retrieval.indexBatch()).toBe(0);
    expect(passages).toBe(before);
    const hits = await retrieval.searchSourcesAsync({text:"dental appointment",limit:1,visible:id=>id!==hidden.fragments[0]!.id});
    expect(hits[0]?.fragmentId).toBe(current.fragments[0]!.id);
    expect(hits[0]?.snippet).toContain("智齿");
    expect(hits[0]?.routes).toContain("semantic");
    expect(store.db.prepare("SELECT 1 FROM fragment_embedding_heads WHERE fragment_id=?").get(old.fragments[0]!.id)).toBeUndefined();
    expect(await retrieval.searchSourcesAsync({text:"dental",timeRange:{to:"2000-01-01T00:00:00Z"}})).toEqual([]);
  } finally { await retrieval.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

it("missing optional weights preserve lexical search and report a degraded index", async () => {
  const dir = mkdtempSync(join(tmpdir(),"omem-vectors-")), store = new Store(dir);
  const retrieval = new SemanticRetrieval(store.db,async () => { throw Error("model not installed"); });
  try {
    store.capture(captureSchema.parse({source:"manual",externalId:"doc",title:"文档",parts:[{type:"text",text:"固定证据 circuit breaker"}]}));
    await expect(retrieval.indexBatch()).rejects.toThrow("model not installed");
    expect(retrieval.health().semantic.state).toBe("degraded");
    expect((await retrieval.searchSourcesAsync({text:"circuit"}))[0]?.snippet).toContain("circuit");
  } finally { await retrieval.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

it("optional pair ranking chooses the useful passage without reintroducing hidden candidates", async () => {
  const dir=mkdtempSync(join(tmpdir(),"omem-pair-ranking-")),store=new Store(dir);
  const retrieved:string[]=[];
  const retrieval=new SemanticRetrieval(store.db,async()=>{throw Error("unused embedding");},async()=>({id:"pair-fixture",close:async()=>{},score:async(_q,passages)=>{retrieved.push(...passages);return passages.map(p=>p.includes("渡轮")?.9:.1);}}));
  try {
    const put=(id:string,text:string)=>store.capture(captureSchema.parse({source:"manual",externalId:id,title:id,parts:[{type:"text",text}]})).revision.fragments[0]!.id;
    const useful=put("trip","海边度假需乘渡轮到岛上，船票提前一天预订。");
    put("noise","海边度假图片的按钮颜色可以调整。");
    const hidden=put("private","海边度假需乘渡轮，私人行程内容。");
    const hits=await retrieval.searchSourcesAsync({text:"海边度假 交通",visible:id=>id!==hidden});
    expect(hits[0]?.id).toBe(useful);
    expect(hits[0]?.routes).toContain("cross-encoder");
    expect(retrieved.join("\n")).not.toContain("私人行程");
  } finally {await retrieval.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
