export const stagePlugin = `import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const data = process.env.OMEM_PLUGIN_DATA;
      export default function(api) {
      api.stageGate({id:"word",name:"验收词",describe:"结果要写已验证",async review(ctx) {
        if (ctx.result.evidence.some(e => e.text === "验收要求")) throw Error("混入上次否决证据");
        return ctx.result.summary.includes("已验证") ? {ok:true} : {ok:false,reason:"缺少已验证",evidence:[{text:"验收要求",link:"https://example.org/rule"}]};
      }});
      api.stageGate({id:"first",name:"准备检查",describe:"只拦准备阶段",applies:{flows:["inspect"],stages:["first"]},
        async review(){ return {ok:false,reason:"准备结果需复核"}; }});
      api.stageGate({id:"slow",name:"慢检查",describe:"等待检查",review(_ctx, signal) {
        return new Promise((_,reject) => signal.addEventListener("abort",() => reject(signal.reason),{once:true}));
      }});
      api.stageRunner({ id:"job", name:"作业", describe:"写入标记", async start(ctx) {
        const ref = ctx.idempotencyKey, path = join(data,ref);
        if (!existsSync(path)) writeFileSync(path,ref,{flag:"wx"});
        return {ref,status:ctx.with.fail ? "failed" : "running",summary:"作业结果"};
      }, async check(ref){ return {ref,status:"done",summary:"已验证：作业完成",evidence:[{text:"标记"}]}; },
      async cancel(ref){writeFileSync(join(data,ref+".cancel"),"cancel");} });
      api.flowSignal({ id: "mark", name: "标记", describe: "检查通过", params: {type:"object",properties:{fail:{type:"boolean"}}},
        async check(ctx) { if (ctx.with.fail) throw Error("读取失败"); return {done:true,evidence:[{text:"检查单",link:"https://example.org/check"}]}; } });
    }`;
