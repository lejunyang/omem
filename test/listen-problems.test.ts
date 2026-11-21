import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { __testHandlers, createRun, getRun } from "../src/agents/runs.ts";
import { findThread, threadMessages } from "../src/agents/threads.ts";
import { watchedNote } from "../src/agents/sessions.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { routeWatchedMessages } from "../src/channels/lark-watch.ts";
import { chatListened, getContext, releaseAdopted, saveContext } from "../src/channels/listen.ts";
import { followProblemMessages, problemsDue, problemsOf, problemsText, trackProblem } from "../src/channels/listen-problems.ts";
import { coachTask } from "../src/channels/listen-coach.ts";
import { runActions } from "../src/rules/actions.ts";
import { saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

const msgEvent = (id: string, chatId: string, text: string): RuleEvent => ({
  key: `lark:${id}`, kind: "message", at: new Date().toISOString(), via: "capture",
  chat: { id: chatId, name: "工单 123 群", kind: "group" }, sender: { name: "小王", kind: "user" },
  message: { id, text, type: "text", mentionsOwner: false, mentionsBot: false },
});
/** A turn of a 关注's conversation (what track_problem is called from). */
const turnOf = (app: App, conversationId: string) => createRun(app, { kind: "ask", title: "一批群消息", lane: conversationId, input: { conversationId }, notBefore: new Date(Date.now() + 86400_000).toISOString() }).id;
const waiting = { title: "小王的员工号解绑不了", state: "waiting" as const, awaiting: "值班同学清理残留关系", done_when: "清理完，再查员工列表里没有这条关系" };

describe("在跟的问题", () => {
  it("track_problem: a 关注's turn or a 有人找你 handling, in its own groups; what open, waiting and closed need", async () => {
    const app = testApp(); apps.push(app);
    const c = saveContext(app, { kind: "place", name: "值班", chats: ["oc_a", "oc_b"] });
    const turn = turnOf(app, c.conversationId!);
    await expect(trackProblem(app, turn, waiting)).rejects.toThrow("chat_id");
    await expect(trackProblem(app, turn, { ...waiting, chat_id: "oc_other" })).rejects.toThrow("不是这次处理的群");
    await expect(trackProblem(app, turn, { ...waiting, chat_id: "oc_a", awaiting: undefined })).rejects.toThrow("awaiting");
    await expect(trackProblem(app, turn, { ...waiting, chat_id: "oc_a", done_when: undefined })).rejects.toThrow("done_when");
    await expect(trackProblem(app, turn, { title: "x", state: "closed", chat_id: "oc_a" })).rejects.toThrow("conclusion");
    await expect(trackProblem(app, turn, { ...waiting, chat_id: "oc_a", recheck_after: "1m" })).rejects.toThrow("至少十分钟");
    expect(await trackProblem(app, turn, { ...waiting, chat_id: "oc_a", recheck_after: "2h" })).toContain("记为在等");
    const [p] = problemsOf(app, c.id);
    expect(p).toMatchObject({ chatId: "oc_a", topicId: "", state: "waiting", rounds: 1, runId: turn });
    expect(Date.parse(p.recheckAt!)).toBeGreaterThan(Date.now() + 3600_000);

    // The next turn updates the same problem (another round); done_when carries over.
    const next = turnOf(app, c.conversationId!);
    await trackProblem(app, next, { title: waiting.title, state: "closed", chat_id: "oc_a", conclusion: "清理完了，小王确认能解绑" });
    expect(problemsOf(app, c.id)).toMatchObject([{ state: "closed", rounds: 2, doneWhen: waiting.done_when, recheckAt: null, awaiting: "" }]);
    // A different problem there later: a row of its own, the closed one kept (listen-coach learns from it).
    await trackProblem(app, turnOf(app, c.conversationId!), { title: "小李看不到线索", state: "open", chat_id: "oc_a", done_when: "小李能看到线索" });
    expect(problemsOf(app, c.id).map((x) => [x.title, x.state])).toEqual([["小李看不到线索", "open"], [waiting.title, "closed"]]);
    expect(problemsText(app, c.id, ["oc_a"])).toContain("【还在查】小李看不到线索");

    // Not a 关注's turn nor a handling: refused.
    const other = createRun(app, { kind: "agent", title: "别的", input: { spec: "assistant", task: "x" } }).id;
    await expect(trackProblem(app, other, { ...waiting, chat_id: "oc_a" })).rejects.toThrow("只有关注的处理");
    // A handling of 有人找你: its chat and topic, on the built-in context.
    const handling = createRun(app, { kind: "agent", title: "有人找你", input: { spec: "assistant", task: "x", mention: { chatId: "oc_team", topicId: "omt_1" } } }).id;
    await trackProblem(app, handling, waiting);
    expect(problemsOf(app, "listen_default")).toMatchObject([{ chatId: "oc_team", topicId: "omt_1", state: "waiting" }]);
  });

  it("the tool: in the wake group, given to a 关注's turns and to handlings", async () => {
    const app = testApp(); apps.push(app);
    const c = saveContext(app, { kind: "place", name: "值班", chats: ["oc_a"] });
    const turn = turnOf(app, c.conversationId!);
    const tools = toolContextForToken(app, issueToolToken({ runId: turn, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const r = await callTool(tools, "track_problem", { ...waiting });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("之后这个群的消息会带着这个问题的状态给你看");
  });

  it("a 关注 reads new messages against its problems; a recheck comes into its conversation", async () => {
    const app = testApp(); apps.push(app);
    const c = saveContext(app, { kind: "place", name: "值班", chats: ["oc_a"], knobs: { reply: "none" } });
    await trackProblem(app, turnOf(app, c.conversationId!), { ...waiting, recheck_after: "30m" });
    await routeWatchedMessages(app, "oc_a", "值班群", [{ id: "om_1", time: String(Date.now()), sender: "小李", text: "清理好了" }]);
    const t = findThread(app, c.conversationId!)!;
    const note = await watchedNote(app, t, threadMessages(app, t.id));
    expect(note).toContain("你在这些群里跟着的问题");
    expect(note).toContain("【在等】小王的员工号解绑不了");
    expect(note).toContain("在等：值班同学清理残留关系");
    expect(note).toContain("按问题跟，不按消息跟");
    expect(note).toContain("用 track_problem 记下它现在的状态");

    // Its time to look again: a note for the handler, once.
    expect(await problemsDue(app, new Date(Date.now() + 3600_000).toISOString())).toBe(1);
    expect(await problemsDue(app, new Date(Date.now() + 3600_000).toISOString())).toBe(0);
    const last = threadMessages(app, t.id).at(-1)!;
    expect(last.text).toContain("到了定的回查时间");
    expect(last.meta).toMatchObject({ addressed: true, chatId: "oc_a" });
    expect(await watchedNote(app, t, [last])).toContain("这一轮是定好的回查");
  });

  it("有人找你: new messages where a problem is open queue one follow-up a while later; our own posts and old messages do not", async () => {
    const app = testApp(); apps.push(app);
    app.config.lark.appId = "cli_bot";
    const handling = createRun(app, { kind: "agent", title: "有人找你", input: { spec: "assistant", task: "x", mention: { chatId: "oc_team", topicId: "omt_1" } } }).id;
    await trackProblem(app, handling, waiting);
    const at = String(Date.now() + 1000);
    expect(followProblemMessages(app, "oc_team", [{ id: "om_bot", time: at, senderId: "cli_bot", topicId: "omt_1" }], {})).toBe(0);
    expect(followProblemMessages(app, "oc_team", [{ id: "om_x", time: at, senderId: "ou_li", topicId: "omt_other" }], {})).toBe(0);
    expect(followProblemMessages(app, "oc_team", [{ id: "om_old", time: String(Date.now() - 3600_000), senderId: "ou_li", topicId: "omt_1" }], {})).toBe(0);
    expect(followProblemMessages(app, "oc_team", [{ id: "om_2", time: at, senderId: "ou_li", topicId: "omt_1" }], {})).toBe(1);
    expect(followProblemMessages(app, "oc_team", [{ id: "om_3", time: at, senderId: "ou_li", topicId: "omt_1" }], {})).toBe(0);
    const [f] = all<{ id: string; not_before: string }>(app.db, "select id, not_before from runs where kind = 'problem-follow'");
    expect(Date.parse(f.not_before)).toBeGreaterThan(Date.now() + 5 * 60_000);
    // Looked at with nothing in lark_messages yet (the mention flow took the rest): quiet.
    const out = await __testHandlers.get("problem-follow")!({ app, run: getRun(app, f.id), signal: new AbortController().signal, event: () => {}, output: () => {} } as never);
    expect(out).toMatchObject({ quiet: true });
    // A recheck of a 有人找你 problem goes back to its handling, through the same follow-up.
    run(app.db, "update runs set status = 'done' where id = ?", f.id);
    run(app.db, "update listen_problems set recheck_at = ?", new Date(Date.now() - 1000).toISOString());
    expect(await problemsDue(app)).toBe(1);
    expect(one<{ input: string }>(app.db, "select input from runs where kind = 'problem-follow' and status = 'queued'")!.input).toContain('"recheck":true');
  });

  it("a rule's group adopted into a 关注 comes with its later messages, and goes back once its problems are closed and it went quiet", async () => {
    const app = testApp(); apps.push(app);
    const c = saveContext(app, { kind: "place", name: "值班", chats: ["oc_ops"], knobs: { reply: "draft" } });
    const rule = saveRule(app, { name: "新工单群", description: "新的工单群交给值班关注", enabled: true, judge: "code", conditions: { field: "message.text", op: "contains", value: "工单" }, actions: [{ type: "context", context: c.id, adopt: true }] });
    const [r] = await runActions(app, rule, msgEvent("om_t1", "oc_t1", "工单 123：员工号解绑不了"), "");
    expect(r.detail).toBe("交给关注「值班」，并把这个群收进关注");
    const now = getContext(app, c.id)!;
    expect(now.chats).toEqual(["oc_ops", "oc_t1"]);
    expect(Object.keys(now.adopted ?? {})).toEqual(["oc_t1"]);
    expect(chatListened(app, "oc_t1")).toBe(true);
    const [first] = threadMessages(app, c.conversationId!);
    expect(first.text).not.toContain("不是这个关注的群");
    expect(first.meta).toMatchObject({ chatId: "oc_t1" });
    // Its later messages reach the 关注 like its own groups'.
    await routeWatchedMessages(app, "oc_t1", "工单 123 群", [{ id: "om_t2", time: String(Date.now()), sender: "小王", text: "补充一下截图" }]);
    expect(threadMessages(app, c.conversationId!)).toHaveLength(2);
    // Again: no second copy of the group.
    await runActions(app, rule, msgEvent("om_t3", "oc_t1", "工单 123 还在吗"), "");
    expect(getContext(app, c.id)!.chats).toEqual(["oc_ops", "oc_t1"]);

    await trackProblem(app, turnOf(app, c.conversationId!), { ...waiting, chat_id: "oc_t1" });
    const later = Date.now() + 4 * 86400_000;
    expect(releaseAdopted(app, later)).toEqual([]);
    await trackProblem(app, turnOf(app, c.conversationId!), { title: waiting.title, state: "closed", chat_id: "oc_t1", conclusion: "清理完了" });
    expect(releaseAdopted(app, Date.now() + 86400_000)).toEqual([]);
    expect(releaseAdopted(app, later)).toEqual([{ context: c.id, chat: "oc_t1" }]);
    expect(getContext(app, c.id)).toMatchObject({ chats: ["oc_ops"] });
    expect(getContext(app, c.id)!.adopted).toBeUndefined();
    expect(chatListened(app, "oc_t1")).toBe(false);
  });

  it("listen-coach learns how far to follow from the problems it followed", async () => {
    const app = testApp(); apps.push(app);
    const c = saveContext(app, { kind: "place", name: "值班", chats: ["oc_a"] });
    await trackProblem(app, turnOf(app, c.conversationId!), { ...waiting });
    await trackProblem(app, turnOf(app, c.conversationId!), { title: waiting.title, state: "closed", conclusion: "清理完了，小王确认能解绑" });
    const task = coachTask(app, getContext(app, c.id)!);
    expect(task).toContain("## 跟过的问题");
    expect(task).toContain("已结，跟了 2 轮");
    expect(task).toContain(`当时定的“怎样算完”：${waiting.done_when}`);
    expect(task).toContain("结论：清理完了，小王确认能解绑");
  });
});
