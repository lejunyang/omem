import { afterAll, describe, expect, it } from "vitest";
import { createRun, getRun, listRuns } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createThread } from "../src/agents/threads.ts";
import { codeWork } from "../src/agents/code-works.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser, OWNER } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { startServer } from "../src/server/http.ts";
import { upsertSource } from "../src/sources/store.ts";
import { designChanges } from "../src/designs/changes.ts";
import { designLine, designMarkdown } from "../src/designs/render.ts";
import {
  answerQuestion, createDesign, decideDesign, designFeedback, designOfWork, designRevisions, designsOfItem, getDesign, listDesigns, onDesignDecided, setConcernState, setDesignWork, submitRevision,
} from "../src/designs/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
createSpace(app, { id: "shop-api", name: "商城接口", kind: "repo" });
createSpace(app, { id: "secret", name: "别的项目", kind: "project" });
const doc = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/refund-design.md", title: "退款改造技术方案", text: "# 退款改造\n\n退款金额改由订单服务计算。" });
const hidden = upsertSource(app, { spaceId: "secret", kind: "doc", uri: "docs/other.md", title: "别的方案", text: "别的" });

const field = (brief: string, extra: Record<string, unknown> = {}) => ({ brief, ...extra });
const ownChange = () => ({
  facts: [{ text: "退款金额在两个页面各算一遍", refs: ["refund.ts:40"] }],
  decisions: [{
    kind: "change" as const, title: "退款金额在订单行上算，页面不再自己合计", reqs: ["退款只算已发货行"],
    fields: { behavior: field("页面合计 → computeRefund", { table: { head: ["情况", "现在", "改后"], rows: [["部分发货", "全退", "只退已发货行"]] } }), where: field("order/refund.ts 一处"), callers: field("导出任务、对账报表"), migration: field("不涉及：只改计算") },
    question: { text: "运费怎么退", options: ["按金额比例", "按件数比例"], recommended: 0 },
  }],
});

