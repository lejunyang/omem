import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/agents/runner.ts";
import { getRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { toolContextForToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { notify } from "../src/core/notify.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { handedToLiaison, queueMentionPrep } from "../src/channels/lark-mentions.ts";
import { persistChatMessages, type LarkMessage } from "../src/channels/lark-messages.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("someone looking for the owner: the liaison reads up before the owner is told", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-mention-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_bot", mentions: { delayMinutes: 0 } },
      agents: {
        default: "fake",
        roles: { liaison: "liaison-ok" },
        profiles: [
          fake("fake", { FAKE_SAY: "好的" }),
          fake("liaison-ok", { FAKE_MODE: "liaison" }),
          fake("liaison-quiet", { FAKE_MODE: "liaison", FAKE_LIAISON: "quiet" }),
          fake("liaison-silent", { FAKE_MODE: "liaison", FAKE_LIAISON: "silent" }),
          fake("liaison-dies", { FAKE_DIE: "1" }),
          fake("liaison-hangs", { FAKE_STALL: "before" }),
        ],
      },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    setLarkCliForTests(null);
    releaseAll();
    server.close();
  });

  const read = new Set<string>();
  beforeEach(() => {
    setLarkCliForTests(async (args) => {
      if (args.includes("+messages-read-status")) {
        const ids = args[args.indexOf("--message-ids") + 1].split(",");
        return { data: { items: ids.map((id) => ({ message_id: id, is_read: read.has(id) })) } };
      }
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_owner" } } } };
      return { data: { messages: [] } };
    });
  });

  let seq = 0;
  const msg = (text: string, over: Partial<LarkMessage> = {}): LarkMessage => ({
    message_id: `om_m${++seq}`,
    chat_id: "oc_team",
    msg_type: "text",
    content: text,
    create_time: String(Date.now()),
    sender: { id: "ou_wang", name: "小王", sender_type: "user" },
    mentions: [{ id: "ou_owner" }],
    ...over,
  });
  const store = (messages: LarkMessage[], chatId = "oc_team") => persistChatMessages(app, { chatId, spaceId: "personal", name: chatId === "oc_team" ? "项目 A 讨论群" : "小王", messages, owner: "ou_owner" });
  const group = { id: "oc_team", name: "项目 A 讨论群", kind: "group" as const };

  it("picks people @-ing the owner (or writing one-to-one), once each, one waiting run per chat", async () => {
    const at = msg("@勒 退款按什么口径算？");
    const notMe = msg("大家看下这个", { mentions: [{ id: "ou_li" }] });
    const bot = msg("值班提醒 @勒", { sender: { id: "cli_other", name: "值班机器人", sender_type: "app" } });
    const own = msg("我看看", { sender: { id: "ou_owner", name: "我", sender_type: "user" } });
    const old = msg("上周的事 @勒", { create_time: String(Date.now() - 2 * 86400_000) });
    store([at, notMe, bot, own, old]);
    app.config.lark.mentions.delayMinutes = 30;
    const r = queueMentionPrep(app, group, [at, notMe, bot, own, old], "ou_owner")!;
    expect(r.kind).toBe("mention-prep");
    expect(r.input.messageIds).toEqual([at.message_id]);
    // Seen again (the bot and the capture both see it): nothing new.
    expect(queueMentionPrep(app, group, [at], "ou_owner")).toBeNull();
    // A later one in the same chat joins the waiting run.
    const more = msg("@勒 还有运费怎么退？");
    store([more]);
    expect(queueMentionPrep(app, group, [more], "ou_owner")!.id).toBe(r.id);
    expect(getRun(app, r.id).input.messageIds).toEqual([at.message_id, more.message_id]);
    // The ingest run on these lines leaves the notification to the liaison.
    const sourceId = one<{ source_id: string }>(app.db, "select source_id from lark_messages where message_id = ?", at.message_id)!.source_id;
    expect(handedToLiaison(app, [sourceId])).toHaveLength(2);
    // One-to-one: every message from the other side.
    const p2p = msg("在吗，问个事", { chat_id: "oc_p2p", mentions: [] });
    store([p2p], "oc_p2p");
    expect(queueMentionPrep(app, { id: "oc_p2p", name: "小王", kind: "p2p" }, [p2p], "ou_owner")).not.toBeNull();
    app.config.lark.mentions.p2p = false;
    const p2p2 = msg("在吗", { chat_id: "oc_p2p", mentions: [] });
    expect(queueMentionPrep(app, { id: "oc_p2p", name: "小王", kind: "p2p" }, [p2p2], "ou_owner")).toBeNull();
    app.config.lark.mentions.p2p = true;
    // Off: nothing.
    app.config.lark.mentions.enabled = false;
    expect(queueMentionPrep(app, group, [msg("@勒 再问一次")], "ou_owner")).toBeNull();
    app.config.lark.mentions.enabled = true;
    // Done with this test's queue: these runs would wait 30 minutes.
    for (const q of all<{ id: string }>(app.db, "select id from runs where kind = 'mention-prep' and status = 'queued'")) run(app.db, "update runs set status = 'cancelled' where id = ?", q.id);
    app.config.lark.mentions.delayMinutes = 0;
  });

  it("the liaison has read tools, no way to post, and notifies with what it found", async () => {
    const prep = prepareRun(app, { actor: { role: "liaison" }, spaceId: "personal", runId: null, lark: { chats: [] } });
    const tools = [...(toolContextForToken(app, prep.token)!.tools ?? [])];
    expect(tools).toEqual(expect.arrayContaining(["read_source", "search", "list_items", "upsert_item", "notify", "stay_quiet", "lark_read"]));
    expect(tools).not.toContain("lark_send");
    expect(tools).not.toContain("lark_write");

    const m = msg("@勒 退款按什么口径算？");
    store([m]);
    // The bot received it too: that records the delivery, it does not mean anyone took it.
    run(app.db, "insert into handled_messages(channel,message_id,rule,at) values('lark-bot',?,'',?)", m.message_id, new Date().toISOString());
    const r = queueMentionPrep(app, group, [m], "ou_owner")!;
    const done = await waitForRun(app, r.id);
    expect(done.status).toBe("done");
    const said = JSON.parse(String(done.output.summary));
    expect(said.read).toBe(true);
    const n = one<{ title: string; body: string; context: string }>(app.db, "select title, body, context from notifications where json_extract(context, '$.runId') = ?", r.id)!;
    expect(n.title).toContain("可直接回");
    expect(n.body).toContain("可以这样回");
    expect(JSON.parse(n.context).sourceRefs[0]).toMatch(/^src:\S+#L\d+$/);
  }, 60000);

  it("a message the owner already read costs no model run", async () => {
    const m = msg("@勒 这个接口谁负责？");
    store([m]);
    read.add(m.message_id);
    const r = queueMentionPrep(app, group, [m], "ou_owner")!;
    const done = await waitForRun(app, r.id);
    expect(done.quiet).toBe(true);
    expect(one(app.db, "select 1 from run_events where run_id = ? and type = 'tool'", r.id)).toBeUndefined();
    expect(one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", r.id)).toBeUndefined();
  }, 30000);

  it("stays quiet when there is nothing for the owner", async () => {
    app.config.agents.roles = { liaison: "liaison-quiet" };
    const m = msg("@勒 群公告：周五发版");
    store([m]);
    const done = await waitForRun(app, queueMentionPrep(app, group, [m], "ou_owner")!.id);
    expect(done.quiet).toBe(true);
    expect(one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", done.id)).toBeUndefined();
  }, 60000);

  it("the short reminder still goes out when the homework says nothing or fails", async () => {
    app.config.agents.roles = { liaison: "liaison-silent" };
    const m = msg("@勒 线上报错了，帮忙看下");
    store([m]);
    const r = await waitForRun(app, queueMentionPrep(app, group, [m], "ou_owner")!.id);
    expect(r.status).toBe("done");
    const n = one<{ title: string; body: string }>(app.db, "select title, body from notifications where json_extract(context, '$.runId') = ?", r.id)!;
    expect(n.title).toBe("小王 在「项目 A 讨论群」找你");
    expect(n.body).toContain("线上报错了");
    expect(n.body).toContain("[原消息](src:");

    app.config.agents.roles = { liaison: "liaison-dies" };
    const m2 = msg("@勒 发布单要你审批");
    store([m2]);
    const failed = await waitForRun(app, queueMentionPrep(app, group, [m2], "ou_owner")!.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("已发出简短提醒");
    expect(one<{ body: string }>(app.db, "select body from notifications where json_extract(context, '$.runId') = ?", failed.id)!.body).toContain("发布单要你审批");

    // Running past its time: the short reminder, and the run says so.
    app.config.agents.roles = { liaison: "liaison-hangs" };
    app.config.lark.mentions.timeoutMinutes = 0.05;
    const m3 = msg("@勒 能帮忙看下这个权限吗");
    store([m3]);
    const late = await waitForRun(app, queueMentionPrep(app, group, [m3], "ou_owner")!.id);
    expect(late.status).toBe("failed");
    expect(late.error).toContain("超过");
    expect(one<{ body: string }>(app.db, "select body from notifications where json_extract(context, '$.runId') = ?", late.id)!.body).toContain("权限");
    app.config.lark.mentions.timeoutMinutes = 10;
    app.config.agents.roles = { liaison: "liaison-ok" };
  }, 90000);

  it("the same chat messages are not notified about twice; a new state replaces the old one", () => {
    const m = msg("@勒 这周能上线吗？");
    const s = store([m]);
    const line = one<{ line: number }>(app.db, "select line from lark_message_lines where message_id = ?", m.message_id)!.line;
    const ref = `src:${s.id}#L${line}`;
    const first = notify(app, { title: "小王问上线时间", body: "…", sourceRefs: [ref] });
    expect(() => notify(app, { title: "小王追问上线", body: "…", sourceRefs: [ref] })).toThrow(/已经提醒过本人/);
    expect(notify(app, { title: "小王问上线时间：周四可上", body: "…", sourceRefs: [ref], replaces: first.id }).replaces).toBe(first.id);
    // A newer message in the same range is news.
    const later = msg("@勒 周四可以吗？");
    store([later]);
    const line2 = one<{ line: number }>(app.db, "select line from lark_message_lines where message_id = ?", later.message_id)!.line;
    expect(notify(app, { title: "小王又问", body: "…", sourceRefs: [`src:${s.id}#L${line}-L${line2}`] }).id).toBeTruthy();
    // Notifications not about chat lines are not affected.
    notify(app, { title: "同步完成", body: "…" });
    notify(app, { title: "同步完成", body: "…" });
  });
});
