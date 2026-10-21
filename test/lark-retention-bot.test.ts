import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { one, all, run } from "../src/core/db.ts";
import { startLarkBot } from "../src/channels/lark-bot.ts";
import { retentionState } from "../src/channels/lark-retention.ts";
import { persistChatMessages } from "../src/channels/lark-messages.ts";

const fake = vi.hoisted(() => ({ handlers: {} as Record<string, (data: any) => Promise<any>>, sent: vi.fn(), get: vi.fn(), resource: vi.fn(), request: vi.fn() }));
vi.mock("@larksuiteoapi/node-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
  return { ...actual,
    Client: class {
      request = fake.request;
      contact = { user: { get: async () => ({ data: { user: { name: "小王" } } }) } };
      im = { messageResource: { get: fake.resource }, chat: { get: async () => ({ data: { name: "工单群" } }) }, message: { get: fake.get, create: fake.sent, reply: fake.sent } };
    },
    EventDispatcher: class { register(handlers: typeof fake.handlers) { fake.handlers = handlers; return this; } },
    WSClient: class { async start() {} },
  };
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); fake.sent.mockReset(); fake.get.mockReset(); fake.resource.mockReset(); fake.request.mockReset(); });

describe("retained chat bot event integration", () => {
  it("captures after owner removal, deduplicates polling and redelivery, refreshes cards and never replies", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OMEM_LARK_APP_SECRET", "test-only");
    const app = testApp();
    app.config.lark.appId = "cli_omem";
    app.config.lark.ownerOpenId = "ou_owner";
    app.config.lark.capture.mentionRetention = { enabled: true, cliOwnerOpenId: "ou_cli_owner", tenantIds: ["100"], chats: [{ chatId: "oc_oncall", tenantId: "100", flowId: "123", evidence: "已核实", related: true }] };
    fake.request.mockResolvedValue({ bot: { open_id: "ou_bot", app_name: "助理" } });
    await startLarkBot(app);
    const m = { message_id: "om_event", chat_id: "oc_oncall", chat_type: "group", message_type: "interactive", create_time: String(Date.now()), content: '{"elements":[{"tag":"markdown","content":"初始卡片"},{"tag":"img","img_key":"img_existing"}]}', thread_id: "omt_thread", parent_id: "om_parent", mentions: [{ id: { open_id: "ou_owner" } }, { id: { open_id: "ou_bot" } }] };
    persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [{ message_id: m.message_id, chat_id: m.chat_id, msg_type: "interactive", create_time: m.create_time, content: "初始卡片" }], resources: new Map([[m.message_id, { img_existing: { type: "image", file: "saved-image.png" } }]]) });
    await fake.handlers["im.message.receive_v1"]({ sender: { sender_id: { open_id: "ou_owner" } }, message: m });
    await vi.waitFor(() => expect(retentionState(app, "oc_oncall")?.botEventAt).toBeTruthy());
    await fake.handlers["im.chat.member.user.deleted_v1"]({ chat_id: "oc_oncall", users: [{ user_id: { open_id: "ou_owner" } }] });
    expect(retentionState(app, "oc_oncall")?.lifecycle).toBe("owner-removed");
    const next = { ...m, message_id: "om_after", mentions: [], message_type: "text", content: '{"text":"离群后消息"}' };
    await fake.handlers["im.message.receive_v1"]({ sender: { sender_id: { open_id: "ou_owner" } }, message: next });
    await vi.waitFor(() => expect(one(app.db, "select 1 from lark_messages where message_id='om_after'")).toBeTruthy());
    persistChatMessages(app, { chatId: "oc_oncall", spaceId: "personal", name: "工单群", messages: [{ message_id: "om_event", chat_id: "oc_oncall", msg_type: "interactive", create_time: m.create_time, content: "用户轮询卡片" }] });
    await fake.handlers["im.message.receive_v1"]({ sender: { sender_id: { open_id: "ou_owner" } }, message: m });
    await vi.advanceTimersByTimeAsync(0);
    expect(one<{content: string}>(app.db, "select content from lark_messages where message_id='om_event'")?.content).toBe("用户轮询卡片");
    expect(all(app.db, "select * from lark_messages")).toHaveLength(2);
    let edited = "编辑卡片";
    fake.get.mockImplementation(async ({ path }) => ({ data: { items: [{ ...m, message_id: path.message_id, msg_type: path.message_id === "om_event" ? "interactive" : "text", body: { content: path.message_id === "om_event" ? JSON.stringify({ elements: [{ tag: "markdown", content: edited }, { tag: "img", img_key: "img_existing" }] }) : '{"text":"离群后消息"}' }, sender: { id: "ou_owner" } }] } }));
    // Drive the registered timer: it enqueues and handles bot-authenticated refreshes.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalled());
    await vi.waitFor(() => expect(one<{ content: string }>(app.db, "select content from lark_messages where message_id='om_event'")?.content).toContain("编辑卡片"));
    expect(one(app.db, "select thread_id,parent_id from lark_messages where message_id='om_event'")).toMatchObject({ thread_id: "omt_thread", parent_id: "om_parent" });
    expect(fake.sent).not.toHaveBeenCalled();
    expect(fake.resource).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(all(app.db, "select 1 from runs where kind='ingest'")).toHaveLength(1);
    const quoteReads = fake.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fake.request).toHaveBeenCalledTimes(quoteReads);
    expect(all(app.db, "select 1 from runs where kind='ingest'")).toHaveLength(1);
    // A legacy/restarted message without an enrichment checkpoint also avoids a no-op ingest.
    run(app.db, "delete from kv where key like 'lark_bot_snapshot:%'");
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(all(app.db, "select 1 from runs where kind='ingest'")).toHaveLength(1);
    edited = "再次编辑卡片";
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(all(app.db, "select 1 from runs where kind='ingest'")).toHaveLength(2);
    expect(one<{ content: string }>(app.db, "select content from lark_messages where message_id='om_event'")?.content).toContain("再次编辑卡片");
  });
  it("keeps later card edits readable when an embedded asset permanently fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OMEM_LARK_APP_SECRET", "test-only");
    const app=testApp();
    app.config.lark.appId="cli_omem";
    app.config.lark.ownerOpenId="ou_owner";
    app.config.lark.capture.mentionRetention={enabled:true,cliOwnerOpenId:"ou_cli_owner",tenantIds:["100"],chats:[{chatId:"oc_oncall",tenantId:"100",flowId:"123",evidence:"已核实",related:true}]};
    fake.request.mockResolvedValue({bot:{open_id:"ou_bot"}});
    fake.resource.mockRejectedValue(new Error("asset permission denied"));
    await startLarkBot(app);
    let body="原始卡片";
    const raw=()=>JSON.stringify({elements:[{tag:"markdown",content:body},{tag:"img",img_key:"img_unreadable"}]});
    const m={message_id:"om_card",chat_id:"oc_oncall",chat_type:"group",message_type:"interactive",create_time:String(Date.now()),content:raw(),mentions:[{id:{open_id:"ou_owner"}}]};
    fake.get.mockImplementation(async()=>({code:0,data:{items:[{...m,msg_type:"interactive",sender:{id:"ou_other"},body:{content:raw()}}]}}));
    await fake.handlers["im.message.receive_v1"]({sender:{sender_id:{open_id:"ou_other"}},message:m});
    await vi.waitFor(()=>expect(one(app.db,"select 1 from kv where key='lark_capture_receipt:om_card'")).toBeTruthy());
    for(let i=0;i<10;i++) {
      run(app.db,"update kv set value=json_set(value,'$.retryAt',0) where key like 'lark_capture_event:resource:%'");
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(()=>expect(one<{attempts:number}>(app.db,"select json_extract(value,'$.attempts') attempts from kv where key like 'lark_capture_event:resource:%'")?.attempts).toBeGreaterThanOrEqual(i+1));
    }
    expect(one(app.db,"select 1 from kv where key like 'lark_capture_event:resource:%' and json_type(value,'$.abandonedAt') is not null")).toBeTruthy();
    const attempts=fake.resource.mock.calls.length;
    body="权限失败之后的新卡片";
    await vi.advanceTimersByTimeAsync(12*60_000);
    await vi.waitFor(()=>expect(one<{content:string}>(app.db,"select content from lark_messages where message_id='om_card'")?.content).toContain(body));
    // A body refresh may make one best-effort asset attempt; the abandoned retry chain never restarts.
    expect(fake.resource.mock.calls.length).toBeLessThanOrEqual(attempts+1);
    expect(one(app.db,"select 1 from kv where key='lark_capture_event:refresh:om_card' and json_type(value,'$.abandonedAt') is not null")).toBeUndefined();
    expect(fake.sent).not.toHaveBeenCalled();
  });

});
