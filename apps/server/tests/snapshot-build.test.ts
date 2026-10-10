import {it,expect} from "vitest";
import {mkdtempSync,rmSync,existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {Store} from "../src/store.js";
import {KnowledgeRepository} from "../src/knowledge/repository.js";
import {buildResearchSnapshot} from "../src/knowledge/snapshot-build.js";

it("builds scoped evidence off the event loop and leaves the canonical library unchanged",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-background-snapshot-")),store=new Store(join(root,"data"));
  try {
    const kept=store.capture({source:"manual",externalId:"kept",title:"选中材料",parts:[{type:"text",text:"选中原文保持120元。"}]});
    store.capture({source:"manual",externalId:"hidden",title:"私人未选材料",parts:[{type:"text",text:"不应进入快照的原文。"}]});
    const repo=new KnowledgeRepository(store),materials=repo.materials();
    const heads=store.db.prepare("SELECT id,head FROM sources ORDER BY id").all();
    let ticks=0;const timer=setInterval(()=>ticks++,5);
    const file=join(root,"snapshot.sqlite");
    try {
      const timing=await buildResearchSnapshot({repository:repo,materials,articles:[],file,visible:id=>kept.revision.fragments.some(f=>f.id===id)});
      expect(ticks).toBeGreaterThan(2);expect(timing.stages.originals).toBeGreaterThan(0);
    }finally{clearInterval(timer);}
    const db=new DatabaseSync(file,{readOnly:true});
    try {
      expect(db.prepare("SELECT namespace FROM sources").all()).toHaveLength(1);
      expect(db.prepare("SELECT text FROM fragments").all()).toEqual([{text:"选中原文保持120元。"}]);
    }finally{db.close();}
    expect(store.db.prepare("SELECT id,head FROM sources ORDER BY id").all()).toEqual(heads);
    expect(store.db.prepare("SELECT count(*) n FROM sources").get()!.n).toBe(2);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it("rejects an obsolete fixed input before worker export instead of reviving a removed original",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-stale-snapshot-")),store=new Store(join(root,"data"));
  try {
    const capture=(text:string)=>store.capture({source:"file",externalId:"mutable",title:"mutable.ts",context:{filePath:"mutable.ts"},parts:[{type:"text",text}]});
    capture("export const cost=120;");const repo=new KnowledgeRepository(store),materials=repo.materials();
    capture("export const cost=240;");
    const file=join(root,"rejected.sqlite");
    await expect(buildResearchSnapshot({repository:repo,materials,articles:[],file})).rejects.toThrow("KNOWLEDGE_INPUT_CHANGED");
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(root,"data/omem.sqlite")).length).toBeGreaterThan(0);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
