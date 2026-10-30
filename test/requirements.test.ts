import { describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMaterials, materialsBrief } from "../src/items/materials.ts";
import { findReq, ownerCorrections, recordReqStatus, reqDetail, reqTree, reqVersions, saveReqs, type ReqOp, type ReqWriter } from "../src/items/requirements.ts";
import { upsertItem } from "../src/items/store.ts";
import { search } from "../src/search/search.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
createSpace(app, { id: "pay", name: "支付", kind: "project" });
const owner: ReqWriter = { by: "user", label: "本人" };
const open: Parameters<typeof saveReqs>[3] = { canWrite: () => {}, canRead: () => {}, defaultSpace: "shop" };
const save = (ops: ReqOp[], w: ReqWriter = owner, check = open) => saveReqs(app, ops, w, check);

describe("requirement trees", () => {
  it("builds a tree in one batch, keeps kinds in their places, and indexes features but not test points", async () => {
    const r = save([
      { op: "add", key: "sys", kind: "system", title: "示例商城后台" },
      { op: "add", key: "refund", parent: "$sys", kind: "page", title: "退款申请页" },
      { op: "add", key: "amount", parent: "$refund", kind: "feature", title: "退款金额只算未发货的行", body: "已发货的行不退款，运费按比例。", acceptance: "部分发货的订单只退未发货部分" },
      { op: "add", parent: "$amount", kind: "test", title: "部分发货：只退未发货的两行", tests: [{ file: "refund.test.ts", name: "partial shipment" }] },
    ]);
    expect(r.done).toHaveLength(4);
    const tree = reqTree(app, "shop");
    expect(tree.map((n) => [n.depth, n.kind, n.title])).toEqual([
      [0, "system", "示例商城后台"],
      [1, "page", "退款申请页"],
      [2, "feature", "退款金额只算未发货的行"],
      [3, "test", "部分发货：只退未发货的两行"],
    ]);
    expect(tree.every((n) => n.confirmed)).toBe(true);
    expect(() => save([{ op: "add", kind: "test", title: "没有上级的测试点" }])).toThrow(/测试点不能放在最上层/);
    expect(() => save([{ op: "add", parent: r.keys.sys, kind: "system", title: "系统套系统" }])).toThrow(/不能放在/);

    const hits = await search(app, "未发货 退款金额", { spaces: ["shop"], types: ["requirement"] });
    expect(hits[0].id).toBe(r.keys.amount);
    expect(await search(app, "partial shipment 两行", { spaces: ["shop"], types: ["requirement"] })).toEqual([]);
  });

  it("tells a correction from a business change, keeps every version, and removes subtrees", () => {
    const amount = reqTree(app, "shop").find((n) => n.kind === "feature")!;
    expect(() => save([{ op: "edit", id: amount.id, change: "change", body: "运费不退。" }])).toThrow(/写清为什么变/);
    save([{ op: "edit", id: amount.id, change: "correct", title: "退款金额只算未发货的商品行" }]);
    save([{ op: "edit", id: amount.id, change: "change", body: "已发货的行不退款，运费不退。", reason: "运营决定运费一律不退", source_refs: ["src:s-demo#L3"] }]);
    const versions = reqVersions(app, amount.id);
    expect(versions.map((v) => [v.version, v.change])).toEqual([[1, "create"], [2, "correct"], [3, "change"]]);
    expect(versions[2]).toMatchObject({ reason: "运营决定运费一律不退", sourceRefs: ["src:s-demo#L3"], body: "已发货的行不退款，运费不退。" });

    // An Agent's write waits for the owner; the owner's confirmation is recorded too.
    save([{ op: "edit", id: amount.id, change: "correct", acceptance: "部分发货只退未发货部分，运费不退" }], { by: "agent", label: "req-splitter" });
    expect(findReq(app, amount.id)!.confirmed).toBe(false);
    expect(() => save([{ op: "confirm", id: amount.id }], { by: "agent", label: "x" })).toThrow(/本人确认/);
    save([{ op: "confirm", id: amount.id }]);
    expect(findReq(app, amount.id)!.confirmed).toBe(true);

    const page = reqTree(app, "shop").find((n) => n.kind === "page")!;
    expect(() => save([{ op: "delete", id: page.id, change: "change" }])).toThrow(/为什么不要了/);
    save([{ op: "delete", id: page.id, change: "change", reason: "退款改走客服工单" }]);
    expect(reqTree(app, "shop").map((n) => n.kind)).toEqual(["system"]);
    expect(reqTree(app, "shop", { removed: true }).filter((n) => n.status === "removed")).toHaveLength(3);
    expect(reqVersions(app, amount.id).at(-1)).toMatchObject({ change: "remove", reason: "随上级「退款申请页」一起" });
    save([{ op: "restore", id: page.id }, { op: "restore", id: amount.id }]);
    expect(reqTree(app, "shop").map((n) => n.kind)).toEqual(["system", "page", "feature"]);
  });

  it("links requirements across businesses and checks both spaces", () => {
    const amount = reqTree(app, "shop").find((n) => n.kind === "feature")!;
    const pay = save([{ op: "add", key: "refundApi", space: "pay", kind: "feature", title: "原路退款接口按行退款" }], owner, { ...open, defaultSpace: "pay" }).keys.refundApi;
    expect(() => save([{ op: "add", parent: amount.id, space: "pay", kind: "test", title: "x" }])).toThrow(/跨业务的关系用 link/);
    save([{ op: "link", id: amount.id, to: pay, note: "按行退款依赖支付侧接口" }]);
    expect(reqDetail(app, amount.id).links).toEqual([expect.objectContaining({ direction: "out", note: "按行退款依赖支付侧接口", other: expect.objectContaining({ id: pay, spaceId: "pay" }) })]);
    expect(reqDetail(app, pay).links[0]).toMatchObject({ direction: "in", other: { id: amount.id } });
    const denied = { ...open, canRead: (id: string) => { if (id === "pay") throw new Error("不能访问空间 pay"); } };
    expect(() => save([{ op: "unlink", id: amount.id, to: pay }], owner, denied)).toThrow(/pay/);
  });

  it("goes with an item into delegation briefs, with business changes and per-round states", async () => {
    const amount = reqTree(app, "shop").find((n) => n.kind === "feature")!;
    const page = reqTree(app, "shop").find((n) => n.kind === "page")!;
    const item = upsertItem(app, undefined, { spaceId: "shop", title: "退款只退未发货的行", kind: "todo" }, "user");
    addMaterials(app, item.id, [{ kind: "req", ref: `req:${page.id}` }], "owner", "user");
    const since = new Date(Date.now() - 60_000).toISOString();
    recordReqStatus(app, "r-demo", 1, [{ req: amount.id, status: "partial", locations: [{ file: "refund.ts", start: 1, end: 3 }] }, { status: "extra" }]);
    const brief = materialsBrief(app, item.id, "owner", { since });
    expect(brief).toContain(`[功能 ${amount.id}] 退款金额只算未发货的商品行（上一次评审：部分实现）`);
    expect(brief).toContain("验收：部分发货只退未发货部分，运费不退");
    expect(brief).toMatch(/业务变更（上一轮之后）[\s\S]*运营决定运费一律不退/);
    expect(brief).toMatch(/关联的其他业务[\s\S]*空间 pay/);
    expect(reqDetail(app, amount.id).state).toMatchObject({ runId: "r-demo", status: "partial" });
  });

  it("is read and written through tools inside the caller's spaces", async () => {
    const ctx: ToolContext = { app, runId: null, spaceId: "shop", spaces: ["shop"], tools: null, actor: "agent", agentProfile: "req-splitter" };
    const tree = await callTool(ctx, "req_tree", {});
    expect(tree.text).toMatch(/\[系统 q\w+\] 示例商城后台/);
    const sys = reqTree(app, "shop")[0];
    const added = await callTool(ctx, "save_requirements", { ops: [{ op: "add", key: "list", parent: sys.id, kind: "page", title: "退款列表页" }, { op: "add", parent: "$list", title: "按退款原因筛选" }] });
    expect(added.isError).toBeFalsy();
    expect(added.text).toMatch(/待本人确认/);
    const filter = reqTree(app, "shop").find((n) => n.title === "按退款原因筛选")!;
    expect(filter).toMatchObject({ kind: "feature", confirmed: false });
    expect((await callTool(ctx, "save_requirements", { ops: [{ op: "edit", id: filter.id, title: "x" }] })).text).toMatch(/缺少 change/);
    const pay = reqTree(app, "pay")[0];
    expect((await callTool(ctx, "req_read", { id: pay.id })).text).toMatch(/不能访问空间 pay/);
    const read = await callTool(ctx, "req_read", { id: filter.id });
    expect(read.text).toMatch(/时间线[\s\S]*新建（req-splitter）/);
    const found = await callTool(ctx, "search", { query: "退款原因筛选", scope: "requirements" });
    expect(found.text).toContain(`需求点 ${filter.id}`);
  });

  it("shows the owner's corrections of what an Agent wrote, for the next split and the coach", () => {
    const agent: ReqWriter = { by: "agent", label: "req-splitter", runId: "r-split" };
    const k = save([{ op: "add", key: "p", space: "shop", kind: "page", title: "优惠券页" }, { op: "add", key: "a", parent: "$p", title: "优化领券" }, { op: "add", parent: "$p", title: "多余的点" }], agent).keys;
    const extra = reqTree(app, "shop").find((n) => n.title === "多余的点")!;
    save([{ op: "edit", id: k.a, change: "correct", title: "每人每天最多领 3 张" }, { op: "delete", id: extra.id, change: "correct", reason: "PRD 没有这条" }, { op: "confirm", id: k.p }]);
    const forRun = ownerCorrections(app, { runId: "r-split" });
    const text = forRun.lines.join("\n");
    expect(text).toMatch(/标题「优化领券」→「每人每天最多领 3 张」/);
    expect(text).toMatch(/删掉了「多余的点」（PRD 没有这条）/);
    expect(forRun.confirmed).toBeGreaterThan(0);
    expect(ownerCorrections(app, { spaceId: "shop" }).lines.length).toBeGreaterThanOrEqual(2);
  });
});
