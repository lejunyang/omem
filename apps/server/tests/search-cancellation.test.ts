import {it,expect} from "vitest";
import {get} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../src/store.js";
import {buildReviewApp} from "../src/review/app.js";

it("forwards a real HTTP disconnect to long search work and does not abort successful replies",async()=>{
  const root=mkdtempSync(join(tmpdir(),"omem-search-cancel-")),store=new Store(join(root,"data"));
  const {app,retrieval}=await buildReviewApp({store,repoRoot:root,retrievalConfig:{enabled:false}});
  let started!:(signal:AbortSignal)=>void,stopped!:()=>void;
  const beginning=new Promise<AbortSignal>(resolve=>{started=resolve;});
  const ending=new Promise<void>(resolve=>{stopped=resolve;});
  retrieval.searchSourcesAsync=async query=>{
    const signal=query.signal!;started(signal);
    return new Promise(resolve=>signal.addEventListener("abort",()=>{stopped();resolve([]);},{once:true}));
  };
  try{
    await app.listen({host:"127.0.0.1",port:0});
    const address=app.server.address();if(!address||typeof address==="string")throw Error("HTTP address missing");
    const url=`http://127.0.0.1:${address.port}/api/review/search?q=question`;
    const request=get(url);request.on("error",()=>{});
    const signal=await beginning;request.destroy();await ending;expect(signal.aborted).toBe(true);
    let normal:AbortSignal|undefined;
    retrieval.searchSourcesAsync=async query=>{normal=query.signal;return [];};
    const response=await fetch(url);expect(response.status).toBe(200);expect(await response.json()).toEqual([]);
    expect(normal?.aborted).toBe(false);
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
