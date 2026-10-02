import {taskFlag} from "./task-args.js";
import {loadChineseReranker} from "../apps/server/src/retrieval/reranker.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Store } from "../apps/server/src/store.js";
import { loadChineseEmbedding } from "../apps/server/src/retrieval/embedding.js";
import { UnifiedRetrieval } from "../apps/server/src/retrieval/unified.js";
import { captureSchema } from "../packages/contracts/src/index.js";
const dir = mkdtempSync(join(tmpdir(),"omem-semantic-")), store = new Store(dir);
const retrieval = new UnifiedRetrieval(store.db, () => loadChineseEmbedding(), taskFlag("reranker") ? ()=>loadChineseReranker() : undefined);
const cases = [
  { title: "诊疗安排", text: "周四上午十点去口腔门诊拔智齿，提前半小时到医院取号。", query: "我哪天去看牙医？" },
  { title: "故障处理", text: "当下游连续失败时打开熔断器，短暂等待后放行少量请求探测恢复情况。", query: "依赖服务挂了怎么避免一直重试？" },
  { title: "语言学习", text: "每天听一段英文播客，把不认识的单词做成记忆卡，并按遗忘曲线安排复习。", query: "如何巩固外语词汇？" },
  { title: "出差材料", text: "去上海的高铁电子票和住宿发票已收齐，周五提交财务报销。", query: "旅途花销的凭证要交给谁？" },
];
const ids: string[] = [];
try {
  for (const c of cases) ids.push(store.capture(captureSchema.parse({ source: "manual", title: c.title, externalId: c.title, parts: [{ type: "text", text: c.text }] })).revision.fragments[0]!.id);
  while (await retrieval.indexBatch()) {}
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const lexical = retrieval.searchSources({ text: c.query, limit: 1 });
    const hits = await retrieval.searchSourcesAsync({ text: c.query, limit: 3 });
    assert.equal(hits[0]?.fragmentId,ids[i],c.query);
    assert.ok(hits[0]?.routes?.includes("semantic"));
    results.push({ query: c.query, expected: c.title, top1: hits[0]?.snippet, lexicalTop1Correct: lexical[0]?.fragmentId === ids[i], routes: hits[0]?.routes });
  }
  const excluded = await retrieval.searchSourcesAsync({ text: cases[0]!.query, visible: id => id !== ids[0] });
  assert.ok(excluded.every(h => h.fragmentId !== ids[0]));
  assert.deepEqual(await retrieval.searchSourcesAsync({ text: "zyxq_unknown_824719" }), [], "absent identifiers must not produce semantic guesses");
  const report = { passed: true, health: retrieval.health(), cases: results };
  mkdirSync(resolve(".omem/verification"),{recursive:true}); writeFileSync(resolve(".omem/verification/live-retrieval.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally { await retrieval.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
