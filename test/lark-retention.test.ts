import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";
import { setLarkCliForTests, assertLarkResult } from "../src/channels/lark-cli.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { detectRetention, discoverRetentionChats, inviteRetentionBot, retentionState, retentionLifecycle, saveRetention, setOncallCliForTests } from "../src/channels/lark-retention.ts";
import { persistChatMessages, sourceMessages, storeMessages, type LarkMessage } from "../src/channels/lark-messages.ts";
import { pollLark, setCapturePolicy, setSubscriptions } from "../src/channels/lark-personal.ts";
import { drainCaptureEvents, queueCaptureEvent, queueRetentionRefresh, refreshPageQuery } from "../src/channels/lark-event-queue.ts";

const at = Date.now() - 60_000;
const message = (id = "om_mention", chat = "oc_oncall"): LarkMessage => ({ message_id: id, chat_id: chat, msg_type: "text", content: "请看一下", create_time: String(at), sender: { id: "ou_other", name: "小王" }, mentions: [{ id: "ou_cli_owner" }] });
function setup() {
  const app = testApp();
  app.config.lark.appId = "cli_real_omem";
  app.config.lark.ownerOpenId = "ou_bot_owner";
  const cfg = app.config.lark.capture;
  Object.assign(cfg, { mode: "all", maxChats: 1, quietStop: 1, attachments: false, docs: false, calendar: false, minutes: false });
  cfg.backfill.days = 0;
  cfg.mentionRetention = { enabled: true, cliOwnerOpenId: "ou_cli_owner", tenantIds: ["100"], chats: [{ chatId: "oc_oncall", tenantId: "100", flowId: "123", evidence: "已核实工单映射", related: true }] };
  return app;
}
afterEach(() => { setLarkCliForTests(null); setLarkClient(null); setOncallCliForTests(null); });

