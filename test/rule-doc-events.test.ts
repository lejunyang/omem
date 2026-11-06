import { afterEach, describe, expect, it, vi } from "vitest";
import { askModel } from "../src/agents/oneshot.ts";
import { getRun, listRuns } from "../src/agents/runs.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { flushDocEventsForTests, lineDiff, mentionsIn, onDocEvent, pollRuleDocs, subscribedSourceIds, docEventsArrive } from "../src/channels/lark-doc-events.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { all, one, run } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { createUser } from "../src/core/users.ts";
import { fireAfterWait } from "../src/rules/engine.ts";
import { rulePermissions } from "../src/rules/permissions.ts";
import { runScript } from "../src/rules/script.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import type { RuleInput } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/oneshot.ts", async (original) => ({ ...(await original<typeof import("../src/agents/oneshot.ts")>()), askModel: vi.fn() }));

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setLarkClient(null);
  setLarkCliForTests(null);
  vi.mocked(askModel).mockReset();
  for (const app of apps.splice(0)) app.db.close();
});

const notBefore = (app: ReturnType<typeof testApp>, id: string) => one<{ not_before: string }>(app.db, "select not_before from runs where id = ?", id)!.not_before;
const LINK = "https://tenant.larkoffice.com/docx/DocToken123";

/** A fake Feishu: the bot's API calls and cards, and the owner's lark-cli reading the document. */
function setup(markdown: string[]) {
  const app = testApp();
  apps.push(app);
  app.config.lark.appId = "cli_main";
  app.config.lark.ownerOpenId = "ou_owner";
  const calls: { method: string; url: string; data?: any; params?: any }[] = [];
  const cards: any[] = [];
  setLarkClient(
    {
      request: async (o: any) => {
        calls.push(o);
        if (o.url.includes("/contact/v3/users/")) return { code: 0, data: { user: { name: "小王", enterprise_email: "wang@example.com" } } };
        if (o.url.includes("/comments/")) return { code: 0, data: { reply_list: { replies: [{ reply_id: "r1", content: { elements: [{ type: "person", person: { user_id: "ou_bot" } }, { type: "text_run", text_run: { text: " 帮忙看看第二节" } }] } }] } } };
        if (o.url.endsWith("/metas/batch_query")) return { code: 0, data: { metas: [{ title: "差旅报销制度", url: LINK }] } };
        return { code: 0, data: {} };
      },
      im: { message: { create: async (p: any) => (cards.push(p), { code: 0, data: { message_id: `om_card${cards.length}` } }) } },
    },
    "ou_bot",
    "小助理",
  );
  const versions = [...markdown];
  setLarkCliForTests(async (args) => {
    if (args[0] === "docs" && args[1] === "+fetch") {
      const text = versions.length > 1 ? versions.shift()! : versions[0];
      return { ok: true, data: { document: { content: `<title>差旅报销制度</title>\n${text}`, revision_id: "1", document_id: "DocToken123" } } };
    }
    if (args[0] === "auth") return { ok: true, data: { identities: { user: { openId: "ou_owner_cli" } } } };
    return { ok: true, data: {} };
  });
  return { app, calls, cards };
}

const docRule = (over: Partial<RuleInput> = {}): RuleInput => ({
  name: "制度改动",
  description: "报销制度有人改了并且 @ 我时通知我",
  enabled: true,
  trigger: { event: "doc", docs: [LINK], once: "event", waitMinutes: 0, unless: [] },
  conditions: null,
  judge: "code",
  actions: [{ type: "notify", urgent: false }],
  ...over,
});

