import { expect, it } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { gateOperation } from "../src/agents/command-gate.ts";
import { saveOperationRules } from "../src/agents/operation-policy.ts";
import type { ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

function fixture() {
  const app = testApp();
  const [rule] = saveOperationRules(app,[{id:"write",revision:1,enabled:true,action:"approve",match:{kind:"command",executable:"acme"},approval:{waitSeconds:1}}]);
  run(app.db,"insert into runs(id,kind,status,title,input,created_at) values('rtest','ask','running','test','{}',?)",new Date().toISOString());
  const ctx: ToolContext = {app,runId:"rtest",spaceId:"personal",spaces:null,tools:null,actor:"agent"};
  const invoke = (cwd="/a", member="owner", argv=["write"]) => gateOperation(app,{...ctx,userId:member},{kind:"command",executable:"acme",argv,cwd});
  const ask = async () => {
    await new Promise(r => setTimeout(r,20));
    return listAsks(app,{status:"pending"})[0]!;
  };
  return {app,rule:rule!,invoke,ask};
}
it("binds a late one-shot approval to the member, directory and rule revision", async () => {
  const {app,rule,invoke,ask} = fixture();
  expect((await invoke()).decision).toBe("pending");
  await answerAsk(app,(await ask()).id,{approved:true,by:"owner",choice:0});
  const wrong = await Promise.all([invoke("/b"),invoke("/a","other")]);
  expect(wrong.map(v => v.decision)).toEqual(["pending","pending"]);
  expect((await invoke()).decision).toBe("allow");
  const again = invoke();
  const id = (await ask()).id;
  saveOperationRules(app,[{...rule,title:"changed"}]);
  await answerAsk(app,id,{approved:true,by:"owner",choice:0});
  expect((await again).decision).toBe("deny");
});
it("limits rule-wide approval to the live run and refuses wider choices for another approver", async () => {
  const {app,invoke,ask} = fixture();
  const first = invoke();
  const id = (await ask()).id;
  await expect(answerAsk(app,id,{approved:true,by:"other",choice:2})).rejects.toThrow("本人");
  await answerAsk(app,id,{approved:true,by:"owner",choice:1});
  expect((await first).decision).toBe("allow");
  expect((await invoke("/b","owner",["different"])).decision).toBe("allow");
  run(app.db,"update runs set status='done' where id='rtest'");
  expect((await invoke()).decision).toBe("pending");
});
it("persists only the approved rule and consumes competing once requests atomically", async () => {
  const {app,invoke,ask} = fixture();
  const pair = [invoke(),invoke()];
  await answerAsk(app,(await ask()).id,{approved:true,by:"owner",choice:0});
  expect((await Promise.all(pair)).map(v=>v.decision).sort()).toEqual(["allow","deny"]);
  const next = invoke();
  await answerAsk(app,(await ask()).id,{approved:true,by:"owner",choice:2});
  expect((await next).decision).toBe("allow");
  expect(app.config.security.operationRules[0]?.action).toBe("allow");
});
