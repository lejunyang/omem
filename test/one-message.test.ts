import { afterEach, describe, expect, it } from "vitest";
import { createAsk } from "../src/agents/asks.ts";
import { hostToldOwner, reportedSince } from "../src/agents/code-chain.ts";
import { mayStayQuiet } from "../src/agents/quiet.ts";
import { getRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { WAKE_NOTE } from "../src/agents/wakes.ts";
import { one, run } from "../src/core/db.ts";
import { notify } from "../src/core/notify.ts";
import { alreadySaid, foldIntoAsk } from "../src/channels/lark-asks.ts";
import { recordInteraction, setLarkClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

/**
 * One matter, one message: what the owner already has on a card is not said again in another message
 * (the answer after a question card, the coding handoff after the host's own card).
 */

/** Let the asks' and notifications' sinks finish before the database closes. */
const settle = () => new Promise((r) => setTimeout(r, 100));
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
function addRun(app: ReturnType<typeof testApp>, id: string, kind: string, input: Record<string, unknown>, opts: { status?: string; created?: string; finished?: string | null; output?: Record<string, unknown> } = {}) {
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,output,created_at,finished_at) values(?,?,?,?,?,?,?,?,?)",
    id, kind, "personal", opts.status ?? "done", id, JSON.stringify(input), JSON.stringify(opts.output ?? {}), opts.created ?? at(-60), opts.finished ?? null);
}

const QUESTION = "是否批准按以下参数执行一次生产清理？\n\n| 项目 | 本次范围 |\n|---|---|\n| 员工 UID | 1001 |\n| 服务 / 方法 | refund.admin / WriteOff |\n| 环境 | prod |\n\n影响：清理该员工的有效状态，资料里的手机号置空。批准后先重查状态，再调用一次接口并保留 LogID，最后请小王刷新后台确认名额释放。";

describe("an answer after its own question card", () => {
  afterEach(() => setLarkClient(null));

  it("measures how much of the answer the question already says", () => {
    const repeat = "参数已核对，审批卡已发给你。\n\n| 项目 | 本次参数 |\n|---|---|\n| 服务 | refund.admin / WriteOff |\n| 员工 UID | 1001 |\n| 环境 | prod |\n\n影响：清理该员工的有效状态，手机号置空。批准后先重查状态，再调用一次接口并保留 LogID，最后请小王刷新后台确认名额释放。";
    expect(alreadySaid(repeat, QUESTION)).toBeGreaterThan(0.4);
    expect(alreadySaid("另外查到上周同样的问题是缓存没清，清掉后用户确认恢复，这次大概率也是同一个原因，等你批准后一并处理掉。", QUESTION)).toBeLessThan(0.2);
  });

  it("goes into the card when it repeats it or only points at it; anything else is sent", async () => {
    const app = testApp();
    const patches: any[] = [];
    setLarkClient({ im: { message: { patch: async (a: any) => { patches.push(a); return { code: 0 }; } } } } as never);
    try {
      const t = createThread(app, { spaceId: "personal", channel: "lark", userId: "owner" });
      addRun(app, "r_ask", "ask", { conversationId: t.id }, { status: "running" });
      const ask = createAsk(app, { runId: "r_ask", conversationId: t.id, userId: "owner", question: QUESTION, options: [{ label: "批准" }, { label: "暂不执行" }] });
      const inter = recordInteraction(app, { messageId: "om_card", chatId: "oc_chat", conversationId: t.id, runId: "r_ask", purpose: "ask", allowed: [], payload: { askId: ask.id } });
      // Elsewhere, or about something new: sent as usual.
      expect(await foldIntoAsk(app, "r_ask", "oc_other", "审批卡已发给你")).toBeNull();
      expect(await foldIntoAsk(app, "r_ask", "oc_chat", "另外查到上周同样的问题是缓存没清，清掉后用户确认恢复，这次大概率也是同一个原因，等你批准后一并处理掉，不用再单独排查。")).toBeNull();
      expect(patches).toHaveLength(0);
      // Only pointing at the card: into it, folded, the buttons still bound to the same interaction.
      expect(await foldIntoAsk(app, "r_ask", "oc_chat", "审批卡已发给你，批准后执行。")).toBe("om_card");
      expect(patches).toHaveLength(1);
      const card = patches[0].data.content as string;
      expect(card).toContain("这一轮的说明");
      expect(card).toContain(`__${inter}`);
      expect(JSON.parse(one<{ payload: string }>(app.db, "select payload from card_interactions where id = ?", inter)!.payload).note).toContain("审批卡已发给你");
      // Answered: nothing to fold into.
      run(app.db, "update asks set status = 'answered' where id = ?", ask.id);
      expect(await foldIntoAsk(app, "r_ask", "oc_chat", "审批卡已发给你。")).toBeNull();
    } finally { await settle(); app.db.close(); }
  });
});

