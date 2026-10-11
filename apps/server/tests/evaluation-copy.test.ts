import {expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {copyEvaluationLibrary} from "../../../scripts/evaluation-copy.js";

it("keeps one WAL snapshot when a writer commits during evaluation backup",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-evaluation-copy-")),source=join(root,"omem.sqlite");
  const writer=new DatabaseSync(source);
  try{
    writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE notes(value TEXT,padding BLOB);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO notes SELECT 'before',zeroblob(2048) FROM n;`);
    let changed=false;
    const result=await copyEvaluationLibrary(root,join(root,"copy"),event=>{
      if((event as {stage:string}).stage==="database-backup"&&!changed){
        writer.exec("UPDATE notes SET value='after'");changed=true;
      }
    });
    const copy=new DatabaseSync(join(root,"copy/omem.sqlite"));
    try{
      expect(changed).toBe(true);
      expect(copy.prepare("SELECT DISTINCT value FROM notes").all()).toEqual([{value:"before"}]);
      expect(writer.prepare("SELECT DISTINCT value FROM notes").all()).toEqual([{value:"after"}]);
      expect(result.progressBackwards).toBe(0);
      expect(result.callbacks).toBeGreaterThan(1);
      expect(result.lockWaitMs).toBeNull();
    }finally{copy.close();}
  }finally{writer.close();rmSync(root,{recursive:true,force:true});}
});
