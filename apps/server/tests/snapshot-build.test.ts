import {it,expect} from "vitest";
import {mkdtempSync,rmSync,existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {Store} from "../src/store.js";
import {KnowledgeRepository} from "../src/knowledge/repository.js";
import {buildResearchSnapshot} from "../src/knowledge/snapshot-build.js";

it("coalesces overlapping identical builds into independent files, with independent cancellation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-coalesced-snapshot-")),store=new Store(join(root,"data"));
  try{
    store.capture({source:"manual",externalId:"fixed",title:"原件",parts:[{type:"text",text:"原件保持120元。"}]});
    store.capture({source:"manual",externalId:"second",title:"另一原件",parts:[{type:"text",text:"这一份保持240元。"}]});
    const repo=new KnowledgeRepository(store),materials=repo.materials(),controller=new AbortController();
    const a=join(root,"a.sqlite"),b=join(root,"b.sqlite"),c=join(root,"c.sqlite");
    const first=buildResearchSnapshot({repository:repo,materials,articles:[],file:a});
    const second=buildResearchSnapshot({repository:repo,materials:[...materials].reverse(),articles:[],file:b});
    const canceled=buildResearchSnapshot({repository:repo,materials,articles:[],file:c,signal:controller.signal});
    const rejected=expect(canceled).rejects.toThrow("reader canceled");
    controller.abort(Error("reader canceled"));
    const [one,two]=await Promise.all([first,second]);await rejected;
    expect(one.buildId).toBe(two.buildId);expect(one.coalesced).toBe(false);expect(two.coalesced).toBe(true);
    expect(readFileSync(a)).toEqual(readFileSync(b));expect(existsSync(c)).toBe(false);
    rmSync(a);expect(existsSync(b)).toBe(true);
    const later=await buildResearchSnapshot({repository:repo,materials,articles:[],file:join(root,"later.sqlite")});
    expect(later.buildId).not.toBe(one.buildId);expect(later.coalesced).toBe(false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it("separates visibility scopes and source database generations",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-snapshot-scope-")),store=new Store(join(root,"data"));
  try{
    const original=store.capture({source:"manual",externalId:"fixed",title:"原件",parts:[{type:"text",text:"限定范围的原文。"}]});
    const repo=new KnowledgeRepository(store),materials=repo.materials();
    const first=buildResearchSnapshot({repository:repo,materials,articles:[],file:join(root,"first.sqlite"),visible:()=>false});
    const second=buildResearchSnapshot({repository:repo,materials,articles:[],file:join(root,"second.sqlite"),visible:id=>original.revision.fragments.some(f=>f.id===id)});
    store.capture({source:"manual",externalId:"another",title:"新状态",parts:[{type:"text",text:"此后捕获的状态。"}]});
    const third=buildResearchSnapshot({repository:repo,materials,articles:[],file:join(root,"third.sqlite"),visible:()=>false});
    const results=await Promise.all([first,second,third]);
    expect(new Set(results.map(r=>r.buildId)).size).toBe(3);
    const db=new DatabaseSync(join(root,"first.sqlite"),{readOnly:true});
    try{expect(db.prepare("SELECT count(*) n FROM fragments").get()!.n).toBe(0);}finally{db.close();}
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

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
