/** Real configured request interpreter plus actual governed writes. Main-model
 * candidates are controlled fixtures so deliberate bad candidates are tested. */
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {Store} from "../apps/server/src/store.js";
import {MemoryService} from "../apps/server/src/memory/service.js";
import {AssistantRuntime,type AssistantCreateTaskCall,type AssistantUpdateTaskCall} from "../apps/server/src/assistant/runtime.js";
import {configuredRequestInterpreter} from "../apps/server/src/assistant/request-interpretation.js";
import {profileSchema} from "../packages/contracts/src/index.js";
import {loadReviewCodeModelConfig} from "../apps/server/src/review/model-config.js";
const model=loadReviewCodeModelConfig(),directory=resolve(".repo-review/runtime/task-interpretation");
mkdirSync(directory,{recursive:true});
const profile=profileSchema.parse({id:"traex",name:"事项交办验收",transport:model.transport,command:model.command,args:model.args,model:model.model,effort:model.effort,
  idleTimeoutMs:model.idleTimeoutMs,timeoutMs:model.timeoutMs,maxDurationMs:model.maxDurationMs});
const temporary=mkdtempSync(join(tmpdir(),"omem-live-task-intent-")),store=new Store(temporary);
let candidate:AssistantCreateTaskCall|AssistantUpdateTaskCall|undefined;
const judge=configuredRequestInterpreter({profile:()=>profile,directory});
const decisions:unknown[]=[];
const runtime=new AssistantRuntime(store,{async generate(){return {answer:"fixture candidate",citationIds:[],toolCalls:candidate?[candidate]:[]};}},
  {memory:new MemoryService(store),timezone:"Asia/Shanghai",turnTimeoutMs:profile.idleTimeoutMs ?? 480000,interpretRequest:async input=>{const r=await judge(input);decisions.push({candidate:input.candidate,result:r});return r;}});
const report={at:new Date().toISOString(),commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),model:profile.model,
  scope:"Real independent interpreter and actual MemoryService writes; controlled candidate fixtures, not full main-agent acceptance",cases:[] as unknown[],passed:false};
const save=()=>writeFileSync(join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");
const open=(chatId:string)=>runtime.conversations.open({principalId:"owner",channel:"web",chatId,visibility:"private"});
const create=(title="买牛奶"):AssistantCreateTaskCall=>({tool:"create_task",title,detail:"日常购物",dueAt:null,dueExpression:null});
async function run(text:string,call:AssistantCreateTaskCall|AssistantUpdateTaskCall,expected:"execute"|"decline"|"uncertain",conversationId=open(text).id) {
  candidate=call;const before=store.tasks().map(t=>({id:t.id,version:t.version,status:t.status})),start=performance.now(),index=decisions.length;
  const result=await runtime.turn({conversationId,userText:text});
  const after=store.tasks().map(t=>({id:t.id,version:t.version,status:t.status}));
  const decision=decisions[index] as {result:{verdict:string}}|undefined;
  report.cases.push({text,candidate:call,expected,decision,toolActions:result.turn.toolActions,before,after,elapsedMs:Math.round(performance.now()-start)});save();
  assert.equal(result.turn.inputMessageRefs.status,"done");assert.equal(decision?.result.verdict,expected,text);
  if(expected==="execute") assert.notDeepEqual(after,before,text);else assert.deepEqual(after,before,text);
  console.log("PASS",expected,text);return result;
}
try {
  const original=open("first-task");
  await run("能帮我建个买牛奶的待办吗？",create(),"execute",original.id);
  const task=store.tasks()[0]!;
  const update=(action:AssistantUpdateTaskCall["action"]):AssistantUpdateTaskCall=>({tool:"update_task",taskId:String(task.id),expectedVersion:Number(store.tasks().find(t=>t.id===task.id)!.version),action});
  await run("不要提醒我买牛奶。",create(),"decline");
  await run("买牛奶的待办要怎么建？",create(),"decline");
  await run("帮我记个买牛奶的待办，不要买咖啡。",create("买咖啡"),"decline");
  await run("买牛奶还没办好，不要标为完成。",update("complete"),"decline");
  await run("能把报销材料那条待办标为完成吗？",update("complete"),"decline");
  await run("帮我把这个任务标为完成。",update("complete"),"uncertain");
  await run("能把刚才那条待办标为完成吗？",update("complete"),"execute",original.id);
  await run("Please reopen the 买牛奶 task; it is not finished.",update("reopen"),"execute");
  await run("能把买牛奶改到2026年10月10日上午10点吗？",{...update("reschedule"),dueAt:"2026-10-10T10:00:00+08:00",dueExpression:"2026年10月10日上午10点"},"execute");
  assert.equal(store.tasks()[0]!.dueAt,"2026-10-10T02:00:00.000Z");
  report.passed=true;
} finally {save();runtime.shutdown();store.close();rmSync(temporary,{recursive:true,force:true});}
