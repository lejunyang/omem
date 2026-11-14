import { afterEach, describe, expect, it } from "vitest";
import { reviseHollow } from "../src/agents/reply-check.ts";
import { replyProblem, reviseNote } from "../src/agents/reply-quality.ts";
import { addRunEvent, createRun, getRun } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
const fresh = () => { const app = testApp(); apps.push(app); return app; };
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

describe("replies that say nothing", () => {
  it("catches an internal marker, a bare intent, a bare acknowledgement and a reply made of ways out", () => {
    expect(replyProblem("QUIET")?.kind).toBe("marker");
    expect(replyProblem("`QUIET`。")?.kind).toBe("marker");
    expect(replyProblem("我核对一下发布记录。")?.kind).toBe("intent");
    expect(replyProblem("好的，我先看看日志，再确认是不是配置的问题。 已结束。")?.kind).toBe("intent");
    expect(replyProblem("收到，我看看。")?.kind).toBe("ack");
    expect(replyProblem("这个可能是配置问题，也可能是缓存没刷新，建议进一步确认，以实际为准。")?.kind).toBe("hedge");
  });

  it("lets ordinary short replies through", () => {
    for (const ok of [
      "你好，我在。有什么需要我帮忙的？",
      "好的，已经记下了。",
      "好，这个追问先忽略。",
      // A fact first, then the next step.
      "发布记录里 3 月 2 日那次回滚过。我会把它补到事项里。",
      // It did look: there is a finding.
      "我查了日志，发现 14:02 开始超时。",
      // Hedged, but it says what is missing.
      "可能是配置问题，也可能是缓存，现在无法确定：缺少线上日志，需要你提供那次请求的 request id。",
      "项目 A 的退款入口在订单详情页右上角，见 [退款流程](src:s1#L3-L8)。",
    ]) expect(replyProblem(ok), ok).toBeNull();
    // “我去看看” is true once the turn arranged to come back; a bare “好的” is fine after doing what was asked.
    expect(replyProblem("我核对一下发布记录。", { followUp: true })).toBeNull();
    expect(replyProblem("好的。", { acted: true })).toBeNull();
    expect(replyProblem("好的。")?.kind).toBe("ack");
  });

  it("tells the agent what to do instead, and offers staying quiet only where nobody waits", () => {
    const p = replyProblem("我核对一下发布记录。")!;
    expect(reviseNote(p, true)).toContain("stay_quiet");
    expect(reviseNote(p, false)).not.toContain("stay_quiet");
    expect(reviseNote(replyProblem("QUIET")!, false)).toContain("有人在等回答");
  });
});

describe("sending a hollow reply back once", () => {
  const ctxOf = (app: ReturnType<typeof testApp>, input: Record<string, unknown> = {}, kind: "ask" | "agent" = "ask") => {
    const run = createRun(app, { kind, spaceId: "personal", title: "一轮对话", input });
    const events: string[] = [];
    return { ctx: { app, run: getRun(app, run.id), event: (_t: string, d: unknown) => void events.push(String((d as { text?: string }).text ?? "")) }, events, id: run.id };
  };

  it("gives the agent one more turn and posts what it writes then", async () => {
    const app = fresh();
    const { ctx, events, id } = ctxOf(app);
    const prompts: string[] = [];
    const out = await reviseHollow(ctx, "我核对一下发布记录。", async (p) => { prompts.push(p); return "发布记录里 3 月 2 日那次回滚过，原因是配置漏了一项。"; });
    expect(out).toBe("发布记录里 3 月 2 日那次回滚过，原因是配置漏了一项。");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("没有发出去");
    expect(events[0]).toContain("退回重写一次");
    expect(getRun(app, id).output.replyCheck).toEqual({ kind: "intent", revised: true, quiet: false });
  });

  it("leaves real replies, turns that arranged a follow-up and a turned-off check alone", async () => {
    const app = fresh();
    let calls = 0;
    const rerun = async () => { calls++; return "不该被调用"; };
    const a = ctxOf(app);
    expect(await reviseHollow(a.ctx, "项目 A 的退款入口在订单详情页右上角。", rerun)).toBe("项目 A 的退款入口在订单详情页右上角。");
    const b = ctxOf(app);
    addRunEvent(app, b.id, "tool-write", { name: "wake_later", args: {} });
    expect(await reviseHollow(b.ctx, "我核对一下发布记录。", rerun)).toBe("我核对一下发布记录。");
    const c = ctxOf(app);
    app.config.replies.check = false;
    expect(await reviseHollow(c.ctx, "我核对一下发布记录。", rerun)).toBe("我核对一下发布记录。");
    expect(calls).toBe(0);
  });

  it("never posts a marker: quiet where nobody waits, a plain line where somebody does; a failed rewrite keeps the draft", async () => {
    const app = fresh();
    // A wake-up's turn: nobody waits on it.
    const wake = ctxOf(app, { wake: true }, "agent");
    await reviseHollow(wake.ctx, "QUIET", async () => "QUIET");
    expect(getRun(app, wake.id).output.stayQuiet).toBeTruthy();
    // Somebody asked: there has to be a reply.
    const asked = ctxOf(app, { conversationId: "c1", messageIds: ["m1"] });
    expect(await reviseHollow(asked.ctx, "QUIET", async () => "QUIET")).toBe("（这一轮没有给出回答）");
    expect(getRun(app, asked.id).output.stayQuiet).toBeUndefined();
    const broken = ctxOf(app);
    expect(await reviseHollow(broken.ctx, "收到，我看看。", async () => { throw new Error("连接断了"); })).toBe("收到，我看看。");
    expect(broken.events.join("\n")).toContain("连接断了");
  });
});
