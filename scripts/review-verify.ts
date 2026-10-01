/** Reproducible repository acceptance. Reports describe this run only. */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { createReviewStore } from "../apps/server/src/review/store.js";
import { runReviewSync } from "../apps/server/src/review/sync.js";
import { runCodeSync } from "../apps/server/src/code/sync.js";
import { restoreReviewKnowledge, writeReviewKnowledgeIndex } from "../apps/server/src/review/knowledge.js";
import { validateKnowledgeDocument } from "../apps/server/src/knowledge/repository.js";
import { buildReviewApp } from "../apps/server/src/review/app.js";
import { readRetrievalConfig } from "../apps/server/src/retrieval/factory.js";
import { SemanticRetrieval } from "../apps/server/src/retrieval/semantic.js";

const root=process.env.REVIEW_REPO_ROOT ?? process.cwd();
const full=process.argv.includes('--full');
const at=new Date().toISOString(), runId=at.replace(/[:.]/g,'-');
const output=join(root,'.repo-review/knowledge/verification.json');
const history=join(root,'.repo-review/knowledge/verification/history');
const logs=join(root,'.repo-review/runtime/verification',runId);
mkdirSync(logs,{recursive:true}); mkdirSync(history,{recursive:true});
const hash=(value: string | Buffer)=>createHash('sha256').update(value).digest('hex');
function sourceDigest() {
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0')
    .filter(p=>p && !p.startsWith('.repo-review/')).sort();
  return hash([...new Set(files)].map(p=>{const file=join(root,p);return `${p}:${existsSync(file)&&lstatSync(file).isFile()?hash(readFileSync(file)):'missing'}`;}).join('\n'));
}
const initialDigest=sourceDigest();
const queryPath=join(root,'.repo-review/knowledge/verification/queries.json');
const queryDigest=hash(readFileSync(queryPath));
const checks: {name:string;state:'passed'|'failed'|'skipped';details?:unknown}[]=[];
async function command(name:string,args:string[]) {
  console.log('CHECK',name);
  const chunks:Buffer[]=[];
  const result=await new Promise<{exitCode:number|null;error?:string}>(resolve=>{
    const child=spawn('osdk',args,{cwd:root,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>chunks.push(Buffer.from(chunk)));child.stderr.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    child.on('error',error=>resolve({exitCode:null,error:String(error)}));child.on('close',exitCode=>resolve({exitCode}));
  });
  const bytes=Buffer.concat(chunks), log=join(logs,name+'.log');writeFileSync(log,bytes);
  checks.push({name,state:result.exitCode===0?'passed':'failed',details:{command:['osdk',...args],...result,log:relative(root,log),sha256:hash(bytes)}});
  console.log('RESULT',name,result.exitCode);
}
for(const [name,args] of [['dependencies',['deps','--frozen']],['project',['run','check']],['liveChineseRetrieval',['run','retrieval:verify']]] as const) {
  if(full) await command(name,[...args]);else checks.push({name,state:'skipped',details:'Run with --full; earlier results are not inherited.'});
}
const report: Record<string,unknown>={version:4,recordedAt:at,implementationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDigest:initialDigest,queryDigest,mode:full?'full':'repository',checks,
  scope:'本次自动检查；不继承历史通过率，不调用生成式模型。独立语义复核记录读取自知识文章。',
  history:'verification/history/；旧截图与 seed 核对仅用于历史追溯。运行日志保存在 gitignored runtime。'};
const store=createReviewStore(root);
let app: Awaited<ReturnType<typeof buildReviewApp>>['app'] | undefined;
try {
  await runReviewSync(store,root);await runCodeSync(store,root);
  const restored=restoreReviewKnowledge(store,root), repo=restored.repository;repo.refresh();
  const materials=new Map(repo.materials().map(m=>[m.key,m]));
  const articles=new Map(repo.list().filter(a=>a.current).map(a=>[a.document.key,a]));
  const errors:{key:string;error:string}[]=[];
  let citations=0,articleLinks=0;
  for(const article of articles.values())try {
    validateKnowledgeDocument(article.document,materials,articles);
    if(article.review.verdict!=='accepted')throw Error('Missing accepted independent review');
    for(const dep of article.dependencies)if((dep.kind==='material'?materials.get(dep.key)?.digest:articles.get(dep.key)?.revision)!==dep.digest)throw Error('Stale dependency: '+dep.key);
    citations+=article.document.citations.length;articleLinks+=article.document.citations.filter(c=>c.target.kind==='article').length;
  }catch(error){errors.push({key:article.document.key,error:String(error)});}
  const reviewed=[...materials.keys()].filter(key=>articles.has(key)).length;
  report.knowledge={materials:materials.size,reviewedMaterials:reviewed,pendingMaterials:materials.size-reviewed,currentArticles:articles.size,citations,articleLinks,errors,
    restore:restored.restored.reduce((counts,r)=>{counts[r.state]=(counts[r.state]??0)+1;return counts;},{} as Record<string,number>),
    incomplete:reviewed<materials.size,note:'未覆盖或过期文章不计为通过；本检查只验证当前正文，不能代表全库已经生成。'};
  checks.push({name:'currentKnowledgeReferences',state:errors.length?'failed':'passed',details:{articles:articles.size,citations,errors}});
  writeReviewKnowledgeIndex(root,[...articles.values()]);
  const configPath=process.env.REVIEW_RETRIEVAL_CONFIG ?? join(root,'config/retrieval.json');
  const config=existsSync(configPath)?readRetrievalConfig(configPath):undefined;
  const built=await buildReviewApp({store,repoRoot:root,retrievalConfig:config});app=built.app;
  if(built.retrieval instanceof SemanticRetrieval) {
    try{while(await built.retrieval.indexBatch(16)){};checks.push({name:'semanticIndex',state:'passed',details:built.retrieval.health()});}
    catch(error){checks.push({name:'semanticIndex',state:'failed',details:String(error)});}
  }else checks.push({name:'semanticIndex',state:'skipped',details:'Semantic retrieval is not configured.'});
  await app.listen({port:0,host:'127.0.0.1'});
  const port=(app.server.address() as {port:number}).port;
  const cases=z.array(z.object({query:z.string(),expectedPaths:z.array(z.string()).min(1)})).min(1).parse(JSON.parse(readFileSync(queryPath,'utf8')));
  const eligible=store.db.prepare(`SELECT f.id,json_extract(r.body,'$.context.filePath') AS filePath FROM fragments f
    JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id LEFT JOIN review_source_meta m ON m.source_id=s.id
    WHERE m.removed IS NULL OR m.removed=0`).all() as {id:string;filePath:string}[];
  const paths=new Map(eligible.map(row=>[row.id,row.filePath]));
  const results=[];
  for(const item of cases){
    const start=performance.now(), response=await fetch(`http://127.0.0.1:${port}/api/review/search?q=${encodeURIComponent(item.query)}`);
    if(!response.ok)throw Error(`Search HTTP ${response.status}`);
    const hits=await response.json() as {filePath:string;snippet:string;routes:string[]}[];
    const rawQuery={text:item.query,limit:20,diversify:false,visible:(id:string)=>paths.has(id)};
    const raw=built.retrieval.searchSourcesAsync?await built.retrieval.searchSourcesAsync(rawQuery):built.retrieval.searchSources(rawQuery);
    const baselineTop5=raw.slice(0,5).map(hit=>paths.get(hit.id));
    const rank=hits.findIndex(hit=>item.expectedPaths.includes(hit.filePath))+1;
    results.push({...item,status:response.status,baselineTop5,baselineUniquePathsAt5:new Set(baselineTop5).size,passed:rank>0&&rank<=5,firstExpectedRank:rank||null,uniquePathsAt5:new Set(hits.slice(0,5).map(h=>h.filePath)).size,elapsedMs:Math.round(performance.now()-start),top5:hits.slice(0,5).map(h=>({path:h.filePath,routes:h.routes,snippet:h.snippet.slice(0,160)}))});
  }
  report.retrieval={cases:results,limit:'六条公开的仓库回归问题，非完整相关性评测；top-5 命中不证明回答正确。'};
  checks.push({name:'repositorySearch',state:results.every(r=>r.passed)?'passed':'failed',details:{passed:results.filter(r=>r.passed).length,total:results.length}});
}catch(error){checks.push({name:'repositoryRun',state:'failed',details:String(error)});}
finally {if(app)await app.close();else store.close();}
checks.push({name:'unchangedSourcesDuringVerification',state:sourceDigest()===initialDigest&&hash(readFileSync(queryPath))===queryDigest?'passed':'failed'});
report.passed=checks.every(c=>c.state!=='failed');
if(existsSync(output)){
  const old=readFileSync(output), previous=JSON.parse(old.toString());
  const date=String(previous.recordedAt??'undated').replace(/[^\w-]/g,'-');
  const archived=join(history,`${date}-${hash(old).slice(0,8)}.json`);
  if(!existsSync(archived))writeFileSync(archived,old);
}
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:relative(root,output),passed:report.passed,checks,knowledge:report.knowledge},null,2));
if(!report.passed)process.exitCode=1;