describe("design store", () => {
  it("checks a version by where the design comes from", () => {
    const own = createDesign(app, { spaceId: "shop", title: "退款改造", origin: "own" });
    // An own design gives every field of its kind, the behaviour as a table.
    const bare = ownChange();
    delete (bare.decisions[0].fields as Record<string, unknown>).migration;
    expect(() => submitRevision(app, own.id, bare)).toThrow(/缺栏目 migration/);
    const noTable = ownChange();
    noTable.decisions[0].fields.behavior = field("页面合计 → computeRefund") as never;
    expect(() => submitRevision(app, own.id, noTable)).toThrow(/只有一句话/);
    const wrongKey = ownChange();
    (wrongKey.decisions[0].fields as Record<string, unknown>).entry = field("入口");
    expect(() => submitRevision(app, own.id, wrongKey)).toThrow(/没有栏目 entry/);
    const long = ownChange();
    (long.decisions[0].fields.where as Record<string, unknown>).code = Array.from({ length: 31 }, (_, i) => `field${i}: string;`).join("\n");
    expect(() => submitRevision(app, own.id, long)).toThrow(/31 行/);
    const ok = submitRevision(app, own.id, ownChange(), { runId: null });
    expect(ok).toMatchObject({ status: "review", revision: 1 });
    expect(ok.body.decisions[0].id).toBe("D1");

    // Someone else's design may leave fields out; a change description needs its change in behaviour.
    const ext = createDesign(app, { spaceId: "shop", title: "小王的退款方案", origin: "external", author: "小王" });
    expect(submitRevision(app, ext.id, { decisions: [{ kind: "remove", title: "删掉页面里的合计" }] })).toMatchObject({ status: "assessed", revision: 1 });
    const derived = createDesign(app, { spaceId: "shop", title: "变更说明", origin: "derived" });
    expect(() => submitRevision(app, derived.id, { decisions: [{ kind: "change", title: "只退已发货行" }] })).toThrow(/behavior/);
    expect(() => submitRevision(app, derived.id, { decisions: [{ kind: "remove", title: "删合计", fields: { behavior: field("x") } }] })).toThrow(/没有栏目 behavior|removes/);
    expect(submitRevision(app, derived.id, { decisions: [{ kind: "remove", title: "删合计", fields: { removes: field("两份合计") } }] })).toMatchObject({ status: "recorded" });
  });

  it("keeps decision and concern ids from version to version and refuses a reassessment that drops a concern", () => {
    const d = createDesign(app, { spaceId: "shop", title: "退款方案", origin: "external" });
    const first = submitRevision(app, d.id, {
      decisions: [
        { kind: "change", title: "订单服务算退款", concerns: [{ level: "problem", text: "对账报表没改" }, { level: "question", text: "旧数据要不要回填" }] },
        { kind: "add", title: "部分发货", stated: false },
      ],
      concerns: [{ level: "risk", text: "没写发布顺序" }],
    });
    expect(first.body.decisions.map((x) => x.id)).toEqual(["D1", "D2"]);
    expect(first.body.concerns!.map((c) => c.id)).toEqual(["C1"]);
    expect(first.body.decisions[0].concerns!.map((c) => [c.id, c.state])).toEqual([["C2", "open"], ["C3", "open"]]);
    expect(designLine(first)).toBe("2 个决定；问题 1 风险 1 要问 1");

    // Every concern of the last version comes back with its state.
    expect(() => submitRevision(app, d.id, { decisions: [{ id: "D1", kind: "change", title: "订单服务算退款" }] })).toThrow(/C1「没写发布顺序」.*C2.*C3/s);
    // An id the last version did not have is refused; new ones are numbered after the highest ever used.
    expect(() => submitRevision(app, d.id, { decisions: [{ id: "D7", kind: "change", title: "x" }] })).toThrow(/上一版没有决定 D7/);
    const second = submitRevision(app, d.id, {
      decisions: [
        { id: "D2", kind: "add", title: "部分发货按已发货行退" },
        { kind: "remove", title: "删掉网关里的合计", concerns: [{ level: "improve", text: "网关里那份可以直接删" }] },
        { id: "D1", kind: "change", title: "订单服务算退款", concerns: [{ id: "C2", level: "problem", text: "对账报表没改", state: "resolved", note: "第 2 版改了" }, { id: "C3", level: "question", text: "旧数据要不要回填" }] },
      ],
      concerns: [{ id: "C1", level: "risk", text: "没写发布顺序", state: "dropped", note: "写了" }],
    }, { note: "文档第 2 版" });
    expect(second.revision).toBe(2);
    expect(second.body.decisions.map((x) => x.id)).toEqual(["D2", "D3", "D1"]);
    expect(second.body.decisions[1].concerns![0].id).toBe("C4");
    expect(listDesigns(app, { space: "shop" }).find((x) => x.id === d.id)!.counts).toEqual({ decisions: 3, questions: 0, concerns: { problem: 0, risk: 0, improve: 1, question: 1 } });
    expect(designRevisions(app, d.id).map((r) => [r.revision, r.note])).toEqual([[1, ""], [2, "文档第 2 版"]]);
    // A dropped decision's id is not given out again, nor taken back.
    const third = submitRevision(app, d.id, { decisions: [{ id: "D1", kind: "change", title: "订单服务算退款", concerns: [{ id: "C2", level: "problem", text: "对账报表没改", state: "resolved" }, { id: "C3", level: "question", text: "旧数据要不要回填" }, { id: "C4", level: "improve", text: "网关里那份可以直接删" }] }, { kind: "add", title: "新的" }], concerns: [{ id: "C1", level: "risk", text: "没写发布顺序", state: "dropped" }] });
    expect(third.body.decisions.map((x) => x.id)).toEqual(["D1", "D4"]);

    // The owner marks a concern on the page.
    const marked = setConcernState(app, d.id, "C3", { state: "resolved", note: "作者说不回填", by: "owner" });
    expect(marked.body.decisions[0].concerns!.find((c) => c.id === "C3")).toMatchObject({ state: "resolved", note: "作者说不回填", by: "owner" });
    expect(() => setConcernState(app, d.id, "C99", { state: "dropped" })).toThrow(/C99/);
    const md = designMarkdown(app, marked, { mode: "full" });
    expect(md).toContain("## D1 [修改] 订单服务算退款");
    expect(md).toContain("C3 [要问]（已解决：作者说不回填）");
    // Someone else's design leaving a field out shows it.
    expect(md).toContain("**行为**：（方案没写）");
  });

  it("is confirmed by the owner: answers, comments, approval, and listeners told", async () => {
    const d = createDesign(app, { spaceId: "shop", title: "退款改造", origin: "own", itemId: null });
    submitRevision(app, d.id, ownChange());
    const told: string[] = [];
    const off = onDesignDecided((_app, design, x) => { told.push(`${design.id}:${x.action}:${x.by}:${design.status}`); });
    // A question still open blocks approval.
    expect(() => decideDesign(app, d.id, { action: "approve", by: "owner" })).toThrow(/D1「运费怎么退」/);
    const commented = decideDesign(app, d.id, { action: "comment", text: "导出也要走同一个函数", answers: { D1: "按金额比例" }, by: "owner" });
    expect(commented.status).toBe("drafting");
    expect(commented.body.decisions[0].question!.answer).toBe("按金额比例");
    expect(designFeedback(app, d.id)).toMatchObject([{ action: "comment", text: "导出也要走同一个函数", answers: { D1: "按金额比例" }, by: "owner", revision: 1 }]);
    expect(designMarkdown(app, commented, { mode: "full" })).toContain("导出也要走同一个函数");
    expect(() => decideDesign(app, d.id, { action: "approve", by: "owner" })).toThrow(/在写/);
    // The next version keeps the answer while the question is the same; its feedback starts empty.
    const v2 = submitRevision(app, d.id, { ...ownChange(), decisions: [{ ...ownChange().decisions[0], id: "D1" }] });
    expect(v2.body.decisions[0].question!.answer).toBe("按金额比例");
    expect(designFeedback(app, d.id)).toEqual([]);
    const approved = decideDesign(app, d.id, { action: "approve", by: "owner" });
    expect(approved.status).toBe("approved");
    await Promise.resolve();
    expect(told).toEqual([`${d.id}:comment:owner:drafting`, `${d.id}:approve:owner:approved`]);
    off();
    const other = createDesign(app, { spaceId: "shop", title: "别人的", origin: "external" });
    expect(() => decideDesign(app, other.id, { action: "approve", by: "owner" })).toThrow(/只有自己的方案/);
    expect(() => answerQuestion(app, d.id, "D9", "x")).toThrow(/D9/);
  });

  it("finds designs by item and work, and says where decisions landed", async () => {
    const item = upsertItem(app, undefined, { title: "退款改造", spaceId: "shop" }, "user");
    const work = createRun(app, { kind: "code", spaceId: "shop", title: "交办：退款", input: { task: "改退款", repos: ["shop-api"] } });
    const d = createDesign(app, { spaceId: "shop", title: "退款", origin: "derived", itemId: item.id, repos: ["shop-api"] });
    setDesignWork(app, d.id, work.id);
    const done = submitRevision(app, d.id, { decisions: [{ kind: "change", title: "只退已发货行", fields: { behavior: field("全退 → 只退已发货行") }, files: ["shop-api/order/refund.ts"] }], outside: ["shop-api/README.md", "notes.md"] });
    expect(designOfWork(app, work.id)!.id).toBe(d.id);
    expect(designsOfItem(app, item.id).map((x) => x.id)).toEqual([d.id]);
    expect(await designChanges(app, done)).toEqual({
      changes: [{ decision: "D1", tasks: [], commits: 0, files: [{ space: "shop-api", path: "order/refund.ts", add: 0, del: 0 }], findings: { open: 0, total: 0 } }],
      outside: [{ space: "shop-api", path: "README.md", add: 0, del: 0 }, { space: "shop-api", path: "notes.md", add: 0, del: 0 }],
    });
    expect(codeWork(app, work.id)!.design).toEqual({ id: d.id, origin: "derived", status: "recorded", revision: 1, counts: { decisions: 1, questions: 0, concerns: { problem: 0, risk: 0, improve: 0, question: 0 } } });
  });
});

