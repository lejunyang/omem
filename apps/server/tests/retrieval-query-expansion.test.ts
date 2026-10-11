import {it, expect} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../src/store.js";
import {UnifiedRetrieval} from "../src/retrieval/unified.js";
import {recallQueries, mergeQueryRecall} from "../src/retrieval/recall-queries.js";
import {RetrievalProjection, refreshLexicalIndex, indexText} from "../src/retrieval/units.js";

it("brings an English implementation into Chinese investigation without losing original candidates or exposing hidden material", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-multi-query-")), store = new Store(directory);
  const retrieval = new UnifiedRetrieval(store.db);
  try {
    for (let i=0;i<120;i++) store.capture({source:"manual",externalId:`discussion-${i}`,title:`预约恢复讨论${i}`,parts:[{type:"text",text:`预约恢复需要先调查记录，这是讨论${i}。`} ]});
    const implementation = store.capture({source:"file",externalId:"archive",title:"archive.ts",context:{filePath:"archive.ts",captureFormat:"verbatim-v1"},parts:[{type:"text",text:"/** Restore a deleted reservation from the archive. */\nexport function restoreReservation(id: string) {\n  return archive.restore(id);\n}"}]});
    const hidden = store.capture({source:"manual",externalId:"private",title:"private",parts:[{type:"text",text:"Restore a deleted reservation private archive secret."}]});
    const hiddenIds = new Set(store.db.prepare("SELECT id FROM fragments WHERE revision_id=?").all(hidden.revision.id).map(row=>String(row.id)));
    const text="预约恢复", queryVariants=["restore deleted reservation from archive"];
    const base=await retrieval.search({text,limit:20});
    expect(base.some(h=>h.references.some(r=>r.revisionId===implementation.revision.id))).toBe(false);
    let expanded: string[]=[];let candidateIds: string[]=[];
    const hits=await retrieval.search({text,queryVariants,limit:200,visible:id=>!hiddenIds.has(id)},trace=>{
      if(trace.stage==="query-expansion") {expanded=trace.queries!;candidateIds=trace.hits.map(h=>h.id);}
    });
    expect(expanded).toEqual([text,...queryVariants]);
    expect(base.every(h=>candidateIds.includes(h.id))).toBe(true);
    expect(hits.some(h=>h.references.some(r=>r.revisionId===implementation.revision.id)&&h.text.includes("archive.restore(id)"))).toBe(true);
    expect(hits.some(h=>h.references.some(r=>r.revisionId===hidden.revision.id))).toBe(false);
    expect((await retrieval.searchSourcesAsync({text,queryVariants})).some(h=>h.sourceRevisionId===implementation.revision.id)).toBe(true);
    expect(retrieval.searchSources({text,queryVariants}).some(h=>h.sourceRevisionId===implementation.revision.id)).toBe(true);
  } finally {await retrieval.close(); store.close();rmSync(directory,{recursive:true,force:true});}
});

it("asks the final decision once about the original question after alternatives have recalled evidence", async () => {
  const directory=mkdtempSync(join(tmpdir(),"omem-query-decision-")),store=new Store(directory);
  const questions:string[]=[];
  const retrieval=new UnifiedRetrieval(store.db,undefined,undefined,false,async(q,hits)=>{questions.push(q.text);return hits;});
  try {
    store.capture({source:"manual",externalId:"answer",title:"Durable notes",parts:[{type:"text",text:"Preserve changes by writing a durable checkpoint."}]});
    const hits=await retrieval.search({text:"怎样保留改动？",queryVariants:["durable checkpoint","preserve changes"]});
    expect(hits.length).toBeGreaterThan(0);expect(questions).toEqual(["怎样保留改动？"]);
  }finally{await retrieval.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

it("does not count paraphrase duplication as independent route corroboration", () => {
  const make=(id:string,rank:number)=>({unit:{id},score:123,routes:["bm25"],routeRanks:{bm25:rank}});
  const original=[make("A",0),make("B",1)];
  const one=mergeQueryRecall([original,[make("B",0)]]);
  const repeated=mergeQueryRecall([original,[make("B",0)],[make("B",0)]]);
  expect(repeated).toEqual(one);
  expect(repeated[0]!.score).toBe(repeated[1]!.score);
  expect(recallQueries("中文问题",[" 中文问题 ","ＡＢＣ","abc","", "x".repeat(401),"four", "five", "six"]))
    .toEqual(["中文问题","ＡＢＣ","four","five"]);
});

it("migrates identifier word recall without changing original identities or already computed vectors", async () => {
  const directory=mkdtempSync(join(tmpdir(),"omem-lexical-migration-")),store=new Store(directory);
  const retrieval=new UnifiedRetrieval(store.db);
  try{
    store.capture({source:"file",externalId:"scan",title:"scan.ts",context:{filePath:"scan.ts"},parts:[{type:"text",text:"export function recordCheckpoint(saved_blob_id: string) {\n return { checkpointVersion: 2, saved_blob_id };\n}"}]});
    new RetrievalProjection(store.db).sync();
    const before=store.db.prepare("SELECT * FROM retrieval_units ORDER BY id").all();
    const unit=String(before[0]!.id), bytes=Buffer.from(new Float32Array([.2,.8]).buffer);
    store.db.prepare("INSERT INTO retrieval_unit_vectors(unit_id,model_id,part,start_offset,end_offset,vector) VALUES(?,?,?,?,?,?)").run(unit,"preserved-model",0,0,10,bytes);
    store.db.prepare("INSERT INTO retrieval_unit_vector_heads VALUES(?,?)").run(unit,"preserved-model");
    const vectorBefore=store.db.prepare("SELECT * FROM retrieval_unit_vectors").all();
    store.db.exec("UPDATE retrieval_lexical_state SET version='old'; DELETE FROM retrieval_units_fts;");
    const insert=store.db.prepare("INSERT INTO retrieval_units_fts(id,title,context,body) VALUES(?,?,?,?)");
    for(const row of before) insert.run(String(row.id),"scan", "recordcheckpoint", "recordcheckpoint saved_blob_id checkpointversion");
    expect(refreshLexicalIndex(store.db)).toBe(true);
    expect(refreshLexicalIndex(store.db)).toBe(false);
    expect(store.db.prepare("SELECT * FROM retrieval_units ORDER BY id").all()).toEqual(before);
    expect(store.db.prepare("SELECT * FROM retrieval_unit_vectors").all()).toEqual(vectorBefore);
    expect(store.db.prepare("SELECT * FROM retrieval_unit_vector_heads").get()).toMatchObject({unit_id:unit,model_id:"preserved-model"});
    const hits=await retrieval.search({text:"saved blob checkpoint version"});
    expect(hits.some(h=>h.text.includes("checkpointVersion"))).toBe(true);
    const terms=new Set(indexText("HTTPClient recordCheckpoint saved_blob_id").split(" "));
    for(const term of ["httpclient","http","client","recordcheckpoint","record","checkpoint","saved_blob_id","saved","blob"]) expect(terms.has(term)).toBe(true);
  }finally{await retrieval.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
