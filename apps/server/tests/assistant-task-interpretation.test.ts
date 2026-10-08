import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {Store} from "../src/store.js";
import {MemoryService} from "../src/memory/service.js";
import {AssistantRuntime,type AssistantModelReply} from "../src/assistant/runtime.js";
import type {RequestInterpreter,RequestInterpretationInput} from "../src/assistant/request-interpretation.js";
const resources:{dir:string;store:Store;runtime:AssistantRuntime}[]=[];
afterEach(()=>{for(const r of resources.splice(0)){r.runtime.shutdown();r.store.close();rmSync(r.dir,{recursive:true,force:true});}});
function setup(interpretRequest?:RequestInterpreter) {
  const dir=mkdtempSync(join(tmpdir(),"omem-task-interpretation-")),store=new Store(dir);
  let reply:AssistantModelReply={answer:"模型声称已经执行",citationIds:[],toolCalls:[{tool:"create_task",title:"买牛奶",detail:"日常购物"}]};
  const runtime=new AssistantRuntime(store,{async generate(){return reply;}},{memory:new MemoryService(store),interpretRequest});
  resources.push({dir,store,runtime});
  const c=runtime.conversations.open({principalId:"owner",channel:"web",chatId:"test",visibility:"private"});
  return {store,runtime,c,setReply:(r:AssistantModelReply)=>{reply=r;},turn:(userText:string)=>runtime.turn({conversationId:c.id,userText})};
}
const approve:RequestInterpreter=async({actor})=>({verdict:"execute",instruction:actor.userText,targetBasis:"current_request",targetQuote:actor.userText,reason:"controlled verdict"});
it("unavailable, uncertain and ungrounded interpretation leave no task or captured instruction",async()=>{
  for(const interpreter of [undefined,async()=>{throw Error("model offline");},async({actor}:RequestInterpretationInput)=>({verdict:"uncertain" as const,instruction:actor.userText,targetBasis:"unresolved" as const,targetQuote:null,reason:"对象未知"}),async({actor}:RequestInterpretationInput)=>({verdict:"execute" as const,instruction:actor.userText,targetBasis:"prior_action" as const,targetQuote:null,reason:"猜测上一个任务"})]) {
    const s=setup(interpreter),r=await s.turn("能帮我建个买牛奶的待办吗？");
    expect(s.store.tasks()).toHaveLength(0);
    expect(s.store.db.prepare("SELECT count(*) n FROM sources").get()!.n).toBe(0);
    expect(r.turn.result).toContain("未创建任务");
    expect(r.turn.result).not.toContain("已经执行");
  }
});
it("preserves full originals and the exact instruction selector, skips judging read-only and replayed turns, and binds updates to saved receipts",async()=>{
  const seen:RequestInterpretationInput[]=[];
  const judge:RequestInterpreter=vi.fn(async input=>{seen.push(input);const full=input.actor.userText;
    if(input.priorTaskId)return {verdict:"execute",instruction:full,targetBasis:"prior_action",targetQuote:null,reason:"延续实际回执"};
    const quote="帮我建个买牛奶的待办吧";
    return {verdict:"execute",instruction:quote,targetBasis:"current_request",targetQuote:quote,reason:"当前原话明确交办"};
  });
  const s=setup(judge),original="背景说明。".repeat(600)+"帮我建个买牛奶的待办吧";
  const first=await s.runtime.turn({conversationId:s.c.id,userText:original,transportEventId:"one-event"});
  const task=s.store.tasks()[0]!;
  expect(s.store.evidence(String(task.evidenceId))!.revision.parts[0]).toEqual({type:"text",text:original});
  await s.runtime.turn({conversationId:s.c.id,userText:original,transportEventId:"one-event"});
  expect(judge).toHaveBeenCalledTimes(1);
  s.setReply({answer:"已查到",citationIds:[]});await s.turn("有什么待办？");
  expect(judge).toHaveBeenCalledTimes(1);
  s.setReply({answer:"完成了",citationIds:[],toolCalls:[{tool:"update_task",taskId:String(task.id),expectedVersion:Number(task.version),action:"complete"}]});
  await s.turn("能把刚才那条标为完成吗？");
  expect(seen[1]?.priorTaskId).toBe(task.id);
  expect(s.store.tasks()[0]!.status).toBe("done");
});
it("late interpretation after cancellation cannot capture or apply a task",async()=>{
  let release!:(value:Awaited<ReturnType<RequestInterpreter>>)=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});
  const s=setup(async()=>{entered();return new Promise(r=>{release=r;});});
  const controller=new AbortController();
  const result=s.runtime.turn({conversationId:s.c.id,userText:"帮我买牛奶",signal:controller.signal});
  await ready;controller.abort();
  release(await approve({actor:{requestId:"fixture",conversationId:s.c.id,principalId:"owner",visibility:"private",userText:"帮我买牛奶"},candidate:null,target:null}));
  await result;
  expect(s.store.tasks()).toHaveLength(0);
  expect(s.store.db.prepare("SELECT count(*) n FROM sources").get()!.n).toBe(0);
});
