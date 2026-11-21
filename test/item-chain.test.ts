import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser, OWNER } from "../src/core/users.ts";
import { createDesign, submitRevision } from "../src/designs/store.ts";
import { CHAIN_MAX, itemChain } from "../src/items/chain.ts";
import { addLocalMaterials } from "../src/items/materials.ts";
import { setParent } from "../src/items/parent.ts";
import { recordTests } from "../src/items/req-tests.ts";
import { recordReqStatus, saveReqs } from "../src/items/requirements.ts";
import { upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(() => { for (const a of apps.splice(0)) a.db.close(); });

function setup() {
  const app = testApp();
  apps.push(app);
  createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
  createSpace(app, { id: "secret", name: "别的业务", kind: "project" });
  const tree = saveReqs(app, [
    { op: "add", key: "page", kind: "page", title: "退款申请页" },
    { op: "add", key: "amount", parent: "$page", kind: "feature", title: "退款金额只算已发货的行" },
    { op: "add", key: "other", kind: "page", title: "别的业务的页面", space: "secret" },
  ], { by: "user", label: "本人" }, { canWrite: () => {}, canRead: () => {}, defaultSpace: "shop" });
  return { app, page: tree.keys.page, amount: tree.keys.amount, other: tree.keys.other };
}
const code = (app: App, itemId: string, title: string, spaceId = "shop") => {
  const r = createRun(app, { kind: "code", spaceId, title, input: { itemId, task: title, repos: [] } });
  run(app.db, "update runs set status = 'done' where id = ?", r.id);
  return r;
};
const finding = (app: App, itemId: string, id: string, title: string, workId: string | null = null, state = "new") =>
  run(app.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,round,work_id,created_at,updated_at) values(?,?,'defect',?,'复现步骤','[]',?,1,?,?,?)", id, itemId, title, state, workId, new Date().toISOString(), new Date().toISOString());

describe("工作项的链路：需求 → 发现 → 方案 → 交付", () => {
  it("只按存着的关联串起来：需求点的评审和测试、发现发起的交办、方案决定里的需求点、交办的测试", () => {
    const { app, page, amount, other } = setup();
    const item = upsertItem(app, undefined, { spaceId: "shop", title: "退款改造", userId: OWNER }, "user");
    addLocalMaterials(app, item.id, [{ kind: "req", ref: page }, { kind: "req", ref: other }], OWNER, "user");
    // Delegated for the item; its first round reported the feature done and a passing test.
    const w1 = code(app, item.id, "按已发货行退款");
    addLocalMaterials(app, item.id, [{ kind: "run", ref: w1.id }], OWNER, "user");
    recordReqStatus(app, w1.id, 1, [{ req: amount, status: "done" }]);
    recordTests(app, { runId: w1.id, workId: w1.id, spaceId: "shop", round: 1, by: "agent", tests: [{ req: amount, name: "只退已发货的行", status: "passed" }] });
    // A finding the study turned into a change, and one nobody has looked at.
    const w2 = code(app, item.id, "修满减分摊成负数");
    finding(app, item.id, "f1", "满减分摊算出负数", w2.id, "confirmed");
    finding(app, item.id, "f2", "运费没有按比例退");
    finding(app, item.id, "f3", "同一个问题", null, "duplicate");
    // A design whose decision names the page, and one naming nothing of the item's.
    const d = createDesign(app, { spaceId: "shop", title: "退款金额按行计算", origin: "external", author: "小王", itemId: item.id, userId: OWNER });
    submitRevision(app, d.id, { decisions: [{ kind: "change", title: "金额由订单服务算", reqs: [page] }] });
    const loose = createDesign(app, { spaceId: "shop", title: "顺手整理", origin: "external", author: "小王", itemId: item.id, userId: OWNER });
    submitRevision(app, loose.id, { decisions: [{ kind: "refactor", title: "拆函数", reqs: ["一句原话"] }] });
    // A platform object: shown with its status, linked to nothing.
    run(app.db, "insert into flow_objects(id,kind,key,title,status,link,fields,changed_at,updated_at) values('fo_1','demo.mr','12','合并请求 !12','open','https://git.example.com/mr/12','[]',?,?)", new Date().toISOString(), new Date().toISOString());
    run(app.db, "insert into item_materials(item_id,kind,ref,label,meta,added_by,created_at) values(?,'object','fo_1','合并请求 !12','{}','user',?)", item.id, new Date().toISOString());

    const c = itemChain(app, item.id, OWNER);
    expect(c.line).toBe(false);
    expect(c.groups).toHaveLength(1);
    const g = c.groups[0];
    expect(g.item).toEqual({ id: item.id, title: "退款改造" });
    // Both nodes: the owner reads every space.
    expect(g.reqs.map((r) => r.title)).toEqual(["退款申请页", "别的业务的页面"]);
    expect(g.reqs[0]).toMatchObject({ key: `req:${page}`, status: "已确认", now: "下面 1 个点，1 个已实现 · 测试 通过 1", href: `#/reqs/${page}` });
    expect(g.findings.map((f) => [f.title, f.status])).toEqual([["满减分摊算出负数", "认可"], ["运费没有按比例退", "等你看"]]);
    expect(g.findings[0].now).toContain("已发起修改");
    expect(g.designs.find((x) => x.title === "退款金额按行计算")).toMatchObject({ links: [`req:${page}`], href: `#/design/${d.id}` });
    expect(g.designs.find((x) => x.title === "顺手整理")!.links).toEqual([]);
    const byTitle = (t: string) => g.works.find((x) => x.title === t)!;
    expect(byTitle("按已发货行退款")).toMatchObject({ kind: "work", links: [`req:${page}`], href: `#/runs/${w1.id}` });
    expect(byTitle("按已发货行退款").now).toContain("测试 通过 1");
    expect(byTitle("修满减分摊成负数").links).toEqual(["finding:f1"]);
    expect(byTitle("合并请求 !12")).toMatchObject({ kind: "object", status: "open", links: [], href: "https://git.example.com/mr/12" });
    expect(c.counts).toMatchObject({ reqs: 2, findings: 2, designs: 2, works: 2 });
  });

  it("什么都没关联时四段都空", () => {
    const { app } = setup();
    const item = upsertItem(app, undefined, { spaceId: "shop", title: "只是一件待办", userId: OWNER }, "user");
    const c = itemChain(app, item.id, OWNER);
    expect(c.groups).toEqual([]);
    expect(c.counts).toEqual({ reqs: 0, findings: 0, designs: 0, works: 0, reviewing: 0, waiting: 0 });
  });

  it("看不到事项就是没有；看得到的人看不到别的空间的需求和方案", () => {
    const { app, page, other } = setup();
    createUser(app, { id: "xiaowang", name: "小王", role: "member" });
    addMember(app, "shop", "xiaowang", "contributor");
    const mine = upsertItem(app, undefined, { spaceId: "personal", title: "本人的事", userId: OWNER }, "user");
    expect(() => itemChain(app, mine.id, "xiaowang")).toThrow(/事项不存在/);
    const theirs = upsertItem(app, undefined, { spaceId: "shop", title: "小王的退款改造", userId: "xiaowang" } as never, "user");
    run(app.db, "insert into item_materials(item_id,kind,ref,label,meta,added_by,created_at) values(?,'req',?,'',?,'user',?),(?,'req',?,'',?,'user',?)", theirs.id, page, "{}", new Date().toISOString(), theirs.id, other, "{}", new Date().toISOString());
    createDesign(app, { spaceId: "secret", title: "别的业务的方案", origin: "own", itemId: theirs.id, userId: OWNER });
    createDesign(app, { spaceId: "shop", title: "看得到的方案", origin: "own", itemId: theirs.id, userId: "xiaowang" });
    const g = itemChain(app, theirs.id, "xiaowang").groups[0];
    expect(g.reqs.map((r) => r.title)).toEqual(["退款申请页"]);
    expect(g.designs.map((d) => d.title)).toEqual(["看得到的方案"]);
    // The owner sees both.
    expect(itemChain(app, theirs.id, OWNER).groups[0].reqs).toHaveLength(2);
  });

  it("一条线是子项的链按子项分组，同一个交办只出现一次", () => {
    const { app, page } = setup();
    const line = upsertItem(app, undefined, { kind: "line", spaceId: "shop", title: "退款改造", userId: OWNER }, "user");
    const a = upsertItem(app, undefined, { spaceId: "shop", title: "按行退款", userId: OWNER }, "user");
    const b = upsertItem(app, undefined, { spaceId: "shop", title: "退款对账", userId: OWNER }, "user");
    const quiet = upsertItem(app, undefined, { spaceId: "shop", title: "什么都没挂的", userId: OWNER }, "user");
    for (const x of [a, b, quiet]) setParent(app, x.id, line.id);
    const w = code(app, a.id, "按已发货行退款");
    addLocalMaterials(app, a.id, [{ kind: "req", ref: page }, { kind: "run", ref: w.id }], OWNER, "user");
    addLocalMaterials(app, b.id, [{ kind: "run", ref: w.id }], OWNER, "user");
    finding(app, b.id, "fb", "对账少一单");
    const c = itemChain(app, line.id, OWNER);
    expect(c.line).toBe(true);
    expect(c.groups.map((g) => g.item.title)).toEqual(["按行退款", "退款对账"]);
    expect(c.groups[0].works.map((x) => x.title)).toEqual(["按已发货行退款"]);
    expect(c.groups[1].works).toEqual([]);
    expect(c.groups[1].findings.map((x) => x.title)).toEqual(["对账少一单"]);
    expect(c.counts).toMatchObject({ reqs: 1, findings: 1, works: 1 });
  });

  it("每段有上限，多的记在 more 里", () => {
    const { app } = setup();
    const item = upsertItem(app, undefined, { spaceId: "shop", title: "课题", userId: OWNER }, "user");
    for (let i = 0; i < CHAIN_MAX.segment + 3; i++) finding(app, item.id, `f${i}`, `发现 ${i}`);
    const g = itemChain(app, item.id, OWNER).groups[0];
    expect(g.findings).toHaveLength(CHAIN_MAX.segment);
    expect(g.more).toBe(3);
  });
});