describe("document changes as rule events", () => {
  it("diffs lines and finds @ in document markdown", () => {
    expect(lineDiff("a\nb\nb\nc", "a\nb\nc\nd")).toEqual({ added: ["d"], removed: ["b"] });
    expect(mentionsIn('请 <mention-user id="ou_1" name="小王"/> 和 <at id="ou_2">小李</at> 确认')).toEqual([{ id: "ou_1", name: "小王" }, { id: "ou_2", name: "小李" }]);
  });

  it("subscribes a rule's documents when checked, and reports a refusal with what to do", async () => {
    const { app, calls } = setup(["第一节\n第二节"]);
    const rule = saveRule(app, docRule(), "user", "owner");
    const report = await rulePermissions(app, rule);
    expect(calls.some((c) => c.method === "POST" && c.url === "/open-apis/drive/v1/files/DocToken123/subscribe" && c.params.file_type === "docx")).toBe(true);
    expect(report.ok.some((x) => x.includes("差旅报销制度"))).toBe(true);
    expect(one<{ snapshot: string }>(app.db, "select snapshot from lark_doc_subscriptions where file_token = 'DocToken123'")!.snapshot).toContain("第二节");
    // Not a manager of the document: Feishu refuses (1069603), and the report says to add the bot.
    setLarkClient({ request: async () => { throw Object.assign(new Error("forbidden"), { response: { data: { code: 1069603, msg: "forbidden" } } }); }, im: { message: { create: async () => ({ code: 0, data: {} }) } } }, "ou_bot", "小助理");
    const refused = await rulePermissions(app, { ...rule, trigger: { ...rule.trigger, docs: ["https://tenant.larkoffice.com/sheets/SheetToken9"] } });
    expect(refused.issues.some((i) => /添加文档应用/.test(i.problem))).toBe(true);
  });

  it("turns a burst of edits into one change: what was added, who edited, who was @-mentioned", async () => {
    const { app } = setup(["第一节\n第二节", "第一节\n第二节\n第三节：住宿标准 <mention-user id=\"ou_owner_cli\" name=\"我\"/>"]);
    const rule = saveRule(app, docRule({ conditions: { field: "change.mentionsOwner", op: "is", value: true } }), "user", "owner");
    await rulePermissions(app, rule);
    onDocEvent(app, "main", "drive.file.edit_v1", { file_token: "DocToken123", file_type: "docx", operator_id_list: [{ open_id: "ou_wang", union_id: "on_wang", user_id: "u1" }] });
    onDocEvent(app, "main", "drive.file.edit_v1", { file_token: "DocToken123", file_type: "docx", operator_id_list: [{ open_id: "ou_wang" }] });
    await flushDocEventsForTests(app);
    const fired = listFirings(app, rule.id);
    expect(fired).toHaveLength(1);
    expect(fired[0].summary).toContain("差旅报销制度");
    expect(fired[0].summary).toContain("小王");
    expect(fired[0].summary).toContain("第三节：住宿标准");
    expect(listNotifications(app, 5).some((n) => n.title.includes("制度改动"))).toBe(true);
    // Events arrive: the periodic check may leave subscribed captured documents alone.
    expect(docEventsArrive(app)).toBe(true);
    expect(subscribedSourceIds(app).size).toBe(0);
  });

  it("describes table record changes and comments that @ the bot", async () => {
    const { app } = setup(["x"]);
    const rule = saveRule(app, docRule({ trigger: { event: "doc", once: "event", waitMinutes: 0, unless: [] }, conditions: { any: [{ field: "change.kind", op: "equals", value: "record" }, { field: "change.mentionsBot", op: "is", value: true }] } }), "user", "owner");
    onDocEvent(app, "main", "drive.file.bitable_record_changed_v1", { file_token: "BaseTok", file_type: "bitable", table_id: "tbl1", operator_id: { open_id: "ou_wang" }, action_list: [{ record_id: "rec1", action: "record_edited", before_value: [{ field_id: "状态", field_value: "\"进行中\"" }], after_value: [{ field_id: "状态", field_value: "\"已完成\"" }] }] });
    await flushDocEventsForTests(app);
    onDocEvent(app, "main", "drive.notice.comment_add_v1", { comment_id: "c1", reply_id: "r1", is_mentioned: true, notice_meta: { file_token: "DocToken123", file_type: "docx", from_user_id: { open_id: "ou_wang" }, to_user_id: { open_id: "ou_bot" }, notice_type: "add_comment" } });
    await vi.waitFor(() => expect(listFirings(app, rule.id)).toHaveLength(2));
    const [comment, record] = listFirings(app, rule.id);
    expect(record.summary).toContain("修改记录 rec1");
    expect(record.summary).toContain("进行中");
    expect(comment.summary).toContain("有新评论");
    expect(comment.summary).toContain("帮忙看看第二节");
  });
});

