import { describe, expect, it } from "vitest";
import { decide, fingerprint } from "../src/agents/operation-policy.ts";
import type { Operation } from "../src/agents/operation-policy.ts";
import { operationRuleSchema, type OperationRule } from "../src/core/config.ts";
import type { App } from "../src/core/app.ts";
const who = {member:"a",role:"worker",space:"project",backend:"local"};
const rule = (match:OperationRule["match"]): OperationRule => ({id:"guard",revision:1,enabled:true,action:"deny",match});
const run = (op: Operation, ...rules: OperationRule[]) => decide({config:{security:{operationRules:rules,commandRules:[]}}} as unknown as App,op,who);
describe("operation rules", () => {
  it("combines command and scope conditions before selecting the first rule", () => {
    const op: Operation = {kind:"command",executable:"acme",argv:["-q","mr","create","abc"],cwd:"/project"};
    const r = rule({kind:"command",executable:"acme",subcommand:["mr","create"],argv:[{index:3,regex:"^abc$"}],argsRegex:"^-q"});
    for (const key of ["members","roles","spaces","backends"]) expect(run(op,{...r,scope:{[key]:["other"]}}).rule).toBeUndefined();
    expect(run(op,r,{...r,action:"allow"}).action).toBe("deny");
    expect(fingerprint(op,r)).not.toBe(fingerprint({...op,cwd:"/other"},r));
  });
  it.each([
    { argv: ["mr", "show", "id"], possible: true, certain: true },
    { argv: ["--site=cn", "mr", "show"], possible: true, certain: true },
    { argv: ["--site", "cn", "mr", "show"], possible: true, certain: false },
    { argv: ["-q", "mr", "show"], possible: true, certain: false },
    { argv: ["--site", "mr", "show", "edit"], possible: true, certain: false },
    { argv: ["--site", "cn", "mr", "-p", "prod", "show"], possible: true, certain: false },
    { argv: ["-q", "mr", "--site", "cn", "show"], possible: true, certain: false },
    { argv: ["mr", "-q", "show", "show"], possible: true, certain: true },
    { argv: ["mr", "--", "show"], possible: true, certain: true },
    { argv: ["--", "--site", "mr", "show"], possible: false, certain: false },
    { argv: ["--site=cn", "other", "mr", "show"], possible: false, certain: false },
    { argv: ["--site", "cn", "other", "mr", "show"], possible: false, certain: false },
  ])("matches command prefixes according to the rule action for $argv", ({ argv, possible, certain }) => {
    const op: Operation = { kind: "command", executable: "acme", argv };
    const r = rule({ kind: "command", executable: "acme", subcommand: ["mr", "show"] });
    for (const action of ["deny", "approve", "allow", "log"] as const) {
      const match = run(op, { ...r, action }).rule;
      expect(!!match).toBe(action === "allow" ? certain : possible);
    }
  });
  it("continues past an ambiguous read exception and checks the original argv for approval", () => {
    const op: Operation = { kind: "command", executable: "acme", argv: ["--site", "show", "edit"] };
    const read = rule({ kind: "command", executable: "acme", subcommand: ["show"] });
    const edit = rule({ kind: "command", executable: "acme", subcommand: ["edit"],
      argv: [{ index: 1, regex: "^show$" }], argsRegex: "^--site show edit$" });
    expect(run(op, { ...read, action: "allow" }, { ...edit, action: "approve" }).action).toBe("approve");
    expect(run({ ...op, argv: ["--site", "other", "edit"] }, edit).rule).toBeUndefined();
  });
  it("matches normalized URLs, JSON fields and file operations", () => {
    expect(run({kind:"http",method:"post",url:"https://a.example.com/old/../new",body:{x:1}},rule({kind:"http",methods:["POST"],host:"*.example.com",pathRegex:"^/new$",body:{jsonPath:"$.x",regex:"1"}})).action).toBe("deny");
    expect(run({kind:"file",operation:"write",path:"/sample"},rule({kind:"file",operations:["write"],pathRegex:"sample$"})).action).toBe("deny");
    expect(run({kind:"tool",name:"sample",args:{x:["yes"]}},rule({kind:"tool",name:"sample",args:[{jsonPath:"$.x[0]",regex:"^yes$"}]})).action).toBe("deny");
  });
  it("rejects malformed patterns and denies operations exceeding the regex budget", () => {
    expect(operationRuleSchema.safeParse(rule({kind:"command",executable:"acme",argsRegex:"("})).success).toBe(false);
    const r = {...rule({kind:"command",executable:"acme",argsRegex:"^(a+)+$"}),action:"allow" as const};
    for (const n of [100,100000]) expect(run({kind:"command",executable:"acme",argv:["a".repeat(n)+"!"]},r).action).toBe("deny");
  });
});
