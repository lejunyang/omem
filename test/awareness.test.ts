import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { awarenessNote, checkedBeforeSend, ownerMoves, preSendCheck } from "../src/agents/awareness.ts";
import { recordRunStart, relatedNote, scopeOf } from "../src/agents/run-scope.ts";
import { addRunEvent, createRun, getRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { addMessage, ensureConversation } from "../src/agents/threads.ts";
import { callTool } from "../src/agents/tools.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { all, one, run } from "../src/core/db.ts";
import { createUser, OWNER } from "../src/core/users.ts";
import { candidatesNote, itemPlaces } from "../src/items/places.ts";
import { MENTION_DENY } from "../src/mentions/mentions.ts";
import { upsertSource } from "../src/sources/store.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("runs that know about each other and about the owner", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-aware-"));
  const prompts = join(home, "prompts.jsonl");
  const toolLog = join(home, "tools.jsonl");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      agents: {
        default: "aware",
        profiles: [
          fake("aware", { FAKE_MODE: "aware", FAKE_PROMPT_FILE: prompts, FAKE_TOOL_LOG: toolLog }),
          fake("aware-quiet", { FAKE_MODE: "aware", FAKE_AWARE_QUIET: "1", FAKE_PROMPT_FILE: prompts, FAKE_TOOL_LOG: toolLog }),
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
  beforeEach(() => {
    writeFileSync(prompts, "");
    writeFileSync(toolLog, "");
    app.config.agents.default = "aware";
  });

  const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const until = async (ok: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error("等待超时");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  let seq = 0;
  const gate = () => join(home, `gate${++seq}`);
  /** The owner says something in a Feishu chat (as the capture stores it). */
  const ownerSays = (chatId: string, text: string, over: { thread?: string; parent?: string } = {}) => {
    const id = `om_own${++seq}`;
    run(app.db, "insert into lark_messages(message_id, chat_id, thread_id, parent_id, sender_id, sender_name, sender_kind, content, create_ms) values(?,?,?,?,?,?,?,?,?)", id, chatId, over.thread ?? null, over.parent ?? null, "ou_owner", "本人", "owner", text, Date.now());
    return id;
  };
  /** A run that stays parked (never picked up by the worker), marked running: for checks that need no agent. */
  const parked = (kind: "agent" | "ask" | "mention", input: Record<string, unknown>, title = "后台") => {
    const r = createRun(app, { kind, spaceId: "personal", title, userId: OWNER, input, notBefore: new Date(Date.now() + 10 * 86400_000).toISOString() });
    run(app.db, "update runs set status = 'running', started_at = ?, not_before = null, lane = null where id = ?", new Date().toISOString(), r.id);
    recordRunStart(app, r.id);
    return r.id;
  };
  const scope = { spaces: null, userId: OWNER, lark: { chats: ["oc_team"] } };
  /** A rule's silent run on the team chat: it posts only through tools (checked there). */
  const ruleRun = (task: string) =>
    createRun(app, { kind: "agent", spaceId: "personal", title: "规则：看群", userId: OWNER, input: { spec: "assistant", assistantScope: scope, lark: { chats: ["oc_team"] }, rule: { id: "rule_x", name: "看群" }, silent: { chatId: "oc_team", messageId: "om_t1", topicId: null }, task } });
  const ctx = (runId: string | null, userId = OWNER) => ({ app, runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const, userId });

  it("derives a run's scope from its input and tells it about the other runs on the same chat", async () => {
    const other = parked("agent", { spec: "assistant", mention: { chatId: "oc_team", topicId: null, messageIds: ["om_q9"] }, task: "" }, "有人找你：小王问上线");
    run(app.db, "update runs set output = ? where id = ?", JSON.stringify({ answer: "小王问上线时间：周五可以\n\n细节……" }), other);
    const elsewhere = parked("agent", { spec: "assistant", silent: { chatId: "oc_other", messageId: "om_z", topicId: null }, task: "" }, "别的群");
    const old = parked("agent", { spec: "assistant", silent: { chatId: "oc_team", messageId: "om_old", topicId: null }, task: "" }, "很早的");
    run(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date(Date.now() - 3 * 3600_000).toISOString(), old);
    expect(scopeOf(app, other)).toEqual(expect.arrayContaining([{ kind: "chat", key: "oc_team", topic: "" }, { kind: "message", key: "om_q9", topic: "" }]));

    const r = ruleRun("@call search {\"query\":\"上线\"}");
    expect((await waitForRun(app, r.id)).status).toBe("done");
    const prompt = String(lines(prompts)[0]);
    expect(prompt).toContain("# 同时在办的相关工作");
    expect(prompt).toContain(other);
    expect(prompt).toContain("结论：小王问上线时间：周五可以");
    expect(prompt).not.toContain(elsewhere);
    expect(prompt).not.toContain(old);
    // Nothing shares the other chat's scope: no section at all.
    expect(relatedNote(app, elsewhere)).toBe("");
    for (const id of [other, elsewhere]) run(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date(Date.now() - 3 * 3600_000).toISOString(), id);
  });

  it("checks with the owner's words once before a background run posts, then posts what it decides", async () => {
    const [w1, w2] = [gate(), gate()];
    const r = ruleRun(`@wait ${w1}\n@call notify {"title":"小王问上线","body":"小王问这周能不能上线"}\n@wait ${w2}\n@call notify {"title":"小王问上线（按你说的）","body":"周五上线，先灰度"}`);
    await until(() => existsSync(`${w1}.ready`));
    ownerSays("oc_team", "这个我来回，周五上线");
    writeFileSync(w1, "");
    await until(() => existsSync(`${w2}.ready`));
    ownerSays("oc_team", "补一句：先灰度");
    writeFileSync(w2, "");
    const done = await waitForRun(app, r.id);
    expect(done.status).toBe("done");
    const log = lines(toolLog);
    expect(log[0].text).toContain("先没有发出");
    expect(log[0].text).toContain("这个我来回，周五上线");
    // Only once: the second call goes out, and the newer words come with its result.
    expect(log[1].text).toContain("已通知");
    expect(log[1].text).toContain("本人刚说了");
    expect(log[1].text).toContain("补一句：先灰度");
    expect(all(app.db, "select id from notifications where json_extract(context, '$.runId') = ?", r.id)).toHaveLength(1);
    expect((done.output.awareness as { recheckedAt?: string }).recheckedAt).toBeTruthy();
    expect(checkedBeforeSend(app, r.id)).toBe(true);
  });

  it("hands the owner's words to a running background run at its next tool call, each once", async () => {
    const w = gate();
    const r = ruleRun(`@wait ${w}\n@call search {"query":"上线"}\n@call search {"query":"灰度"}\n@call notify {"title":"上线安排","body":"周五"}`);
    await until(() => existsSync(`${w}.ready`));
    ownerSays("oc_team", "我已经和小王说了周五");
    writeFileSync(w, "");
    expect((await waitForRun(app, r.id)).status).toBe("done");
    const log = lines(toolLog);
    expect(log[0].text).toContain("我已经和小王说了周五");
    expect(log[1].text).not.toContain("我已经和小王说了周五");
    // It knew already: no check before the notification.
    expect(log[2].text).toContain("已通知");
    expect(getRun(app, r.id).output.awareness).not.toHaveProperty("recheckedAt");
  });

  it("checks a handling's final answer when the owner replied to the message meanwhile; it may rewrite or stay quiet", async () => {
    const mention = (id: string) => ({ channel: "lark", from: "r_x", chatId: "oc_team", chatName: "项目 A 讨论群", chatKind: "group", topicId: null, messageIds: [id], lastMessageId: id, senderId: "ou_wang", senderName: "小王", refs: [], reply: "off", urgency: "normal", what: "问上线" });
    const handle = (msg: string, w: string) => createRun(app, { kind: "agent", spaceId: "personal", title: "有人找你：小王", userId: OWNER, input: { spec: "assistant", assistantScope: { spaces: null, userId: OWNER, denyTools: MENTION_DENY, lark: { chats: [] } }, lark: { chats: [] }, task: `@wait ${w}`, mention: mention(msg) } });

    const w = gate();
    const r = handle("om_q1", w);
    await until(() => existsSync(`${w}.ready`));
    // In another topic of the chat, but a reply to the very message: it counts.
    ownerSays("oc_team", "周五上线", { parent: "om_q1", thread: "omt_x" });
    writeFileSync(w, "");
    expect((await waitForRun(app, r.id)).status).toBe("done");
    expect(lines(prompts).some((p) => String(p).includes("# 发出前复核") && String(p).includes("回复了触发你的消息"))).toBe(true);
    const n = one<{ title: string }>(app.db, "select title from notifications where json_extract(context, '$.runId') = ?", r.id);
    expect(n?.title).toContain("复核后的结论");

    app.config.agents.default = "aware-quiet";
    const w2 = gate();
    const q = handle("om_q2", w2);
    await until(() => existsSync(`${w2}.ready`));
    ownerSays("oc_team", "已经回了", { parent: "om_q2" });
    writeFileSync(w2, "");
    const quiet = await waitForRun(app, q.id);
    expect(quiet.status).toBe("done");
    expect(quiet.output.stayQuiet).toBe("本人已经处理了");
    expect(one(app.db, "select 1 from notifications where json_extract(context, '$.runId') = ?", q.id)).toBeUndefined();
  });

  it("checks a conversation's wake-up turn before its answer is posted there", async () => {
    const conv = ensureConversation(app, { spaceId: "personal", channel: "web", title: "等 CI" });
    const w = gate();
    const wake = addMessage(app, conv, "assistant", `助理 设的唤醒到了。备注：看 CI\n@wait ${w}`, null, { wake: { note: "看 CI", setAt: new Date().toISOString(), trigger: null }, record: true });
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "唤醒：看 CI", userId: OWNER, input: { conversationId: conv, messageIds: [wake], wake: true }, lane: conv });
    await until(() => existsSync(`${w}.ready`));
    addMessage(app, conv, "user", "CI 我已经重跑过了，绿了");
    writeFileSync(w, "");
    expect((await waitForRun(app, r.id)).status).toBe("done");
    expect(lines(prompts).some((p) => String(p).includes("# 发出前复核") && String(p).includes("CI 我已经重跑过了"))).toBe(true);
    const last = one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'assistant' order by created_at desc limit 1", conv);
    expect(last?.text).toContain("复核后的结论");
  });

  it("does not check the owner's own turns, and folds the notification gate's signals into the check", async () => {
    // A turn answering the owner: not a background run.
    const conv = ensureConversation(app, { spaceId: "personal", channel: "web", title: "问上线" });
    const said = addMessage(app, conv, "user", "这周能上线吗");
    const turn = parked("ask", { conversationId: conv, messageIds: [said] });
    addMessage(app, conv, "user", "再补一句");
    expect(await preSendCheck(app, turn, "notify", {})).toBeNull();

    // The cited message is already read: the run is told, once, and the push trusts its decision.
    const t = Date.now() - 10 * 60_000;
    const stamp = new Date(t).toISOString().slice(0, 16).replace("T", " ");
    const src = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_read", title: "项目 C 群", text: `[${stamp}] 小王: @本人 周报发了 (om_read1)` });
    setLarkCliForTests(async (args) => (args.includes("+messages-read-status") ? { data: { items: [{ message_id: "om_read1", is_read: true }] } } : { data: { items: [] } }));
    const bg = parked("agent", { spec: "assistant", wake: true, task: "" });
    const first = await preSendCheck(app, bg, "notify", { source_refs: [`src:${src.id}#L1`] });
    expect(first?.text).toContain("本人已经看过");
    expect(checkedBeforeSend(app, bg)).toBe(true);
    expect(await preSendCheck(app, bg, "notify", { source_refs: [`src:${src.id}#L1`] })).toBeNull();
    setLarkCliForTests(null);
  });

  it("links an item to the places where it is written, shows the whole picture, and keeps it to its person", async () => {
    const c1 = ensureConversation(app, { spaceId: "personal", channel: "web", title: "退款口径讨论" });
    const c2 = ensureConversation(app, { spaceId: "personal", channel: "lark", externalId: "oc_team#omt_1", title: "项目 A 群的退款话题" });
    const r1 = parked("ask", { conversationId: c1 });
    const r2 = parked("ask", { conversationId: c2 });
    const made = await callTool(ctx(r1), "upsert_item", { kind: "todo", title: "退款口径要定下来", detail: "只退未发货的行" });
    expect(made.isError).toBe(false);
    const itemId = /事项 (\S+?)：/.exec(made.text)![1];
    expect(made.text).toContain("已把这件事关联到「退款口径讨论」");
    const again = await callTool(ctx(r2), "upsert_item", { id: itemId, note: "群里也在问" });
    expect(again.text).toContain("项目 A 群的退款话题");
    expect(itemPlaces(app, itemId, OWNER).map((p) => p.ref).sort()).toEqual([c1, c2].sort());

    // A run in the first conversation hears where else the item goes on.
    addMessage(app, c2, "assistant", "群里说按未发货行算");
    const r3 = parked("ask", { conversationId: c1 });
    const note = awarenessNote(app, r3);
    expect(note).toContain("# 这件事还在这些会话里进行");
    expect(note).toContain("项目 A 群的退款话题");
    expect(note).toContain("群里说按未发货行算");

    // The whole picture: places and the runs working on it.
    const full = JSON.parse((await callTool(ctx(r3), "read_item", { item_id: itemId })).text);
    expect(full.places.map((p: { ref: string }) => p.ref).sort()).toEqual([c1, c2].sort());
    expect(full.runs.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([r1, r2]));

    // The owner speaking about the item in another conversation reaches a background run that touched it.
    const bg = parked("agent", { spec: "assistant", wake: true, task: "" });
    await callTool(ctx(bg), "read_item", { item_id: itemId });
    addMessage(app, c2, "user", "退款就按未发货的行，定了");
    const moves = ownerMoves(app, bg);
    expect(moves.map((m) => [m.why, m.text])).toEqual([["item", "退款就按未发货的行，定了"]]);

    // Someone else cannot read it.
    const other = createUser(app, { name: "小李" });
    const denied = await callTool(ctx(r3, other.id), "read_item", { item_id: itemId });
    expect(denied.isError).toBe(true);
  });

  it("offers candidate items for a place nothing is linked to yet", async () => {
    const made = await callTool(ctx(null), "upsert_item", { kind: "todo", title: "支付回调重试", detail: "PAY-4821 回调丢失，等支付组排查" });
    const itemId = /事项 (\S+?)：/.exec(made.text)![1];
    const c3 = ensureConversation(app, { spaceId: "personal", channel: "web", title: "新问题" });
    addMessage(app, c3, "user", "PAY-4821 那个回调又丢了，支付组排查到哪了？");
    const r = parked("ask", { conversationId: c3 });
    const note = candidatesNote(app, r, OWNER);
    expect(note).toContain(itemId);
    expect(note).toContain("PAY-4821");
  });

  it("takes over a background run: stops it and hands over what it had", async () => {
    const w = gate();
    const r = ruleRun(`@wait ${w}`);
    await until(() => existsSync(`${w}.ready`));
    addRunEvent(app, r.id, "text", { text: "查到小王的单子卡在支付回调" });
    const conv = ensureConversation(app, { spaceId: "personal", channel: "web", title: "本人问起" });
    const said = addMessage(app, conv, "user", "小王那个单子怎么样了");
    const mine = parked("ask", { conversationId: conv, messageIds: [said] });
    const got = await callTool(ctx(mine), "take_over_run", { run_id: r.id });
    expect(got.isError).toBe(false);
    expect(got.text).toContain("已停下");
    expect(got.text).toContain("查到小王的单子卡在支付回调");
    expect((await waitForRun(app, r.id)).status).toBe("cancelled");
    writeFileSync(w, "");
    // A turn answering the owner is not someone else's background work.
    const refused = await callTool(ctx(r.id), "take_over_run", { run_id: mine });
    expect(refused.isError).toBe(true);
  });
});