describe("delay, check and script actions", () => {
  it("a delay hands the rest of the actions to a later run; a check the model answers no stops there", async () => {
    const { app } = setup(["x"]);
    const rule = saveRule(app, docRule({ trigger: { event: "doc", once: "event", waitMinutes: 0, unless: [] }, conditions: { field: "change.kind", op: "equals", value: "record" }, actions: [{ type: "delay", minutes: 30 }, { type: "check", question: "改的是状态吗？" }, { type: "notify", urgent: false }] }), "user", "owner");
    onDocEvent(app, "main", "drive.file.bitable_record_changed_v1", { file_token: "BaseTok", file_type: "bitable", action_list: [{ record_id: "rec1", action: "record_added", after_value: [] }] });
    await flushDocEventsForTests(app);
    const later = listRuns(app, { kind: "rule-fire" })[0];
    expect(later.input.actions).toHaveLength(2);
    expect(Date.parse(notBefore(app, later.id))).toBeGreaterThan(Date.now() + 25 * 60_000);
    const before = listNotifications(app, 20).length;
    vi.mocked(askModel).mockResolvedValueOnce(JSON.stringify({ yes: false, reason: "改的是备注" }));
    const i = later.input as any;
    expect((await fireAfterWait(app, rule.id, i.key, i.event, { actions: i.actions })).summary).toContain("否：改的是备注");
    expect(listNotifications(app, 20).length).toBe(before);
    vi.mocked(askModel).mockResolvedValueOnce(JSON.stringify({ yes: true, reason: "是状态" }));
    await fireAfterWait(app, rule.id, i.key, i.event, { actions: i.actions });
    expect(listNotifications(app, 20).length).toBe(before + 1);
  });

  it("only the owner saves a rule with a script; a delay or check cannot end a rule", () => {
    const { app } = setup(["x"]);
    createUser(app, { name: "小管", id: "admin1" });
    const script = docRule({ actions: [{ type: "script", runtime: "node", code: "console.log(1)", timeoutSec: 10, approval: { by: "none" } }] });
    expect(() => saveRule(app, script, "agent")).toThrow(/只能由本人/);
    expect(() => saveRule(app, script, "user", "admin1")).toThrow(/只能由本人/);
    expect(() => saveRule(app, script, "user")).toThrow(/只能由本人/);
    expect(saveRule(app, script, "user", "owner").actions[0].type).toBe("script");
    expect(() => saveRule(app, docRule({ actions: [{ type: "notify", urgent: false }, { type: "delay", minutes: 5 }] }), "user", "owner")).toThrow(/延时后面/);
    expect(() => saveRule(app, docRule({ actions: [{ type: "watch", spec: "x", on: "all", reply: "draft" }] }), "user", "owner")).toThrow(/文档变化规则没有群/);
    expect(() => saveRule(app, docRule({ conditions: { field: "chat.name", op: "contains", value: "报警" } }), "user", "owner")).toThrow(/只能用文档和变化的字段/);
  });

  it("runs a script with the event as JSON and none of omem's environment; an approval waits for the card", async () => {
    const { app, cards } = setup(["x"]);
    process.env.OMEM_TEST_SECRET_FOR_SCRIPT = "do-not-leak";
    const code = "const e = JSON.parse(process.env.OMEM_EVENT); let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => console.log(e.change.kind, JSON.parse(input).doc.token, process.env.OMEM_TEST_SECRET_FOR_SCRIPT ?? 'no-secret'));";
    const rule = saveRule(app, docRule({ trigger: { event: "doc", once: "event", waitMinutes: 0, unless: [] }, conditions: { field: "change.kind", op: "equals", value: "record" }, actions: [{ type: "script", runtime: "node", code, timeoutSec: 30, approval: { by: "owner" } }] }), "user", "owner");
    onDocEvent(app, "main", "drive.file.bitable_record_changed_v1", { file_token: "BaseTok", file_type: "bitable", action_list: [{ record_id: "rec1", action: "record_added", after_value: [] }] });
    await flushDocEventsForTests(app);
    const waiting = listRuns(app, { kind: "rule-script" })[0];
    expect(waiting.status).toBe("queued");
    expect(Date.parse(notBefore(app, waiting.id))).toBeGreaterThan(Date.now() + 86400_000);
    // Started before the approval (say, after a restart): it does not run.
    expect(await runScript(app, waiting)).toEqual({ skipped: "没有得到批准，没有执行" });
    expect(JSON.stringify(cards.at(-1))).toContain("要执行这段脚本吗");
    // Only the approver may press it; the owner approves.
    expect((await handleCardAction(app, { operator: { open_id: "ou_other" }, context: { open_message_id: `om_card${cards.length}` }, action: { tag: "button", value: { action: "approve" } } })).toast.type).toBe("error");
    await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: `om_card${cards.length}` }, action: { tag: "button", value: { action: "approve" } } });
    const approved = getRun(app, waiting.id);
    expect(Date.parse(notBefore(app, waiting.id))).toBeLessThanOrEqual(Date.now());
    const out = (await runScript(app, approved)) as { stdout: string; exitCode: number };
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("record BaseTok no-secret");
    expect(rule.id).toBeTruthy();
    delete process.env.OMEM_TEST_SECRET_FOR_SCRIPT;
  });

  it("a failing script says why; a declined one is cancelled", async () => {
    const { app, cards } = setup(["x"]);
    const record = { file_token: "BaseTok", file_type: "bitable", action_list: [{ record_id: "rec1", action: "record_added", after_value: [] }] };
    const failing = saveRule(app, docRule({ trigger: { event: "doc", once: "event", waitMinutes: 0, unless: [] }, conditions: { field: "change.kind", op: "equals", value: "record" }, actions: [{ type: "script", runtime: "node", code: "console.error('boom'); process.exit(3)", timeoutSec: 30, approval: { by: "none" } }] }), "user", "owner");
    onDocEvent(app, "main", "drive.file.bitable_record_changed_v1", record);
    await flushDocEventsForTests(app);
    const r = listRuns(app, { kind: "rule-script" })[0];
    await expect(runScript(app, r)).rejects.toThrow(/退出码 3：boom/);
    expect(all(app.db, "select 1 from notifications where title like '%脚本失败%'")).toHaveLength(1);
    expect(cards).toHaveLength(0);
    // With an approval, “不执行” cancels the run.
    saveRule(app, { ...failing, temporary: undefined, actions: [{ type: "script", runtime: "node", code: "console.log(1)", timeoutSec: 30, approval: { by: "owner" } }] }, "user", "owner");
    onDocEvent(app, "main", "drive.file.bitable_record_changed_v1", record);
    await flushDocEventsForTests(app);
    const waiting = listRuns(app, { kind: "rule-script" }).find((x) => x.status === "queued")!;
    await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: `om_card${cards.length}` }, action: { tag: "button", value: { action: "decline" } } });
    expect(getRun(app, waiting.id).status).toBe("cancelled");
  });
});

