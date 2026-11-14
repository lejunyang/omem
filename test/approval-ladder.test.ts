import { afterEach, expect, it } from "vitest";
import { approvalStreak, reportDone, rungOf, setRung, suggestPromotion } from "../src/agents/approval-ladder.ts";
import { answerAsk, createAsk, getAsk } from "../src/agents/asks.ts";
import { one, run } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { testApp } from "./helpers.ts";

type TestApp = ReturnType<typeof testApp>;
const apps: TestApp[] = [];
// A new question is shown to the owner a moment after it is created: let that finish before the library closes.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 80));
  for (const app of apps.splice(0)) app.db.close();
});
function setup() {
  const app = testApp();
  apps.push(app);
  app.config.approvals.tools = ["lark_write"];
  return app;
}
let n = 0;
/** One answered approval request of a tool, `minutesAgo` back. */
function answered(app: TestApp, tool: string, approved: boolean, minutesAgo: number) {
  const ask = createAsk(app, { runId: null, conversationId: null, kind: "approval", question: `要调用 ${tool} ${++n}`, tool, args: {}, context: { handler: "test-held" } });
  run(app.db, "update asks set status = 'answered', approved = ?, answered_at = ?, answered_by = 'owner' where id = ?", approved ? 1 : 0, new Date(Date.now() - minutesAgo * 60_000).toISOString(), ask.id);
  return ask;
}
const any = () => true;

it("keeps a tool on one rung at a time", () => {
  const app = setup();
  expect(rungOf(app, "lark_write")).toBe("ask");
  expect(rungOf(app, "search")).toBe("free");
  setRung(app, "lark_write", "report");
  expect(rungOf(app, "lark_write")).toBe("report");
  expect(app.config.approvals.tools).toEqual([]);
  setRung(app, "lark_write", "ask");
  expect([app.config.approvals.tools, app.config.approvals.report]).toEqual([["lark_write"], []]);
  setRung(app, "lark_write", "free");
  expect(rungOf(app, "lark_write")).toBe("free");
});

it("counts approvals in a row back to the last refusal", () => {
  const app = setup();
  answered(app, "lark_write", true, 50);
  answered(app, "lark_write", false, 40);
  answered(app, "lark_write", true, 30);
  answered(app, "lark_write", true, 20);
  answered(app, "code_git_action", false, 10);
  expect(approvalStreak(app, "lark_write")).toBe(2);
  expect(approvalStreak(app, "code_git_action")).toBe(0);
});

it("asks once, after enough approvals in a row, whether the tool may run and be reported; yes moves it up", async () => {
  const app = setup();
  app.config.approvals.promoteAfter = 3;
  const last = [30, 20, 10].map((m) => answered(app, "lark_write", true, m)).at(-1)!;
  // Two in a row is not enough; a tool that always waits is never offered; nor one that is not asked about.
  expect(suggestPromotion(app, { tool: "lark_write", userId: "owner" }, () => false)).toBeNull();
  expect(suggestPromotion(app, { tool: "search", userId: "owner" }, any)).toBeNull();
  app.config.approvals.promoteAfter = 4;
  expect(suggestPromotion(app, last, any)).toBeNull();
  app.config.approvals.promoteAfter = 3;
  const q = suggestPromotion(app, last, any)!;
  expect(q.question).toContain("lark_write");
  expect(q.options.map((o) => o.label)).toEqual(["直接做，做完告诉我", "继续每次问我"]);
  // Not asked again within the month, whatever the answer.
  expect(suggestPromotion(app, last, any)).toBeNull();
  await answerAsk(app, q.id, { choice: 0, by: "owner" });
  expect(rungOf(app, "lark_write")).toBe("report");
  expect(getAsk(app, q.id).result).toContain("直接做");
});

it("leaves the tool where it is when the owner says keep asking, or promoteAfter is 0", async () => {
  const app = setup();
  app.config.approvals.promoteAfter = 2;
  const last = [20, 10].map((m) => answered(app, "lark_write", true, m)).at(-1)!;
  const q = suggestPromotion(app, last, any)!;
  await answerAsk(app, q.id, { choice: 1, by: "owner" });
  expect(rungOf(app, "lark_write")).toBe("ask");
  run(app.db, "delete from kv where key like 'approval_promote:%'");
  app.config.approvals.promoteAfter = 0;
  expect(suggestPromotion(app, last, any)).toBeNull();
});

it("tells the owner what a reported call did, as something that can wait", () => {
  const app = setup();
  reportDone(app, { who: "助理", runId: null }, "lark_write", { command: "sheets +append", row: ["项目 A", "已完成"] }, { text: "写入 1 行", isError: false });
  const sent = listNotifications(app)[0];
  expect(sent).toMatchObject({ title: "助理 已调用 lark_write", urgency: "later" });
  expect(sent.body).toContain("项目 A");
  expect(sent.body).toContain("写入 1 行");
  expect(one<{ n: number }>(app.db, "select count(*) n from notifications")?.n).toBe(1);
});