describe("a coding round's result handed to the assistant", () => {
  it("is not reported again when a turn about the same work already told the owner after the round ended", () => {
    const app = testApp();
    try {
      const t = createThread(app, { spaceId: "personal", channel: "lark", userId: "owner" });
      addRun(app, "r_round7", "code", {}, { created: at(-50), finished: at(-10) });
      const handoff = { kind: "code", runId: "r_round7", workId: "r_work" };
      // A wake-up set to check on the round, ended after it: it reported.
      const note = addMessage(app, t.id, "assistant", "唤醒：看一下交办 r_work 第 7 轮 r_round7 的结果", null, { wake: { note: "r_round7" }, record: true });
      addRun(app, "r_wake", "ask", { conversationId: t.id, messageIds: [note], wake: true }, { created: at(-12), finished: at(-8), output: { answer: "第 7 轮做完了" } });
      expect(reportedSince(app, t.id, handoff, "r_handoff")).toBe("r_wake");
      // One that stayed quiet, or was about something else, does not count.
      run(app.db, "update runs set output = ? where id = 'r_wake'", JSON.stringify({ quiet: true }));
      expect(reportedSince(app, t.id, handoff, "r_handoff")).toBeNull();
      const other = addMessage(app, t.id, "user", "帮我查下退款口径", null, {});
      addRun(app, "r_other", "ask", { conversationId: t.id, messageIds: [other] }, { created: at(-9), finished: at(-5) });
      expect(reportedSince(app, t.id, handoff, "r_handoff")).toBeNull();
      // Ended before the round did: it could not have told the result.
      run(app.db, "update runs set output = '{}', finished_at = ? where id = 'r_wake'", at(-20));
      expect(reportedSince(app, t.id, handoff, "r_handoff")).toBeNull();
    } finally { app.db.close(); }
  });

  it("knows the host's own cards about the round and may then stay quiet", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { spaceId: "personal", channel: "lark", userId: "owner" });
      addRun(app, "r_round6", "code", {}, { created: at(-50), finished: at(-1) });
      const handoff = { kind: "code", runId: "r_round6", workId: "r_work" };
      addRun(app, "r_handoff", "ask", { conversationId: t.id, messageIds: [], handoff });
      expect(hostToldOwner(app, handoff)).toEqual([]);
      expect(mayStayQuiet(app, getRun(app, "r_handoff"))).toBe(false);
      createAsk(app, { runId: "r_round6", conversationId: t.id, userId: "owner", question: "**需求做完了：退款改造**\n\n评审还提了 1 个问题待改", options: [{ label: "先推送验证" }, { label: "剩下的以后再做" }], context: { handler: "work-deliver", rootId: "r_work" } });
      notify(app, { title: "交办暂停：自动推进到了第 6 轮", body: "还有 2 项待做。", link: "#/runs/r_round6" });
      const told = hostToldOwner(app, handoff);
      expect(told).toHaveLength(2);
      expect(told[0]).toContain("需求做完了");
      expect(told[0]).toContain("先推送验证 / 剩下的以后再做");
      expect(told[1]).toContain("交办暂停");
      expect(mayStayQuiet(app, getRun(app, "r_handoff"))).toBe(true);
    } finally { await settle(); app.db.close(); }
  });
});

describe("a wake-up's turn", () => {
  it("tells the owner only what needs them or how it ended", () => {
    expect(WAKE_NOTE).toContain("stay_quiet");
    expect(WAKE_NOTE).toContain("办成、办不成");
  });
});
