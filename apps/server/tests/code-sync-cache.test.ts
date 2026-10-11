import {it,expect} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Store} from "../src/store.js";
import {runReviewSync} from "../src/review/sync.js";
import {runCodeSync} from "../src/code/sync.js";

it("skips a current projection and reuses syntax while rebinding changed captured originals",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-parse-reuse-")),store=new Store(join(root,"data"));
  const path="apps/server/src/a.ts",file=join(root,path);
  mkdirSync(join(root,"apps/server/src"),{recursive:true});
  try{
    writeFileSync(file,"export function before(){ return 1; }");
    await runReviewSync(store,root);
    const first=await runCodeSync(store,root);
    expect(first.analysis).toMatchObject({parsedFiles:1,projectionReused:false});
    expect((await runCodeSync(store,root)).analysis).toMatchObject({parsedFiles:0,skippedFiles:1,projectionReused:true});
    writeFileSync(join(root,"apps/server/src/b.ts"),"export const value=2;");
    await runReviewSync(store,root,{only:["apps/server/src/b.ts"]});
    expect((await runCodeSync(store,root)).analysis).toMatchObject({parsedFiles:1,cacheHits:1,projectionReused:false});
    // Disk changes cannot replace captured evidence until Capture runs.
    writeFileSync(file,"export function after(){ return 3; }");
    expect((await runCodeSync(store,root)).snapshotId).not.toBe(first.snapshotId);
    await runReviewSync(store,root,{only:[path]});
    const changed=await runCodeSync(store,root);
    expect(changed.analysis).toMatchObject({parsedFiles:1,cacheHits:1});
    const symbol=store.db.prepare("SELECT qualified_name,fragment_id FROM code_symbols WHERE snapshot_id=? AND qualified_name='after'").get(changed.snapshotId)!;
    expect(store.evidence(String(symbol.fragment_id))!.fragment.text).toContain("function after");
    expect(store.db.prepare("SELECT parsed_json FROM code_parse_cache WHERE path=?").get(path)!.parsed_json).not.toContain("before");
    rmSync(join(root,"apps/server/src/b.ts"));await runReviewSync(store,root);await runCodeSync(store,root);
    expect(store.db.prepare("SELECT path FROM code_parse_cache ORDER BY path").all()).toEqual([{path}]);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it("rebuilds changed parser identities and resolves imports against the current file set",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-parse-version-")),store=new Store(join(root,"data"));
  mkdirSync(join(root,"apps/server/src"),{recursive:true});
  try{
    writeFileSync(join(root,"apps/server/src/a.ts"),"import {value} from './b'; export const result=value;");
    await runReviewSync(store,root);await runCodeSync(store,root);
    expect(store.db.prepare("SELECT status FROM code_edges WHERE edge_kind='imports'").get()!.status).toBe("missing");
    store.db.exec("UPDATE code_parse_cache SET parser_version='old-parser'");
    writeFileSync(join(root,"apps/server/src/b.ts"),"export const value=2;");
    await runReviewSync(store,root,{only:["apps/server/src/b.ts"]});
    const current=await runCodeSync(store,root);
    expect(current.analysis?.parsedFiles).toBe(2);
    expect(store.db.prepare("SELECT status,to_file_id FROM code_edges WHERE edge_kind='imports' AND snapshot_id=?").get(current.snapshotId)).toMatchObject({status:"confirmed",to_file_id:expect.any(String)});
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
