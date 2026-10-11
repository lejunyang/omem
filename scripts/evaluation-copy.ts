/** Pin an owned WAL read view before incremental backup. Concurrent capture
 * writes then cannot repeatedly restart the evaluation copy. */
import { DatabaseSync, backup } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export async function copyEvaluationLibrary(sourceDir: string, dataDir: string, publish: (event: unknown) => void = () => {}) {
  const startedAt = new Date().toISOString(), start = performance.now();
  const file = join(sourceDir,"omem.sqlite"), target = join(dataDir,"omem.sqlite");
  if (existsSync(target)) throw Error("Choose a fresh evaluation directory");
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  publish({startedAt,stage:"database-open"});
  const opened = performance.now(), source = new DatabaseSync(file);
  const databaseOpenMs = performance.now()-opened;
  let snapshotReadMs = 0, backupMs = 0, callbacks = 0, progressBackwards = 0, maxStepGapMs = 0;
  const samples: {elapsedMs:number;totalPages:number;remainingPages:number}[] = [];
  let pageSize = 0, pages = 0;
  try {
    source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=30000; BEGIN");
    const reading = performance.now();
    source.prepare("SELECT count(*) FROM sqlite_schema").get();
    snapshotReadMs = performance.now()-reading;
    pageSize = Number(source.prepare("PRAGMA page_size").get()!.page_size);
    pages = Number(source.prepare("PRAGMA page_count").get()!.page_count);
    publish({startedAt,stage:"database-backup",databaseOpenMs,snapshotReadMs,pages,pageSize});
    const copying = performance.now();let previousRemaining = Infinity, previousAt = copying;
    await backup(source,target,{progress(p){
      const now = performance.now();callbacks++;
      if(p.remainingPages>previousRemaining)progressBackwards++;
      maxStepGapMs=Math.max(maxStepGapMs,now-previousAt);previousAt=now;previousRemaining=p.remainingPages;
      if(!samples.length || (samples.length<60 && now-copying-samples.at(-1)!.elapsedMs>=5000)){
        const sample={elapsedMs:now-copying,...p};samples.push(sample);publish({stage:"database-backup",...sample,progressBackwards});
      }
    }});
    backupMs=performance.now()-copying;
    source.exec("ROLLBACK");
  } finally { source.close(); }
  const copyingAssets=performance.now(),assets=join(sourceDir,"assets");
  if(existsSync(assets))cpSync(assets,join(dataDir,"assets"),{recursive:true});
  const finishedAt=new Date().toISOString();
  const result={startedAt,finishedAt,wallElapsedMs:Date.parse(finishedAt)-Date.parse(startedAt),totalMs:performance.now()-start,databaseOpenMs,snapshotReadMs,backupMs,assetsMs:performance.now()-copyingAssets,
    inputBytes:statSync(file).size,pages,pageSize,callbacks,progressBackwards,maxStepGapMs,samples,
    lockWaitMs:null,lockTimingNote:"SQLite backup does not expose busy-wait duration. snapshotReadMs includes read-lock establishment; callback gaps are observations, not measured lock waits."};
  publish({stage:"completed",...result});return result;
}