describe("explicit owner mention retention", () => {
  it("requires consent, authorized tenant/chat and structured owner mention in the correct namespace", () => {
    const app = setup();
    const m = message();
    app.config.lark.capture.mentionRetention.enabled = false;
    expect(detectRetention(app, m, "ou_cli_owner")).toBe(false);
    app.config.lark.capture.mentionRetention.enabled = true;
    expect(detectRetention(app, { ...m, mentions: [], content: "@ou_cli_owner" }, "ou_cli_owner")).toBe(false);
    expect(detectRetention(app, { ...m, mentions: [{ id: "ou_omem_bot" }] }, "ou_cli_owner")).toBe(false);
    expect(detectRetention(app, m, "ou_different_user")).toBe(false);
    expect(detectRetention(app, message("om_other", "oc_unrelated"), "ou_cli_owner")).toBe(false);
    app.config.lark.capture.mentionRetention.tenantIds = ["200"];
    expect(detectRetention(app, m, "ou_cli_owner")).toBe(false);
    app.config.lark.capture.mentionRetention.tenantIds = ["100"];
    expect(detectRetention(app, m, "ou_cli_owner")).toBe(true);
    expect(detectRetention(app, { ...m, mentions: [{ id: { open_id: "ou_bot_owner" } }] }, "ou_bot_owner", "bot")).toBe(true);
  });

  it("invites the real app as user once across concurrent calls and restart; joined bots are idempotent", async () => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    let joined = false;
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: joined } }) } } });
    const creates: string[][] = [];
    setLarkCliForTests(async args => { creates.push(args); joined = true; return { code: 0, data: {} }; });
    await Promise.all([inviteRetentionBot(app, "oc_oncall", "ou_cli_owner"), inviteRetentionBot(app, "oc_oncall", "ou_cli_owner")]);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("app_id");
    expect(creates[0][creates[0].indexOf("--data") + 1]).toBe('{"id_list":["cli_real_omem"]}');
    expect(creates[0][creates[0].indexOf("--as") + 1]).toBe("user");
    const reopened = new App(app.home, app.config, app.db);
    await inviteRetentionBot(reopened, "oc_oncall", "ou_cli_owner");
    expect(creates).toHaveLength(1);
    expect(retentionState(app, "oc_oncall")?.invite).toBe("joined");
  });

  it.each(["permission", "invalid", "approval"])("persists %s and never loops invitations", async kind => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: false } }) } } });
    let calls = 0;
    setLarkCliForTests(async () => {
      calls++;
      if (kind === "permission") return { code: 232011, msg: "Operator can NOT be out of the chat." };
      return { data: kind === "invalid" ? { invalid_id_list: ["cli_real_omem"] } : { pending_approval_id_list: ["cli_real_omem"] } };
    });
    for (let i = 0; i < 5; i++) {
      const s = retentionState(app, "oc_oncall")!;
      saveRetention(app, { ...s, retryAt: 0 });
      await inviteRetentionBot(app, "oc_oncall", "ou_cli_owner");
    }
    expect(calls).toBe(kind === "approval" ? 1 : 3);
    expect(retentionState(app, "oc_oncall")?.invite).toBe(kind === "approval" ? "approval" : "failed");
    if (kind === "permission") expect(retentionState(app, "oc_oncall")?.inviteError).toContain("232011");
  });

  it("discovers confirmed tenant mappings via official read-only queries; classification changes priority only", async () => {
    const app = setup();
    app.config.lark.capture.mentionRetention.chats = [];
    app.config.lark.capture.mentionRetention.oncallCli = "/opt/tools/bytedcli";
    app.config.lark.capture.mentionRetention.relatedTypeIds = ["8"];
    const calls: string[][] = [];
    setOncallCliForTests(async args => {
      calls.push(args);
      if (args[0] === "flow") return { items: [{ id: "123", tenant_id: "100", oncall_question_type_id: 8 }], total: 1, has_more: false };
      return { flow_id: "123", open_chat_id: "oc_oncall" };
    });
    await discoverRetentionChats(app, ["oc_oncall"]);
    expect(calls.every(c => c[1] === "get" || c[1] === "list")).toBe(true);
    expect(retentionState(app, "oc_oncall")).toBeNull();
    expect(detectRetention(app, message(), "ou_cli_owner")).toBe(true);
  });

  it("discovers before ordinary reads and budgets, captures muted/skipped subscribed groups, and retains failed invitation progress", async () => {
    const app = setup();
    setCapturePolicy(app, "oc_oncall", "skip");
    setSubscriptions(app, [{ chatId: "oc_oncall", name: "工单群", spaceId: "personal" }]);
    const calls: string[] = [];
    const context = message("om_context");
    context.mentions = [];
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: false } }) } } });
    setLarkCliForTests(async args => {
      const sub = args.slice(0, 2).join(" "); calls.push(sub);
      if (sub === "auth status") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (sub === "im +messages-search") return { data: { messages: [message()] } };
      if (sub === "im +chat-messages-list") return { data: { messages: [message(), context] } };
      if (sub === "im +chat-list") return { data: { chats: [{ chat_id: "oc_quiet", name: "普通群", chat_mode: "group" }] } };
      if (sub === "im chat.members") return { code: 232011, msg: "permission denied" };
      return { data: {} };
    });
    await pollLark(app);
    expect(calls.indexOf("im +messages-search")).toBeLessThan(calls.indexOf("im +chat-list"));
    expect(all(app.db, "select * from lark_messages where chat_id='oc_oncall'")).toHaveLength(2);
    expect(retentionState(app, "oc_oncall")).toMatchObject({ attempts: 1, invite: "pending" });
    expect(retentionState(app, "oc_oncall")?.captureAt).toBeTruthy();
    await pollLark(app);
    expect(all(app.db, "select * from lark_messages where chat_id='oc_oncall'")).toHaveLength(2);
    expect(retentionState(app, "oc_oncall")?.attempts).toBe(1);
    const text = one<{ text: string }>(app.db, "select text from sources where uri='lark:oc_oncall'")!.text;
    expect(text.match(/om_mention/g)).toHaveLength(1);
    expect(calls.every(c => !/send|reply/.test(c))).toBe(true);
  });

  it("does not advance discovery on identity/search failure; saved trigger survives unreadable context", async () => {
    const app = setup();
    let auth = false;
    setLarkCliForTests(async args => {
      const sub = args.slice(0, 2).join(" ");
      if (sub === "auth status") return { data: { identities: { user: { openId: auth ? "ou_cli_owner" : undefined } } } };
      if (sub === "im +messages-search") return { data: { messages: [message()] } };
      if (sub === "im +chat-messages-list") throw new Error("user removed");
      return { data: {} };
    });
    await pollLark(app);
    expect(one(app.db, "select value from kv where key='lark_mentions_since_ms'")).toBeUndefined();
    auth = true;
    await pollLark(app);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_mention'")).toBeTruthy();
    expect(retentionState(app, "oc_oncall")?.captureError).toContain("user removed");
    expect(one(app.db, "select 1 from lark_cursors where chat_id='oc_oncall'")).toBeUndefined();
  });

  it("does not swallow partial search pages or failed mapping discovery", async () => {
    const app = setup();
    let fail = true;
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search") {
        if (args.includes("--page-token") && fail) throw new Error("page failed");
        return { data: { messages: [message()], has_more: !args.includes("--page-token"), page_token: "next" } };
      }
      return { data: {} };
    });
    await pollLark(app);
    expect(one(app.db, "select value from kv where key='lark_mentions_since_ms'")).toBeUndefined();
    fail = false;
    await pollLark(app);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_mention'")).toBeTruthy();
  });

  it("shares canonical lines/resources/thread relations across bot, polling and edited cards, including legacy text", () => {
    const app = setup();
    const m = { ...message(), msg_type: "interactive", content: "原卡片", raw_content: '{"body":{"elements":[]}}', thread_id: "omt_topic", parent_id: "om_parent" };
    const save = (x: LarkMessage, resources?: Map<string, any>) => persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [x], resources });
    save(m, new Map([[m.message_id, { image: { type: "image", sourceId: "s_image" } }]]));
    save({ ...m, content: "更新卡片", raw_content: '{"body":{"elements":[1]}}' }, new Map([[m.message_id, { file: { type: "file", sourceId: "s_file" } }]]));
    const rows = all<any>(app.db, "select * from lark_messages where chat_id='oc_oncall'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: "更新卡片", thread_id: "omt_topic", parent_id: "om_parent", raw_content: '{"body":{"elements":[1]}}' });
    expect(Object.keys(JSON.parse(rows[0].resources))).toEqual(["image", "file"]);
    const text = one<{ text: string }>(app.db, "select text from sources where id=?", rows[0].source_id)!.text;
    expect(text.match(/om_mention/g)).toHaveLength(1);
    expect(text).toContain("更新卡片");
    run(app.db, "delete from lark_messages where message_id=?", m.message_id);
    save(m); // legacy text-only source recovery
    expect(one<{ text: string }>(app.db, "select text from sources where uri='lark:oc_oncall'")!.text.match(/om_mention/g)).toHaveLength(1);
  });

  it("distinguishes owner removal, bot removal and true disband; bot events save without a user token and retry after restart", async () => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    retentionLifecycle(app, "oc_oncall", "owner-removed");
    queueCaptureEvent(app, "om_new", message("om_new"));
    await drainCaptureEvents(app, async () => { throw new Error("download failed"); });
    expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(1);
    run(app.db, "update kv set value=json_set(value,'$.retryAt',0) where key like 'lark_capture_event:%'");
    const reopened = new App(app.home, app.config, app.db);
    await drainCaptureEvents(reopened, async m => { persistChatMessages(reopened, { chatId: m.chat_id, spaceId: "personal", name: "工单群", messages: [m] }); });
    expect(one(app.db, "select 1 from lark_messages where message_id='om_new'")).toBeTruthy();
    expect(retentionState(app, "oc_oncall")?.lifecycle).toBe("owner-removed");
    retentionLifecycle(app, "oc_oncall", "bot-removed");
    expect(retentionState(app, "oc_oncall")?.invite).toBe("removed");
    retentionLifecycle(app, "oc_oncall", "disbanded");
    expect(retentionState(app, "oc_oncall")?.lifecycle).toBe("disbanded");
    setLarkCliForTests(async () => { throw new Error("must not invite"); });
    await inviteRetentionBot(app, "oc_oncall", "ou_cli_owner");
  });

  it("keeps API error codes visible and masks credential-shaped values", () => {
    expect(() => assertLarkResult({ code: 232011, msg: "token=private_value denied" })).toThrow(/232011.*已隐藏/);
    expect(() => assertLarkResult({ ok: false, error: { code: 99, message: "denied", log_id: "log-demo" } })).toThrow(/99.*log-demo/);
  });
  it("keeps a completed event receipt across restart so stale redelivery cannot revert an edit", async () => {
    const app = setup();
    const save = async (m: LarkMessage) => { persistChatMessages(app, { chatId: m.chat_id!, spaceId: "personal", name: "工单群", messages: [m] }); };
    queueCaptureEvent(app, "om_mention", message());
    await drainCaptureEvents(app, save);
    await save({ ...message(), content: "编辑后的卡片" });
    const reopened = new App(app.home, app.config, app.db);
    queueCaptureEvent(reopened, "om_mention", message());
    let replayed = false;
    await drainCaptureEvents(reopened, async m => { replayed = true; await save(m); });
    expect(replayed).toBe(false);
    expect(one<{ content: string }>(app.db, "select content from lark_messages where message_id='om_mention'")!.content).toBe("编辑后的卡片");
  });

  it("bounds unknown mapping queries and resumes their position with nullable totals", async () => {
    const app = setup();
    app.config.lark.capture.mentionRetention.chats = [];
    app.config.lark.capture.mentionRetention.oncallCli = "/opt/tools/bytedcli";
    const calls: string[][] = [];
    setOncallCliForTests(async args => {
      calls.push(args);
      if (args[0] === "flow") return { items: Array.from({ length: 10 }, (_, i) => ({ id: String(100 + i), tenant_id: "100" })), total: null, has_more: false };
      const id = args[args.indexOf("--flow-id") + 1];
      return { flow_id: id, open_chat_id: id === "109" ? "oc_oncall" : `oc_other_${id}` };
    });
    await discoverRetentionChats(app, ["oc_oncall"]);
    expect(calls).toHaveLength(6);
    expect(detectRetention(app, message(), "ou_cli_owner")).toBe(false);
    const reopened = new App(app.home, app.config, app.db);
    await discoverRetentionChats(reopened, ["oc_oncall"]);
    expect(calls.filter(c => c[0] === "flow")).toHaveLength(1);
    expect(new Set(calls.filter(c => c[0] === "chat").map(c => c[c.indexOf("--flow-id") + 1])).size).toBe(10);
    expect(detectRetention(reopened, message(), "ou_cli_owner")).toBe(true);
  });

  it("saves confirmed priorities before attempting discovery for unrelated mentions", async () => {
    const app = setup();
    app.config.lark.capture.mentionRetention.oncallCli = "/opt/tools/bytedcli";
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) } } });
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [message(), message("om_unrelated", "oc_unrelated")] } };
      if (args[1] === "+chat-messages-list") return { data: { messages: [message("om_context")] } };
      return { data: {} };
    });
    let queries = 0;
    setOncallCliForTests(async () => {
      queries++;
      expect(one(app.db, "select 1 from lark_messages where message_id='om_mention'")).toBeTruthy();
      expect(one(app.db, "select 1 from lark_messages where message_id='om_context'")).toBeTruthy();
      expect(retentionState(app, "oc_oncall")?.invite).toBe("joined");
      throw new Error("mapping unavailable");
    });
    await pollLark(app);
    expect(queries).toBe(1);
    expect(one(app.db, "select 1 from kv where key='lark_retention_candidate:om_unrelated'")).toBeTruthy();
    expect(one(app.db, "select 1 from lark_messages where message_id='om_unrelated'")).toBeTruthy();
  });

  it("saves context bodies but preserves the chat cursor when a priority attachment download fails", async () => {
    const app = setup();
    app.config.lark.capture.attachments = true;
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) } } });
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [message()] } };
      if (args[1] === "+chat-messages-list") return { data: { messages: [{ ...message("om_attachment"), resources: [{ key: "img_example", error: true }] }] } };
      return { data: {} };
    });
    await pollLark(app);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_attachment'")).toBeTruthy();
    expect(one(app.db, "select 1 from lark_cursors where chat_id='oc_oncall'")).toBeUndefined();
    expect(retentionState(app, "oc_oncall")?.captureError).toContain("附件下载未完成");
  });

  it("recovers an interrupted structured save without duplicate lines or an advanced capture cursor", async () => {
    const app = setup();
    const m = message("om_crash");
    app.db.exec("create trigger fail_message before insert on lark_messages begin select raise(abort,'simulated write failure'); end");
    expect(() => persistChatMessages(app, { chatId: m.chat_id!, spaceId: "personal", name: "工单群", messages: [m] })).toThrow(/simulated/);
    app.db.exec("drop trigger fail_message");
    persistChatMessages(app, { chatId: m.chat_id!, spaceId: "personal", name: "工单群", messages: [m] });
    expect(one<{ text: string }>(app.db, "select text from sources where uri='lark:oc_oncall'")!.text.match(/om_crash/g)).toHaveLength(1);
    expect(all(app.db, "select * from lark_messages where message_id='om_crash'")).toHaveLength(1);
  });

  it.each([undefined, "repeated"])("keeps delivered pages when pagination token is %s without advancing cursors", async token => {
    const app = setup();
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) } } });
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search" || args[1] === "+chat-messages-list") return { data: { messages: [message()], has_more: true, page_token: token } };
      return { data: {} };
    });
    await pollLark(app);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_mention'")).toBeTruthy();
    expect(one(app.db, "select 1 from kv where key='lark_mentions_since_ms'")).toBeUndefined();
    expect(one(app.db, "select 1 from lark_cursors where chat_id='oc_oncall'")).toBeUndefined();
    expect(retentionState(app, "oc_oncall")?.captureError).toContain("分页令牌");
  });

  it("refreshes recent bot messages without user access and keeps bounded refresh progress on restart", async () => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    retentionLifecycle(app, "oc_oncall", "owner-removed");
    saveRetention(app, { ...retentionState(app, "oc_oncall")!, invite: "joined" });
    const messages = Array.from({ length: 22 }, (_, i) => message(`om_${i}`));
    persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages });
    queueRetentionRefresh(app);
    expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(20);
    const reopened = new App(app.home, app.config, app.db);
    queueRetentionRefresh(reopened);
    expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(22);
    await drainCaptureEvents(reopened, async ({ updateId }) => {
      persistChatMessages(reopened, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [{ ...message(updateId), content: "更新卡片" }] });
    });
    expect(all(app.db, "select 1 from lark_messages where content='更新卡片'")).toHaveLength(22);
    queueRetentionRefresh(reopened);
    expect(all(app.db, "select 1 from kv where key like 'lark_capture_event:%' and json_type(value,'$.data') is not null")).toHaveLength(0);
    retentionLifecycle(app, "oc_oncall", "bot-removed");
    queueRetentionRefresh(reopened, Date.now() + 11 * 60_000);
    expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(0);
    retentionLifecycle(app, "oc_oncall", "disbanded");
    retentionLifecycle(app, "oc_oncall", "owner-removed");
    expect(retentionState(app, "oc_oncall")?.lifecycle).toBe("disbanded");
  });
  it("bounds bot failures, gates unreadable chats and keeps receipts outside the active queue", async () => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [message()] });
    for (const invite of ["pending", "approval", "failed"] as const) {
      saveRetention(app, { ...retentionState(app, "oc_oncall")!, invite });
      queueRetentionRefresh(app);
      expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(0);
    }
    saveRetention(app, { ...retentionState(app, "oc_oncall")!, invite: "joined" });
    queueRetentionRefresh(app);
    let calls = 0;
    for (let i = 0; i < 12; i++) {
      run(app.db, "update kv set value=json_set(value,'$.retryAt',0) where key like 'lark_capture_event:%'");
      await drainCaptureEvents(new App(app.home, app.config, app.db), async () => { calls++; throw new Error("deleted or forbidden"); });
    }
    expect(calls).toBe(10);
    expect(one(app.db, "select 1 from kv where key like 'lark_capture_event:%' and json_type(value,'$.abandonedAt') is not null")).toBeTruthy();
    queueRetentionRefresh(app, Date.now() + 11 * 60_000);
    expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(1);
    queueCaptureEvent(app, "om_receipt", { message_id: "om_receipt" });
    await drainCaptureEvents(app, async () => {});
    expect(one(app.db, "select 1 from kv where key='lark_capture_receipt:om_receipt'")).toBeTruthy();
    queueCaptureEvent(app, "om_receipt", {});
    expect(one(app.db, "select 1 from kv where key='lark_capture_event:om_receipt'")).toBeUndefined();
  });

  it("deletes successful refresh jobs across repeated rounds rather than accumulating bucket receipts", async () => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    saveRetention(app, { ...retentionState(app, "oc_oncall")!, invite: "joined" });
    persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [message()] });
    for (let i = 0; i < 30; i++) {
      queueRetentionRefresh(app, Date.now() + i * 11 * 60_000);
      expect(all(app.db, "select key from kv where key like 'lark_capture_event:%'")).toHaveLength(1);
      await drainCaptureEvents(app, async () => {});
      expect(all(app.db, "select key from kv where key like 'lark_capture_event:%' or key like 'lark_capture_receipt:%'")).toHaveLength(0);
    }
  });

  it("resumes bounded main and topic pages across polls without starving ordinary subscriptions", async () => {
    const app = setup();
    app.config.lark.capture.mode = "subscribed";
    setSubscriptions(app, [{ chatId: "oc_ordinary", name: "普通群", spaceId: "personal" }]);
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) } } });
    let ordinary = 0;
    const main: string[] = [];
    const topic: string[] = [];
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [message()] } };
      const token = args.includes("--page-token") ? args[args.indexOf("--page-token") + 1] : "0";
      if (args[1] === "+chat-messages-list") {
        if (args[args.indexOf("--chat-id") + 1] === "oc_ordinary") { ordinary++; return { data: { messages: [] } }; }
        main.push(token);
        const page = Number(token);
        return { data: { messages: [{ ...message(`om_main_${page}`), thread_id: "omt_topic" }], has_more: page < 6, page_token: String(page + 1) } };
      }
      if (args[1] === "+threads-messages-list") {
        topic.push(token);
        const page = Number(token);
        return { data: { messages: [message(`om_reply_${page}`)], has_more: page < 6, page_token: String(page + 1) } };
      }
      return { data: {} };
    });
    await pollLark(app);
    expect(main).toEqual(["0", "1", "2", "3", "4"]);
    expect(ordinary).toBe(1);
    expect(one(app.db, "select 1 from lark_cursors where chat_id='oc_oncall'")).toBeUndefined();
    const reopened = new App(app.home, app.config, app.db);
    await pollLark(reopened);
    expect(main).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(topic).toEqual(["0", "1", "2", "3", "4"]);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_reply_4'")).toBeTruthy();
    await pollLark(reopened);
    expect(topic).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(ordinary).toBe(3);
    expect(one(app.db, "select 1 from kv where key='lark_priority_scan:oc_oncall'")).toBeUndefined();
    expect(retentionState(app, "oc_oncall")?.captureAt).toBeTruthy();
  });

  it("keeps topic bodies when the next page fails and stops descending at the time window", async () => {
    const app = setup();
    app.config.lark.capture.mode = "subscribed";
    let fail = true;
    let topicCalls = 0;
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) } } });
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [message()] } };
      if (args[1] === "+chat-messages-list") return { data: { messages: [{ ...message("om_root"), thread_id: "omt_topic" }] } };
      if (args[1] === "+threads-messages-list") {
        topicCalls++;
        if (args.includes("--page-token")) {
          if (fail) throw new Error("topic page unavailable");
          return { data: { messages: [{ ...message("om_ancient"), create_time: String(at - 100 * 3600_000) }], has_more: true, page_token: "older" } };
        }
        return { data: { messages: [message("om_reply")], has_more: true, page_token: "next" } };
      }
      return { data: {} };
    });
    await pollLark(app);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_reply'")).toBeTruthy();
    expect(one(app.db, "select 1 from lark_cursors where chat_id='thread:oc_oncall:omt_topic'")).toBeUndefined();
    fail = false;
    await pollLark(new App(app.home, app.config, app.db));
    expect(topicCalls).toBe(3);
    expect(one(app.db, "select 1 from lark_messages where message_id='om_ancient'")).toBeUndefined();
    expect(one(app.db, "select 1 from kv where key='lark_priority_scan:oc_oncall'")).toBeUndefined();
  });

  it("falls back to ordinary subscriptions on CLI identity mismatch", async () => {
    const app = setup();
    detectRetention(app, message(), "ou_cli_owner");
    setSubscriptions(app, [{ chatId: "oc_oncall", name: "工单群", spaceId: "personal" }]);
    let reads = 0;
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_another" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [] } };
      if (args[1] === "+chat-messages-list") { reads++; return { data: { messages: [message("om_normal")] } }; }
      if (args[1] === "+chat-list") return { data: { chats: [] } };
      return { data: {} };
    });
    await pollLark(app);
    expect(reads).toBe(1);
    expect(retentionState(app, "oc_oncall")?.captureError).toContain("CLI 身份");
    expect(retentionState(app, "oc_oncall")?.attempts).toBe(0);
  });

  it("displays context by message time while retaining citation line numbers", () => {
    const app = setup();
    const latest = message("om_latest");
    const earlier = { ...message("om_earlier"), create_time: String(at - 60_000) };
    const result = persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [latest] });
    persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [earlier] });
    expect(sourceMessages(app, result.id!).messages.map(m => [m.id, m.line])).toEqual([["om_earlier", 2], ["om_latest", 1]]);
  });

  it("shares the twenty-request priority budget across chats and resumes remaining topics", async () => {
    const app = setup();
    const rule = app.config.lark.capture.mentionRetention;
    rule.chats.push({ ...rule.chats[0]!, chatId: "oc_second", flowId: "456" });
    app.config.lark.capture.mode = "subscribed";
    let calls = 0;
    setLarkClient({ im: { chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) } } });
    setLarkCliForTests(async args => {
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_cli_owner" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [message(), message("om_second", "oc_second")] } };
      if (args[1] === "+chat-messages-list") {
        calls++;
        const chat = args[args.indexOf("--chat-id") + 1];
        return { data: { messages: Array.from({ length: 15 }, (_, i) => ({ ...message(`${chat}_${i}`, chat), thread_id: `${chat}_topic_${i}` })) } };
      }
      if (args[1] === "+threads-messages-list") { calls++; return { data: { messages: [] } }; }
      return { data: {} };
    });
    await pollLark(app);
    expect(calls).toBe(20);
    expect(all(app.db, "select key from kv where key like 'lark_priority_scan:%'")).toHaveLength(2);
    calls = 0;
    await pollLark(new App(app.home, app.config, app.db));
    expect(calls).toBe(12);
    expect(all(app.db, "select key from kv where key like 'lark_priority_scan:%'")).toHaveLength(0);
  });

  it("returns source write status and expires refresh checkpoints by message age", () => {
    const app = setup();
    const input = { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [message()] };
    expect(persistChatMessages(app, input).status).toBe("created");
    expect(persistChatMessages(app, input).status).toBe("unchanged");
    expect(persistChatMessages(app, { ...input, messages: [{ ...message(), content: "已修改" }] }).status).toBe("updated");
    persistChatMessages(app, { ...input, messages: [{ ...message("om_old"), create_time: String(at - 73 * 3600_000) }] });
    for (const prefix of ["lark_bot_refresh:", "lark_bot_snapshot:"]) {
      for (const id of ["om_mention", "om_old", "om_missing"]) run(app.db, "insert into kv(key,value) values(?,?)", prefix + id, String(Date.now()));
    }
    queueRetentionRefresh(app);
    expect(all<{key: string}>(app.db, "select key from kv where key like 'lark_bot_refresh:%' or key like 'lark_bot_snapshot:%'").map(r => r.key).sort()).toEqual(["lark_bot_refresh:om_mention", "lark_bot_snapshot:om_mention"]);
  });

  it("uses an indexed bounded chat page despite large unrelated message and receipt tables", () => {
    const app=setup();
    detectRetention(app,message(),"ou_cli_owner");
    saveRetention(app,{...retentionState(app,"oc_oncall")!,invite:"joined"});
    app.db.exec(`with recursive n(i) as (select 1 union all select i+1 from n where i<20000)
      insert into lark_messages(message_id,chat_id,create_ms) select 'om_unrelated_'||i,'oc_unrelated',${at} from n`);
    app.db.exec(`with recursive n(i) as (select 1 union all select i+1 from n where i<100)
      insert into lark_messages(message_id,chat_id,create_ms) select 'om_retained_'||i,'oc_oncall',${at} from n`);
    const plan=all<{detail:string}>(app.db,`explain query plan ${refreshPageQuery}`,"oc_oncall",0,"",at-1000,20).map(r=>r.detail).join(" ");
    expect(plan).toMatch(/SEARCH.*lark_messages_chat_cursor/);
    expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    for(let i=1;i<=5;i++) {
      queueRetentionRefresh(app);
      expect(all(app.db,"select 1 from kv where key>='lark_capture_event:' and key<'lark_capture_event;'")).toHaveLength(i*20);
    }
  });

});
