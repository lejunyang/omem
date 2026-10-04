/** Full pinned T2Retrieval dev ranking diagnosis. Labels never enter the index.
 * Resumes identical runs, stores no benchmark data in the user's library, and
 * releases the temporary database even when interrupted between questions.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { Store } from "../apps/server/src/store.js";
import { UnifiedRetrieval } from "../apps/server/src/retrieval/unified.js";
import { indexText } from "../apps/server/src/retrieval/units.js";
import { queryTerms } from "../apps/server/src/retrieval/relevance.js";
import { taskFlag } from "./task-args.js";

type Manifest = { repo: string; revision: string; qrelsRepo: string; qrelsRevision: string; files: {role: string; url: string; size: number; sha256: string}[] };
type TextRow = { id: string; text: string };
const manifest = JSON.parse(readFileSync("config/benchmarks/t2-retrieval.json", "utf8")) as Manifest;
const directory = resolve(process.env.osdk_arg_directory ?? process.argv[2] ?? ".repo-review/runtime/benchmarks/t2-retrieval");
mkdirSync(directory, { recursive: true });
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim();
const sourcePaths = ["scripts/benchmark-t2.ts", "apps/server/src/retrieval/unified.ts", "apps/server/src/retrieval/units.ts", "apps/server/src/retrieval/relevance.ts", "apps/server/src/retrieval/code-navigation.ts", "pnpm-lock.yaml"];
const identity = hash(JSON.stringify(manifest) + sourcePaths.map(p => hash(readFileSync(p))).join(":"));
const statePath = join(directory, "run-state.json"), rowsPath = join(directory, "rankings.ndjson"), reportPath = join(directory, "ranking-report.json");
if (taskFlag("reset")) for (const path of [statePath, rowsPath, reportPath]) rmSync(path, {force:true});
if (existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).identity !== identity) throw Error("Benchmark inputs changed. Use --reset to replace the previous comparison, or select another cache directory.");
if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify({identity, sourcePaths, implementationCommit, startedAt:new Date().toISOString()}) + "\n");
const runState = JSON.parse(readFileSync(statePath,"utf8"));
for (const file of manifest.files) {
  const path = join(directory, file.role + ".parquet");
  if (!existsSync(path)) {
    console.log("Downloading", file.role);
    const response = await fetch(file.url);
    if (!response.ok) throw Error(`Download HTTP ${response.status}: ${file.role}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw Error(`Download checksum mismatch: ${file.role}`);
    writeFileSync(path, bytes);
  }
  const bytes = readFileSync(path);
  if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw Error(`Cached checksum mismatch: ${file.role}`);
}
async function readRows(role: string) { return parquetReadObjects({ file: await asyncBufferFromFile(join(directory, role + ".parquet")) }); }
function metrics(ids: string[], relevant: Set<string>) {
  const at = (k: number) => ids.slice(0,k).filter(id=>relevant.has(id)).length;
  const dcg = ids.slice(0,10).reduce((n,id,i)=>n+(relevant.has(id)?1/Math.log2(i+2):0),0);
  const ideal = Array.from({length:Math.min(10,relevant.size)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  return {recall5:at(5)/relevant.size,recall10:at(10)/relevant.size,recall20:at(20)/relevant.size,ndcg10:dcg/ideal,hit5:Number(at(5)>0)};
}
type Scores = ReturnType<typeof metrics>;
type Result = { id:string; query:string; baseline:Scores; omem:Scores; baselineIds:string[]; omemIds:string[]; elapsedMs:number };
const results: Result[] = existsSync(rowsPath) ? readFileSync(rowsPath,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)) : [];
const done = new Set(results.map(r=>r.id));
if(done.size !== results.length) throw Error("Duplicate question in checkpoint");
const queries = await readRows("queries") as TextRow[];
const qrels = new Map<string,Set<string>>();
for(const row of await readRows("qrels")) if(Number(row.score)>0) {
  const qid=String(row.qid), ids=qrels.get(qid)??new Set<string>();ids.add(String(row.pid));qrels.set(qid,ids);
}
if(new Set(queries.map(q=>q.id)).size!==queries.length || queries.length!==qrels.size || queries.some(q=>!qrels.has(q.id))) throw Error("Query/qrels denominator mismatch");
if([...done].some(id=>!qrels.has(id))) throw Error("Checkpoint question missing from dataset");
let stopped=false;
for(const signal of ["SIGINT","SIGTERM"] as const) process.on(signal,()=>{stopped=true;});
const temporary=mkdtempSync(join(tmpdir(),"omem-t2-ranking-")), store=new Store(temporary);
const retrieval=new UnifiedRetrieval(store.db,undefined,undefined,true);
let corpusSize=0;
function saveReport(complete:boolean) {
  const mean=(arm:"baseline"|"omem")=>Object.fromEntries(Object.keys(results[0]?.[arm]??{}).map(k=>[k,results.reduce((n,r)=>n+r[arm][k as keyof Scores],0)/results.length]));
  const report={recordedAt:new Date().toISOString(),complete,identity,implementationCommit:runState.implementationCommit,startedAt:runState.startedAt,dataset:manifest,corpusSize,questions:queries.length,completedQuestions:results.length,
    scope:"Full pinned C-MTEB T2Retrieval dev: official Chinese corpus, queries and positive qrels. Both methods share ICU query terms and FTS5 field weights. BM25 versus production lexical retrieval; no capture, embedding, reranker, classification, ACP or answer generation. Each official passage has its own owner because the dataset does not provide parent-document IDs. Unjudged passages are not proven irrelevant. Partial results are ordered progress, not representative quality estimates.",
    baseline:mean("baseline"),omem:mean("omem"),recall20Improved:results.filter(r=>r.omem.recall20>r.baseline.recall20).length,recall20Regressed:results.filter(r=>r.omem.recall20<r.baseline.recall20).length,lostAllTop20Support:results.filter(r=>r.baseline.recall20>0 && r.omem.recall20===0).map(r=>r.id),resultsFile:"rankings.ndjson"};
  writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
  return report;
}
try {
  const corpus=await readRows("corpus") as TextRow[];
  const ids=new Set<string>();
  const insert=store.db.prepare("INSERT INTO retrieval_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"), fts=store.db.prepare("INSERT INTO retrieval_units_fts(id,title,context,body) VALUES(?,?,?,?)");
  store.db.exec("BEGIN");
  for(const doc of corpus) {
    if(ids.has(doc.id))throw Error(`Duplicate corpus ID: ${doc.id}`);ids.add(doc.id);
    const anchor={kind:"source",key:doc.id,revisionId:doc.id,digest:hash(doc.text),startLine:1,endLine:doc.text.split("\n").length,fragmentIds:[doc.id]};
    insert.run(doc.id,doc.id,"source","",doc.text,"","[]",JSON.stringify(anchor),JSON.stringify([anchor]),JSON.stringify([doc.id]),"[]","{}",null,"document",null);
    fts.run(doc.id,"","",indexText(doc.text));
    if(ids.size%10000===0){console.log("Indexed passages",ids.size);await setImmediate();}
    if(stopped)break;
  }
  store.db.exec("COMMIT");corpusSize=ids.size;
  if(!stopped) {
    for(const relevant of qrels.values())for(const id of relevant)if(!ids.has(id))throw Error(`Missing qrel document: ${id}`);
    const bm25=store.db.prepare("SELECT id FROM retrieval_units_fts WHERE retrieval_units_fts MATCH ? ORDER BY bm25(retrieval_units_fts,0,2,1,4) LIMIT 20");
    for(const q of queries) {
      if(done.has(q.id))continue;
      const start=performance.now(), relevant=qrels.get(q.id)!;
      const terms=[...new Set(queryTerms(q.text).flatMap(t=>indexText(t).split(" ")).filter(Boolean))];
      const phrase=terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(" OR ");
      const baselineIds=phrase?bm25.all(phrase).map(r=>String(r.id)):[];
      const omemIds=(await retrieval.search({text:q.text,limit:20})).map(r=>r.id);
      const result={id:q.id,query:q.text,baseline:metrics(baselineIds,relevant),omem:metrics(omemIds,relevant),baselineIds,omemIds,elapsedMs:Math.round(performance.now()-start)};
      appendFileSync(rowsPath,JSON.stringify(result)+"\n");results.push(result);
      if(results.length%100===0){saveReport(false);console.log("Compared",results.length,"/",queries.length,"last ms",result.elapsedMs);}
      await setImmediate();if(stopped)break;
    }
  }
  const report=saveReport(!stopped && results.length===queries.length);
  console.log(JSON.stringify(report,null,2));
  if(!report.complete)process.exitCode=130;
} finally {
  await retrieval.close();store.close();rmSync(temporary,{recursive:true,force:true});
}
