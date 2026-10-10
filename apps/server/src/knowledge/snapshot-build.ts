import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeRepository, KnowledgeArticle } from "./repository.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";

// One heavy export at a time bounds duplicate SQLite/vector allocations. Waiting
// is asynchronous and does not block readers, HTTP listeners or model sessions.
let tail: Promise<void> = Promise.resolve();
export async function buildResearchSnapshot(input: {
  repository: KnowledgeRepository; materials: KnowledgeMaterial[]; articles: KnowledgeArticle[]; file: string;
  visible?: (id:string)=>boolean; includeUnanchoredState?: boolean; includeGroupCatalog?: boolean;
  signal?: AbortSignal;
}) {
  const queued = performance.now(), previous = tail;
  let release!:()=>void;
  tail = new Promise<void>(resolve=>{release=resolve;});
  await previous;
  try {
    input.signal?.throwIfAborted();
    const queueWaitMs = performance.now() - queued;
    const js = new URL("./snapshot-worker.js",import.meta.url);
    const source = !existsSync(fileURLToPath(js));
    const entry = source ? new URL("./snapshot-worker.ts",import.meta.url) : js;
    const sourceIds = new Set(input.materials.map(m=>m.sourceId));
    const visibleIds = input.visible ? [...input.repository.store.db.prepare("SELECT f.id,r.source_id FROM fragments f JOIN revisions r ON r.id=f.revision_id").iterate()]
      .filter(row=>sourceIds.has(String(row.source_id)) && input.visible!(String(row.id))).map(row=>String(row.id)) : undefined;
    const workerData = {
      entry:entry.href,database:join(input.repository.store.dataDir,"omem.sqlite"),
      materials:input.materials,articles:input.articles,file:input.file,
      visibleIds,
      includeUnanchoredState:input.includeUnanchoredState,includeGroupCatalog:input.includeGroupCatalog,
    };
    // Bun runs source TS directly. Node source tests use its built-in transform
    // and resolve emitted .js imports to sibling TS; installed Node uses only JS.
    const bun = !!process.versions.bun;
    const worker = bun || !source ? new Worker(fileURLToPath(entry),{workerData}) : new Worker(`
      const {registerHooks}=require('node:module');
      const {existsSync}=require('node:fs');
      const {fileURLToPath}=require('node:url');
      registerHooks({resolve(specifier,context,next){
        if(specifier.endsWith('.js') && context.parentURL?.startsWith('file:')){
          const url=new URL(specifier,context.parentURL);
          if(!existsSync(fileURLToPath(url))){
            url.pathname=url.pathname.slice(0,-3)+'.ts';
            if(existsSync(fileURLToPath(url)))return next(url.href,context);
          }
        }
        return next(specifier,context);
      }});
      import(require('node:worker_threads').workerData.entry);
    `,{eval:true,workerData,execArgv:["--experimental-transform-types"]});
    try {
      const result = await new Promise<{stages:Record<string,number>}>((resolve,reject)=>{
        let received=false;
        const abort = ()=>{void worker.terminate();reject(input.signal!.reason);};
        const clean = ()=>input.signal?.removeEventListener("abort",abort);
        worker.once("message",(message)=>{received=true;clean();message.error?reject(Error(message.error)):resolve(message);});
        worker.once("error",error=>{clean();reject(error);});
        worker.once("exit",code=>{clean();if(!received)reject(Error(`Snapshot worker exited ${code} without a result`));});
        input.signal?.addEventListener("abort",abort,{once:true});
        if(input.signal?.aborted)abort();
      });
      // Publishing checks live identity too. A source may change while this
      // fixed transaction is running; never present it as a current new input.
      for (const m of input.materials) if (input.repository.store.db.prepare("SELECT head FROM sources WHERE id=?").get(m.sourceId)?.head !== m.revisionId)
        throw Error("KNOWLEDGE_INPUT_CHANGED: source changed during snapshot construction");
      return {queueWaitMs,stages:result.stages};
    } finally { await worker.terminate(); }
  } finally { release(); }
}
