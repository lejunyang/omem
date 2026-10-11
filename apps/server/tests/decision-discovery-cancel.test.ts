import {afterEach,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({exec:vi.fn(),spawn:vi.fn()}));
vi.mock("node:child_process",async()=>{
  const actual=await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const execFile=Object.assign(vi.fn(),{[Symbol.for("nodejs.util.promisify.custom")]:mocks.exec});
  return {...actual,execFile,spawn:mocks.spawn};
});
vi.mock("../src/paths.js",()=>({optionalRuntime:()=>"/fixture/runtime",pythonInVenv:()=>"/fixture/python",modelWorkspace:()=>"/fixture",assetPath:()=>"/fixture/worker.py"}));
vi.mock("node:fs",async()=>{
  const actual=await vi.importActual<typeof import("node:fs")>("node:fs");
  return {...actual,existsSync:(p:unknown)=>String(p).startsWith("/fixture/")||actual.existsSync(p as string)};
});
import {DecisionService} from "../src/decision/service.js";
const questions={useful:{type:"choice" as const,instructions:"有用吗？",criteria:{yes:"有用",no:"无关"}}};
const installed={stdout:JSON.stringify({model:{snapshot_path:"/fixture/model",revision:"fixture"}})};
afterEach(()=>vi.clearAllMocks());

it("does not spawn a worker when canceled during the last discovery query",async()=>{
  const controller=new AbortController(),service=new DecisionService({mode:"0.8b",timeoutMs:0});
  mocks.exec.mockImplementationOnce(async(_cmd,_args,options)=>{
    expect(options.signal).toBe(controller.signal);
    controller.abort(Error("cancel discovery"));
    return installed;
  });
  try{
    await expect(service.decide({},questions,{signal:controller.signal})).rejects.toThrow("cancel discovery");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(service.status().status).toBe("idle");
  }finally{await service.close();}
});

it("does not spawn a worker after close while discovery is pending",async()=>{
  const service=new DecisionService({mode:"0.8b",timeoutMs:0});
  let release!:()=>void,started!:()=>void;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  mocks.exec.mockImplementationOnce(async()=>{started();await new Promise<void>(resolve=>{release=resolve;});return installed;});
  const task=service.decide({},questions);await begun;
  const closing=service.close();release();
  expect(await task).toBeNull();await closing;
  expect(mocks.spawn).not.toHaveBeenCalled();
});
