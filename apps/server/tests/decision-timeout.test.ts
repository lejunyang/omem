import {it,expect,vi} from "vitest";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {DecisionService} from "../src/decision/service.js";

const questions={useful:{type:"choice" as const,instructions:"有用吗？",criteria:{yes:"有用",no:"无关"}}};
const response={answers:{useful:{choice:"yes",confidence:0.9,probabilities:{yes:0.9,no:0.1}}},elapsedMs:130_000,
  model:{alias:"fixture",size:"2b",revision:"fixture",switched:false,availableGiB:20,loadPerCpu:0},peakModelBytes:1};
function fixture(timeoutMs:number){
  const service=new DecisionService({timeoutMs});let killed=0;
  const state=service as unknown as {child:ChildProcessWithoutNullStreams;pending?:{resolve:(x:unknown)=>void}};
  state.child={stdin:{write:()=>{setTimeout(()=>state.pending?.resolve(response),130_000);return true;}},
    kill:()=>{killed++;return true;}} as unknown as ChildProcessWithoutNullStreams;
  return {service,killed:()=>killed};
}
it("allows a response beyond two minutes when explicitly unlimited, while finite requests still release their worker",async()=>{
  vi.useFakeTimers();
  try{
    for(const timeoutMs of [120_000,0]){
      const f=fixture(timeoutMs);
      try{
        const task=f.service.decide({material:"原件"},questions);
        await vi.advanceTimersByTimeAsync(130_001);
        expect(await task).toEqual(timeoutMs===0?response:null);
        expect(f.killed()).toBe(timeoutMs===0?0:1);
      }finally{await f.service.close();vi.clearAllTimers();}
    }
  }finally{vi.useRealTimers();}
});
it("cancels an unlimited running worker without waiting for its reply",async()=>{
  vi.useFakeTimers();const f=fixture(0),controller=new AbortController();
  try{
    const task=f.service.decide({material:"原件"},questions,{signal:controller.signal});
    const rejected=expect(task).rejects.toThrow("stop now");
    await vi.advanceTimersByTimeAsync(1);controller.abort(Error("stop now"));
    await rejected;expect(f.killed()).toBe(1);
    expect(f.service.status().status).toBe("idle");
  }finally{await f.service.close();vi.clearAllTimers();vi.useRealTimers();}
});
