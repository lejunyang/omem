import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { recordReview } from "../src/agents/review.ts";
import { recordPrior } from "../src/agents/rereview.ts";
import { offerReviewPublish, refreshThreads, reviewSyncView } from "../src/agents/review-sync.ts";
import { run, all } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { registerObject } from "../src/plugins/objects.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { manifestSchema } from "../src/plugins/registry.ts";
import type { ReviewProvider } from "../src/plugins/types.ts";

let app: ReturnType<typeof testApp>, id: string, item: string;
let undo: (() => void)[];
const publish = vi.fn<ReviewProvider["publish"]>();
const readThread = vi.fn<ReviewProvider["readThread"]>();
const resolve = vi.fn<NonNullable<ReviewProvider["resolve"]>>();
function provider(resolves = true) {
  registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", permissions: { reviewProvider: true } }), undo)
    .reviewProvider({ id: "review", objectKind: "pr", label: "合并请求", publish, readThread, resolve: resolves ? resolve : undefined });
}
beforeEach(() => {
  app = testApp();
  item = upsertItem(app, undefined, { spaceId: "personal", title: "修复" }).id;
  id = createRun(app, { kind: "code", title: "评审", spaceId: "personal", input: { itemId: item } }).id;
  undo = [registerObject("demo",{ kind: "pr", label: "合并请求", final: [], statuses: { open: "进行中" }, match: () => null, read: async () => { throw Error(); } })];
  run(app.db,"insert into flow_objects(id,kind,key,title,status,link,changed_at,updated_at) values('obj','demo:pr','pr-1','项目 A','open','https://example.org/pr','a','a')");
  run(app.db,"insert into item_materials(item_id,kind,ref,created_at) values(?,'object','obj','a')",item);
  setRunOutput(app,id,{ reviewHeads: { personal: "a".repeat(40) } });
  recordReview(app,{ codeRunId:id, round:1, check:"reviewer", verdict:"changes_requested", summary:"问题", findings:[1,2,3,4].map(line =>
    ({ title: "问题" + line, severity:"major", detail:"说明", file:"a.ts", line, suggestion:"修改", confidence:"high", evidence:[] })) });
  publish.mockReset().mockImplementation(async (_ctx, req) => ({ id:String(req.findingId),url:"https://example.org/comment/" + req.findingId }));
  readThread.mockReset().mockResolvedValue({ state:"open" });
  resolve.mockReset().mockResolvedValue({ state:"resolved" });
});
afterEach(() => { for (const fn of undo.reverse()) fn(); app.db.close(); });
const done = () => setRunOutput(app,id,{ reviewStage:"done", reviewLead:{ round:1 } });
const view = () => reviewSyncView(app,id,"owner");
const yes = (ask: string) => answerAsk(app,ask,{ by:"owner",choice:0 });

it("本人确认后逐条发送，只重试失败的问题，原评论与失效锚点保留",async () => {
  provider();
  run(app.db,`update review_findings set external='{"url":"https://example.org/manual","state":"open"}' where line=4`);
  publish.mockRejectedValueOnce(new Error("失败")).mockRejectedValueOnce(Object.assign(new Error("行已移动"),{ code:"REVIEW_ANCHOR_OUTDATED" }));
  done();
  expect(view().pending).toHaveLength(1);
  const ask = view().pending[0].id;
  await expect(answerAsk(app,ask,{ by:"member",choice:0 })).rejects.toThrow("本人");
  expect(publish).not.toHaveBeenCalled();
  await yes(ask);
  expect(view().findings.map(f => f.external?.delivery)).toEqual(["failed","relocate","published",undefined]);
  const retry = offerReviewPublish(app,id,{ object:"obj",findings:[view().findings[0].id] })!;
  await yes(retry.askId);
  expect(publish).toHaveBeenCalledTimes(4);
  expect(publish.mock.calls[0][0].idempotencyKey).toEqual(publish.mock.calls[3][0].idempotencyKey);
  expect(all(app.db,"select id from audit_events where action='review.publish'")).toHaveLength(4);
});

it.each([true,false])("平台回复和结束写回，复审后按提供者能力确认结束 %s",async resolves => {
  provider(resolves);
  app.config.plugins.eventSpaces = { demo:["personal"] };
  run(app.db,"insert into plugin_subscriptions values('demo','demo:listener','finding.thread')");
  done();
  await yes(view().pending[0].id);
  const reply = { author:"作者",at:"2026-10-01T00:00:00Z",summary:"已调整" };
  readThread.mockResolvedValueOnce({ state:"replied",reply }).mockResolvedValueOnce({ state:"resolved" });
  expect(await refreshThreads(app,{ object:"obj" })).toEqual({ refreshed:4,failed:0 });
  expect(view().findings[0].external).toMatchObject({ state:"replied",reply });
  expect(all(app.db,"select id from plugin_events")).toHaveLength(2);
  expect(all(app.db,"select seq from run_events where type='finding.thread'")).toHaveLength(2);
  const next = createRun(app,{ kind:"code",spaceId:"personal",title:"复审",input:{ itemId:item,rereviewOf:id } });
  recordPrior(app,next.id,[{id:view().findings[0].id,status:"fixed"}]);
  const pending = reviewSyncView(app,next.id,"owner").pending;
  expect(pending).toHaveLength(resolves ? 1 : 0);
  expect(resolve).not.toHaveBeenCalled();
  if (resolves) {
    await yes(pending[0].id);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(all(app.db,"select id from audit_events where action='review.resolve'")).toHaveLength(1);
    expect(view().findings[0].external?.state).toBe("resolved");
  }
});

it.each(["item","object"])("缺少关联 %s 时不生成发布卡",what => {
  provider();
  if (what === "item") run(app.db,"update runs set input='{}' where id=?",id);
  else run(app.db,"delete from item_materials where item_id=?",item);
  done();
  expect(view().pending).toEqual([]);
});