describe("design tools", () => {
  const base = (extra: Partial<ToolContext> = {}): ToolContext => ({ app, runId: null, spaceId: "shop", spaces: ["shop", "shop-api", "personal"], tools: null, actor: "agent", userId: OWNER, ...extra });

  it("submit_design writes only into the design its run is bound to", async () => {
    const loose = createRun(app, { kind: "agent", spaceId: "shop", title: "随便" });
    const refused = await callTool(base({ runId: loose.id }), "submit_design", ownChange());
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("没有绑定方案");
    const d = createDesign(app, { spaceId: "shop", title: "退款改造", origin: "own" });
    const bound = createRun(app, { kind: "code", spaceId: "shop", title: "写方案", input: { designId: d.id } });
    const ok = await callTool(base({ runId: bound.id, role: "designer" }), "submit_design", { ...ownChange(), note: "第一版" });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toContain("1 个决定，1 个要你定");
    expect(getDesign(app, d.id)).toMatchObject({ status: "review", revision: 1, runId: bound.id });
  });

  it("read_design by design, run and item, within the spaces the run may read", async () => {
    const item = upsertItem(app, undefined, { title: "退款读法", spaceId: "shop" }, "user");
    const d = createDesign(app, { spaceId: "shop", title: "读方案", origin: "external", itemId: item.id });
    submitRevision(app, d.id, { facts: [{ text: "三个页面各算一遍" }], decisions: [{ kind: "change", title: "订单服务算" }] });
    const work = createRun(app, { kind: "code", spaceId: "shop", title: "交办" });
    setDesignWork(app, d.id, work.id);
    const later = createRun(app, { kind: "code", spaceId: "shop", title: "第 2 轮", input: { continueFrom: work.id } });
    for (const args of [{ design_id: d.id }, { run_id: later.id }, { item_id: item.id }]) {
      const r = await callTool(base(), "read_design", args);
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toContain("## 影响方案的事实");
      expect(r.text).toContain("D1 [修改] 订单服务算");
    }
    const theirs = createDesign(app, { spaceId: "secret", title: "别的", origin: "external" });
    expect((await callTool(base(), "read_design", { design_id: theirs.id })).isError).toBe(true);
    expect((await callTool(base(), "read_design", {})).isError).toBe(true);
  });

  it("assess_design checks the documents and queues an assessment on a new or the same design", async () => {
    const asker = createRun(app, { kind: "ask", spaceId: "shop", title: "问答" });
    const ctx = base({ runId: asker.id });
    expect((await callTool(ctx, "assess_design", { title: "退款", sources: ["src:s_missing"] })).text).toContain("找不到原件");
    expect((await callTool(ctx, "assess_design", { title: "退款", sources: [`src:${hidden.id}`] })).isError).toBe(true);
    expect((await callTool(ctx, "assess_design", { title: "退款", sources: [`src:${doc.id}`], repo_spaces: ["secret"] })).isError).toBe(true);
    const r = await callTool(ctx, "assess_design", { title: "退款改造技术方案", sources: ["docs/refund-design.md"], repo_spaces: ["shop-api"], author: "小王", note: "重点看对账" });
    expect(r.isError, r.text).toBe(false);
    const job = listRuns(app, { parentId: asker.id, kind: "design" })[0];
    expect(job).toMatchObject({ status: "queued", spaceId: "shop" });
    expect(job.input).toMatchObject({ mode: "assess", note: "重点看对账", repos: ["shop-api"] });
    expect(job.input.readSpaces).toEqual(expect.arrayContaining(["shop", "shop-api"]));
    const d = getDesign(app, job.input.designId as string);
    expect(d).toMatchObject({ origin: "external", status: "drafting", author: "小王", sources: [`src:${doc.id}`], repos: ["shop-api"] });
    expect(r.text).toContain(`运行 ${job.id}`);
    expect(r.text).toContain(`方案 ${d.id}`);
    // Not again while that one is going; once assessed, again on the same design.
    expect((await callTool(ctx, "assess_design", { title: "退款改造技术方案", sources: [`src:${doc.id}`], design_id: d.id })).text).toContain("正在评估");
    run(app.db, "update runs set status = 'done' where id = ?", job.id);
    submitRevision(app, d.id, { decisions: [{ kind: "change", title: "订单服务算" }] });
    const again = await callTool(ctx, "assess_design", { title: "退款改造技术方案", sources: [`src:${doc.id}`], design_id: d.id });
    expect(again.isError, again.text).toBe(false);
    expect(getDesign(app, d.id).status).toBe("drafting");
    const own = createDesign(app, { spaceId: "shop", title: "自己的", origin: "own" });
    expect((await callTool(ctx, "assess_design", { title: "x", sources: [`src:${doc.id}`], design_id: own.id })).text).toContain("不是别人的方案");
  });

  it("settle_design relays the owner's words; the assistant confirms alone only when settings allow and nothing waits on the owner", async () => {
    const t = createThread(app, { spaceId: "shop", channel: "web" });
    run(app.db, "insert into messages(id, conversation_id, role, text, created_at) values(?,?,?,?,?)", "msg_design_ok", t.id, "user", "方案可以，运费按金额比例", new Date().toISOString());
    const ownerTurn = createRun(app, { kind: "ask", spaceId: "shop", title: "回答", input: { conversationId: t.id, messageIds: ["msg_design_ok"] } });
    const quietTurn = createRun(app, { kind: "ask", spaceId: "shop", title: "唤醒", input: { conversationId: t.id, messageIds: [] } });
    const d = createDesign(app, { spaceId: "shop", title: "退款改造", origin: "own" });
    submitRevision(app, d.id, ownChange());
    const self = base({ runId: quietTurn.id });
    expect((await callTool(self, "settle_design", { design_id: d.id, action: "approve", owner_words: true })).text).toContain("没有本人的消息");
    expect((await callTool(self, "settle_design", { design_id: d.id, action: "approve" })).text).toContain("由本人确认");
    app.config.agents.design.confirm = "assistant";
    try {
      expect((await callTool(self, "settle_design", { design_id: d.id, action: "approve" })).text).toContain("要本人定的问题");
      expect((await callTool(self, "settle_design", { design_id: d.id, action: "answer", decision: "D1", text: "按金额比例" })).isError).toBe(true);
      const owner = base({ runId: ownerTurn.id });
      expect((await callTool(owner, "settle_design", { design_id: d.id, action: "answer", decision: "D1", text: "按金额比例", owner_words: true })).isError).toBe(false);
      // No question left: the assistant may confirm by itself.
      const ok = await callTool(self, "settle_design", { design_id: d.id, action: "approve" });
      expect(ok.isError, ok.text).toBe(false);
      expect(getDesign(app, d.id).status).toBe("approved");
    } finally { app.config.agents.design.confirm = "owner"; }
    // The owner's words go through whatever the setting; concerns can be marked by the assistant.
    const e = createDesign(app, { spaceId: "shop", title: "别人的", origin: "external" });
    submitRevision(app, e.id, { decisions: [{ kind: "change", title: "x", concerns: [{ level: "question", text: "要问" }] }] });
    const marked = await callTool(self, "settle_design", { design_id: e.id, action: "concern", concern: "C1", state: "dropped", note: "作者答了" });
    expect(marked.isError, marked.text).toBe(false);
    expect(getDesign(app, e.id).body.decisions[0].concerns![0]).toMatchObject({ state: "dropped", by: "assistant" });
    const d2 = createDesign(app, { spaceId: "shop", title: "再来", origin: "own" });
    submitRevision(app, d2.id, ownChange());
    const comment = await callTool(base({ runId: ownerTurn.id }), "settle_design", { design_id: d2.id, action: "comment", text: "导出也要改", owner_words: true });
    expect(comment.isError, comment.text).toBe(false);
    expect(getDesign(app, d2.id).status).toBe("drafting");
  });
});