describe("documents the bot cannot subscribe to", () => {
  it("are checked on the rule's schedule with the owner's login, and an edit since fires the rule", async () => {
    const { app } = setup(["x"]);
    // Not a manager of the document: Feishu refuses the subscription.
    setLarkClient({ request: async () => { throw Object.assign(new Error("forbidden"), { response: { data: { code: 1069603, msg: "forbidden" } } }); }, im: { message: { create: async () => ({ code: 0, data: {} }) } } }, "ou_bot", "小助理");
    let modified = 1_000;
    let body = "第一节\n第二节";
    const metaCalls: string[] = [];
    setLarkCliForTests(async (args) => {
      if (args[0] === "docs" && args[1] === "+fetch") return { ok: true, data: { document: { content: `<title>差旅报销制度</title>\n${body}`, revision_id: "1", document_id: "DocToken123" } } };
      if (args[0] === "drive" && args[1] === "metas") {
        metaCalls.push(args[4]);
        return { ok: true, data: { metas: [{ doc_token: "DocToken123", latest_modify_time: String(modified), latest_modify_user: "ou_cli_wang" }] } };
      }
      if (args[0] === "auth") return { ok: true, data: { identities: { user: { openId: "ou_owner_cli" } } } };
      return { ok: true, data: {} };
    });
    run(app.db, "insert into lark_people(email, name, cli_open_id, updated_at) values(?,?,?,?)", "wang@example.com", "小王", "ou_cli_wang", new Date().toISOString());
    const rule = saveRule(app, docRule({ trigger: { event: "doc", docs: [LINK], pollMinutes: 10, once: "event", waitMinutes: 0, unless: [] } }), "user", "owner");
    const report = await rulePermissions(app, rule);
    expect(report.issues.some((i) => /每 10 分钟用你的登录查一次/.test(i.problem))).toBe(true);
    // The first look only notes the time.
    expect(await pollRuleDocs(app)).toBe(0);
    expect(one<{ modified_ms: number }>(app.db, "select modified_ms from lark_doc_subscriptions where file_token = 'DocToken123'")!.modified_ms).toBe(1_000_000);
    // Not due again before the rule's interval.
    modified = 2_000;
    body = "第一节\n第二节\n第三节：住宿标准";
    expect(await pollRuleDocs(app)).toBe(0);
    expect(metaCalls).toHaveLength(1);
    run(app.db, "update lark_doc_subscriptions set polled_at = ? where file_token = 'DocToken123'", new Date(Date.now() - 11 * 60_000).toISOString());
    expect(await pollRuleDocs(app)).toBe(1);
    const [fired] = listFirings(app, rule.id);
    expect(fired.summary).toContain("第三节：住宿标准");
    expect(fired.summary).toContain("小王");
    expect(fired.summary).toContain("定时检查发现");
    // Once the bot is subscribed and events arrive, the schedule leaves the document alone.
    run(app.db, "update lark_doc_subscriptions set status = 'ok', last_event_at = ?, polled_at = ? where file_token = 'DocToken123'", new Date().toISOString(), new Date(0).toISOString());
    expect(await pollRuleDocs(app)).toBe(0);
    expect(metaCalls).toHaveLength(2);
  });
});
