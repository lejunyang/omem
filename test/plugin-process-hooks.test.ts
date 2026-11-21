import { expect, it } from "vitest";
import { z } from "zod";
import { manifestSchema } from "../src/plugins/registry.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";

it("checks every process capability against its declaration", () => {
  const api = registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", permissions: { events: ["item.status"] } }), []);
  expect(() => api.flowSignal({id:"mark",name:"标记",describe:"读标记",async check(){return {done:false};}})).toThrow("permissions.flow.signal");
  expect(() => api.stageRunner({id:"job",name:"作业",describe:"写文件",async start(){return {ref:"job",status:"done"};}})).toThrow("permissions.flow.run");
  expect(() => api.stageGate({id:"check",name:"检查",describe:"核对结果",async review(){return {ok:true};}})).toThrow("permissions.flow.gate");
  expect(() => api.subscribe({ id: "facts", events: ["item.created"], async handle() {} })).toThrow("permissions.events");
  expect(() => api.reviewProvider({ id:"review", label:"评审", objectKind:"pr", async publish() { throw Error(); }, async readThread() { return {state:"open"}; } })).toThrow("permissions.reviewProvider");
  expect(() => api.itemProvider({ id: "items", label: "事项", statuses: {}, async pull() { return { items: [], done: true }; } })).toThrow("permissions.itemProvider");
  expect(() => api.retriever({ id: "demo", label: "示例", async search() { return []; } })).toThrow("permissions.retriever");
  expect(() => api.reranker({ id: "demo", label: "示例", async score() { return []; } })).toThrow("permissions.reranker");
  expect(() => api.metricProvider({ id: "count", label: "计数", querySchema: z.object({}), async collect() { return []; } })).toThrow("permissions.metricProvider");
});