describe("design HTTP", async () => {
  createUser(app, { id: "reader", name: "读者" });
  addMember(app, "shop", "reader", "reader");
  const token = createApiToken(app, "reader", "test");
  const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  afterAll(() => server.close());
  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const r = await fetch(`${app.baseUrl}${path}`, { method: init.method ?? "GET", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
    return { status: r.status, body: await r.json() as any };
  };

  it("lists, reads, assesses, decides and marks concerns, within the person's spaces", async () => {
    const item = upsertItem(app, undefined, { title: "HTTP 退款", spaceId: "shop" }, "user");
    const work = createRun(app, { kind: "code", spaceId: "shop", title: "交办：HTTP 退款" });
    const d = createDesign(app, { spaceId: "shop", title: "HTTP 退款方案", origin: "own", itemId: item.id, repos: ["shop-api"] });
    setDesignWork(app, d.id, work.id);
    submitRevision(app, d.id, ownChange());
    const secret = createDesign(app, { spaceId: "secret", title: "看不到的", origin: "external" });

    const list = await call(`/api/designs?item=${item.id}`);
    expect(list.body.designs).toEqual([expect.objectContaining({ id: d.id, title: "HTTP 退款方案", origin: "own", status: "review", revision: 1, author: null, itemId: item.id, workId: work.id, spaceId: "shop", updatedAt: expect.any(String), counts: { decisions: 1, questions: 1, concerns: { problem: 0, risk: 0, improve: 0, question: 0 } } })]);
    expect((await call(`/api/designs?work=${work.id}`)).body.designs.map((x: { id: string }) => x.id)).toEqual([d.id]);
    // Someone else sees only the spaces they may read.
    expect((await call("/api/designs", { token })).body.designs.some((x: { id: string }) => x.id === secret.id)).toBe(false);
    expect((await call(`/api/designs/${secret.id}`, { token })).status).toBe(404);

    const detail = (await call(`/api/designs/${d.id}`)).body;
    expect(Object.keys(detail).sort()).toEqual(["author", "body", "changes", "counts", "id", "item", "itemId", "origin", "outside", "reqs", "repos", "revision", "revisions", "sources", "spaceId", "status", "title", "updatedAt", "work", "workId"].sort());
    expect(detail).toMatchObject({ item: { id: item.id, title: "HTTP 退款" }, reqs: [], work: { rootId: work.id, title: "交办：HTTP 退款", branchReview: false }, revisions: [{ revision: 1, note: "", runId: null }], changes: [{ decision: "D1", tasks: [], commits: 0, files: [], findings: { open: 0, total: 0 } }], outside: [] });
    // Tied to a delegation that has not coded anything for it yet: an empty patch list, as task-diff gives.
    expect((await call(`/api/designs/${d.id}/diff?decision=D1`)).body).toEqual({ patches: [] });
    expect((await call(`/api/designs/${d.id}/diff?decision=D9`)).status).toBe(404);

    // A reader may look but not confirm.
    expect((await call(`/api/designs/${d.id}/decide`, { method: "POST", body: { action: "approve", answers: { D1: "按金额比例" } }, token })).status).toBe(403);
    const decided = await call(`/api/designs/${d.id}/decide`, { method: "POST", body: { action: "approve", answers: { D1: "按金额比例" } } });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toMatchObject({ status: "approved", counts: { questions: 0 } });

    const ext = createDesign(app, { spaceId: "shop", title: "别人的", origin: "external" });
    submitRevision(app, ext.id, { decisions: [{ kind: "change", title: "x", concerns: [{ level: "risk", text: "发布顺序" }] }] });
    expect((await call(`/api/designs/${ext.id}/concerns/C1`, { method: "POST", body: { state: "resolved" }, token })).status).toBe(403);
    const marked = await call(`/api/designs/${ext.id}/concerns/C1`, { method: "POST", body: { state: "resolved", note: "作者补了" } });
    expect(marked.body.counts.concerns.risk).toBe(0);

    const started = await call("/api/designs", { method: "POST", body: { title: "退款改造技术方案", sources: [`src:${doc.id}`], repos: ["shop-api"], itemId: item.id, author: "小王", note: "看对账" } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(getRun(app, started.body.runId)).toMatchObject({ kind: "design", input: { designId: started.body.id, mode: "assess" } });
    expect(getDesign(app, started.body.id)).toMatchObject({ origin: "external", itemId: item.id, status: "drafting" });
    // A reader cannot start one in a space they may not write, nor read a document elsewhere.
    expect((await call("/api/designs", { method: "POST", body: { title: "x", sources: [`src:${doc.id}`] , space: "shop" }, token })).status).toBe(403);
    createSpace(app, { id: "team", name: "小组", kind: "project" });
    addMember(app, "team", "reader", "editor");
    expect((await call("/api/designs", { method: "POST", body: { title: "x", sources: [`src:${hidden.id}`], space: "team" }, token })).status).toBe(403);
    const mine = await call("/api/designs", { method: "POST", body: { title: "x", sources: [`src:${doc.id}`], space: "team" }, token });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);

    const cw = (await call(`/api/code-works/${work.id}`)).body;
    expect(cw.design).toMatchObject({ id: d.id, origin: "own", status: "approved", revision: 1, counts: { decisions: 1 } });
  });
});
