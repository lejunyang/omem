import { expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { prepareAgentResearch } from "../src/knowledge/agent-research.js";
import { prepareAssistantResearch } from "../src/assistant/research.js";
import { answerInvestigation, answerReviewEvidence } from "../src/assistant/answer-review.js";
import { answerReviewSchema } from "../../../packages/contracts/src/assistant.js";
import { RoleBundleRegistry } from "../src/agent-runtime/bundles.js";

it("prefills exact frozen citation bytes without substituting a newer revision or an unoffered source", () => {
  const root = mkdtempSync(join(tmpdir(), "omem-review-excerpts-"));
  const store = new Store(root);
  try {
    store.capture({ source: "manual", externalId: "contract", title: "约定", parts: [{type:"text",text:"配送只在周五。\n中午前登记才生效。"}], context: {} });
    const repository = new KnowledgeRepository(store), material = repository.materials()[0]!;
    store.capture({ source: "manual", externalId: "contract", title: "约定", parts: [{type:"text",text:"新约定：周一配送。"}], context: {} });
    const citations = [
      {id:"cite_1",key:material.key,startLine:2,endLine:2},
      {id:"cite_2",key:material.key,revision:"another-version",startLine:1,endLine:1},
      {id:"cite_3",key:"manual:hidden",startLine:1,endLine:1},
    ];
    const result = answerReviewEvidence({answer:"周五可以配送。",citations}, {file:"unused",materials:[material],articles:[]});
    expect(result[0]).toMatchObject({revision:material.revisionId,digest:material.digest,lines:[{line:2,text:"中午前登记才生效。"}]});
    expect(result[1]).toMatchObject({revision:"another-version",lines:null});
    expect(result[2]?.lines).toBeNull();
    expect(JSON.stringify(result)).not.toContain("周一配送");
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});

it("lets an independent reader inspect the same frozen originals and returns an actionable omission before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-answer-review-"));
  const store = new Store(join(root, "data"));
  const repository = new KnowledgeRepository(store);
  const capture = (text: string) =>
    store.capture({
      source: "manual",
      externalId: "delivery",
      title: "配送约定",
      parts: [{ type: "text", text }],
      context: {},
    });
  capture("只有周五中午前登记的订单参加当天配送。逾期顺延到下周。");
  const material = repository.materials()[0]!;
  const workspace = join(root, "author");
  const clients: Client[] = [];
  const environments: Awaited<ReturnType<typeof prepareAgentResearch>>[] = [];
  const connect = async (
    env: Awaited<ReturnType<typeof prepareAgentResearch>>,
  ) => {
    environments.push(env);
    const client = new Client({ name: "answer-check", version: "1" });
    clients.push(client);
    const server = env.servers[0]!;
    if (server.type !== "http") throw Error("HTTP expected");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    return (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
  };
  try {
    new RoleBundleRegistry().load("answer-reviewer");
    let calls = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const investigation = answerInvestigation({
      workspace,
      review: async (_draft, snapshot, signal, publish, focus) => {
        expect(focus).toEqual(["登记或地址还有哪些未确认且会影响行动的前提？"]);
        calls++;
        await waiting;
        capture("规则已经变更：周一配送。");
        const reader = await prepareAgentResearch({
          repository,
          ...snapshot,
          snapshot,
          workspace: join(root, "reader"),
          schema: answerReviewSchema,
          validate: (x) => answerReviewSchema.parse(x),
          onSubmitted: (x) => publish(answerReviewSchema.parse(x)),
          retrievalConfig: { enabled: false },
        });
        expect(reader.tools).not.toContain("review_answer");
        const read = await connect(reader);
        const body = await read("read_material", { key: material.key });
        expect(JSON.stringify(body)).toContain("周五中午前");
        expect(JSON.stringify(body)).not.toContain("周一配送");
        const result = {
          summary: "遗漏登记截止时间",
          issues: [
            {
              problem: "不是周五登记就能当天配送",
              whyItMatters: "用户可能下午下单仍以为当天送达",
              suggestion: "说明中午前登记的条件",
              sources: [
                { id: "cite_1", key: material.key, startLine: 1, endLine: 1 },
              ],
            },
          ],
        };
        await read("submit_result", { result });
        // The CLI can continue its closing message after submitting. Its
        // validated report must already be readable; cancellation must not
        // reclassify that report as a failed review.
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return answerReviewSchema.parse(reader.result());
      },
    });
    const env = await prepareAssistantResearch({
      repository,
      workspace,
      tools: investigation.tools,
      beforeSubmit: investigation.beforeSubmit,
      retrievalConfig: { enabled: false },
      context: {
        userText: "周五登记就会当天配送吗？",
        priorTurns: [],
        evidence: [],
        visibility: "private",
        mode: "research",
      },
    });
    const call = await connect(env);
    const draft = {
      answer: "周五登记当天配送。",
      citations: [
        { id: "cite_1", key: material.key, startLine: 1, endLine: 1 },
      ],
    };
    const submit = (answer: string, review_resolutions?: import("../../../packages/contracts/src/assistant.js").AssistantReply["review_resolutions"]) =>
      call("submit_result", {
        result: { ...draft, answer, review_resolutions, create_task: null, update_task: null },
      });
    await call("investigation_notes", {
      notes: "已找到配送日；需要核对登记截止时间。",
      reviewRequired: true,
    });
    expect((await submit(draft.answer)).isError).toBe(true);
    expect(env.result()).toBeUndefined();
    expect((await call("review_answer", { draft })).isError).toBe(true);
    expect(calls).toBe(0);
    const review = await call("review_answer", { draft, focus: ["登记或地址还有哪些未确认且会影响行动的前提？"] });
    const payload = (result: any) => JSON.parse(result.content[0].text);
    const started = payload(review);
    expect(started.status).toBe("running");
    const again = payload(await call("review_answer", { draft, focus: ["登记或地址还有哪些未确认且会影响行动的前提？"] }));
    expect(again.reviewId).toBe(started.reviewId);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(workspace, "answer-review.json"), "utf8")).focus).toHaveLength(1);
    expect(JSON.stringify(await submit(draft.answer))).toContain(
      "read_answer_review",
    );
    expect(
      payload(
        await call("read_answer_review", {
          reviewId: started.reviewId,
          waitSeconds: 0,
        }),
      ).status,
    ).toBe("running");
    release();
    const completed = payload(
      await call("read_answer_review", { reviewId: started.reviewId }),
    );
    expect(completed.status).toBe("completed");
    expect(JSON.parse(readFileSync(join(workspace, "answer-review.json"), "utf8")).retrieved).toBe(true);
    expect(JSON.stringify(completed.report)).toContain("中午前");
    expect(
      payload(await call("read_answer_review", { reviewId: started.reviewId }))
        .report,
    ).toEqual(completed.report);
    expect((await submit(draft.answer)).isError).toBe(true);
    const finalQuote="根据本次保存的约定，周五中午前登记才会当天配送；逾期顺延下周。[[cite_1]]";
    expect((await submit(finalQuote)).isError).toBe(true);
    expect(
      (
        await submit(
          finalQuote,[{issueId:completed.report.issues[0].issueId,finalQuote,basisCitationIds:["cite_1"],unresolvedReason:null}],
        )
      ).isError,
    ).not.toBe(true);
    expect(JSON.parse(readFileSync(join(workspace,"answer-review-resolution.json"),"utf8")).resolutions[0].status).toBe("unverified");
    expect(calls).toBe(1);
    expect(
      readFileSync(join(workspace, "answer-review.json"), "utf8"),
    ).toContain("登记截止时间");
    await investigation.close();
    expect(
      payload(
        await call("read_answer_review", {
          reviewId: started.reviewId,
          waitSeconds: 0,
        }),
      ).status,
    ).toBe("completed");
  } finally {
    for (const c of clients.reverse()) await c.close();
    for (const e of environments.reverse()) await e.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains failures without an implicit second model call and cancels the owned review on close", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omem-answer-review-cancel-"));
  let calls = 0;
  let cancelled = false;
  const investigation = answerInvestigation({
    workspace,
    review: async (_draft, _snapshot, signal) => {
      if (++calls === 1) throw Error("Agent connection closed");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      throw Error("unreachable");
    },
  });
  const start = investigation.tools.find((t) => t.name === "review_answer")!;
  const read = investigation.tools.find(
    (t) => t.name === "read_answer_review",
  )!;
  const snapshot = {} as Parameters<typeof start.run>[1];
  const draft = { answer: "需要核对", citations: [] };
  try {
    const first: any = await start.run({ draft, focus: ["登记或地址还有哪些未确认且会影响行动的前提？"] }, snapshot);
    const failed: any = await read.run(
      { reviewId: first.reviewId, waitSeconds: 20 },
      snapshot,
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: "Agent connection closed",
    });
    expect(await start.run({ draft, focus: ["登记或地址还有哪些未确认且会影响行动的前提？"] }, snapshot)).toMatchObject({
      reviewId: first.reviewId,
      status: "failed",
    });
    expect(calls).toBe(1);
    expect(() => investigation.beforeSubmit("最终答案")).toThrow();
    const retry: any = await start.run({ draft, focus: ["登记或地址还有哪些未确认且会影响行动的前提？"], retry: true }, snapshot);
    expect(retry.reviewId).not.toBe(first.reviewId);
    await investigation.close();
    expect(cancelled).toBe(true);
    expect(
      await read.run({ reviewId: retry.reviewId, waitSeconds: 0 }, snapshot),
    ).toMatchObject({ status: "cancelled" });
    expect(() => investigation.beforeSubmit("最终答案")).toThrow();
  } finally {
    await investigation.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it("keeps prior issues across focused checks and distinguishes mapping from independent clearance",async()=>{
  const workspace=mkdtempSync(join(tmpdir(),"omem-answer-closure-"));
  const cite={id:"cite_1",key:"manual:rule",startLine:1,endLine:1};let calls=0;
  const scopes:unknown[]=[];
  const investigation=answerInvestigation({workspace,review:async(_draft,_snapshot,_signal,_publish,_focus,scope)=>{scopes.push(scope);return ++calls===1?{summary:"缺条件",issues:[{problem:"缺登记条件",whyItMatters:"影响操作",suggestion:"补齐条件",sources:[cite]}]}:{summary:"对应段落未发现问题",issues:[]};}});
  const start=investigation.tools.find(t=>t.name==="review_answer")!,read=investigation.tools.find(t=>t.name==="read_answer_review")!,snapshot={} as Parameters<typeof start.run>[1];
  try{
    const initial:any=await start.run({draft:{answer:"当天配送",citations:[cite]},focus:["登记条件是什么？"]},snapshot);
    const feedback:any=await read.run({reviewId:initial.reviewId,waitSeconds:20},snapshot),issueId=feedback.report.issues[0].issueId;
    const answer="中午前登记当天配送。[[cite_1]]",records=[{issueId,finalQuote:answer,basisCitationIds:["cite_1"],unresolvedReason:null}];
    const reply={answer,citations:[cite],create_task:null,update_task:null,review_resolutions:records};
    expect(()=>investigation.beforeSubmit(answer,{...reply,review_resolutions:[]})).toThrow("review_resolutions");
    expect(()=>investigation.beforeSubmit(answer,{...reply,review_resolutions:[{...records[0]!,finalQuote:"不存在的段落"}]})).toThrow("actual final answer");
    investigation.beforeSubmit(answer,reply);
    expect(JSON.parse(readFileSync(join(workspace,"answer-review-resolution.json"),"utf8")).resolutions[0].status).toBe("unverified");
    const checking:any=await start.run({draft:{answer,citations:[cite]},focus:["仅核对登记前提"],issueIds:[issueId]},snapshot);
    await read.run({reviewId:checking.reviewId,waitSeconds:20},snapshot);
    expect(()=>investigation.beforeSubmit(answer,{...reply,review_resolutions:[]})).toThrow("review_resolutions");
    investigation.beforeSubmit(answer,reply);
    const saved=JSON.parse(readFileSync(join(workspace,"answer-review-resolution.json"),"utf8"));
    expect(saved.resolutions[0]).toMatchObject({status:"no_issue_found",checkedBy:checking.reviewId,start:0,end:answer.length});
    expect(scopes).toEqual([{mode:"answer"},{mode:"correction",issues:[{issueId,problem:"缺登记条件",whyItMatters:"影响操作"}]}]);
    expect((await read.run({reviewId:initial.reviewId,waitSeconds:0},snapshot) as any).report.issues[0].issueId).toBe(issueId);
  }finally{await investigation.close();rmSync(workspace,{recursive:true,force:true});}
});
