import { currentBot, withBot } from "../core/bot-context.ts";
import type { App } from "../core/app.ts";
import { buildCard, reactLark, sendLark, unreactLark, updateLarkCard } from "./lark-send.ts";

import { getRun } from "../agents/runs.ts";
import { cotEvent, cotLiveFor, startCot } from "./lark-cot.ts";

/** A fallback status card; reasoning and partial answers belong only in the native bubble. */
export type Progress = { messageId: string; finish(answer: string): Promise<void>; fail(message: string): Promise<void> };

export async function startProgress(_app: App, at: { messageId: string; inThread: boolean }, _runId: string, react = true): Promise<Progress> {
  const started = Date.now();
  const bot = currentBot();
  let reaction: string | undefined;
  try {
    if (react) reaction = await reactLark(at.messageId, "OnIt");
  } catch {}
  const sent = await sendLark({ replyTo: at.messageId, inThread: at.inThread }, { card: buildCard({
    title: "处理中", color: "wathet", blocks: [{ markdown: "思考气泡暂不可用，任务仍在处理。完成后这里显示结果。" }],
  }) });
  const close = async () => {
    if (reaction) await unreactLark(at.messageId, reaction).catch(() => {});
  };
  return {
    messageId: sent.messageId,
    finish: (answer: string) => withBot(bot, async () => {
      await close();
      const secs = Math.round((Date.now() - started) / 1000);
      const note = `${secs} 秒`;
      // Very long answers do not fit one card: the card keeps the start, the rest follows as messages.
      const head = answer.length > 18000 ? answer.slice(0, 18000) : answer;
      await updateLarkCard(sent.messageId, buildCard({ blocks: [{ markdown: head || "（没有回答）" }, { note }] })).catch(async () => {
        await sendLark({ replyTo: at.messageId, inThread: at.inThread }, { markdown: head });
      });
      if (answer.length > 18000) await sendLark({ replyTo: at.messageId, inThread: at.inThread }, { markdown: answer.slice(18000) });
      await reactLark(at.messageId, "DONE").catch(() => {});
    }),
    fail: (message: string) => withBot(bot, async () => {
      await close();
      await updateLarkCard(sent.messageId, buildCard({ title: "没有完成", color: "red", blocks: [{ markdown: message.slice(0, 4000) }] })).catch(() => {});
    }),
  };
}

/** Own all asynchronous presentation work so a late card/reaction is settled with the answer. */
export function startReplyProgress(app: App, at: { chatId: string; messageId: string; inThread: boolean }, runId: string) {
  // Updates come from run events (any context): they go through the bot that took the message.
  const bot = currentBot();
  let closed = false;
  let started = false;
  let working: string | undefined;
  let beginning: Promise<void> | undefined;
  let pending: Promise<Progress | null> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const fallback = () => {
    if (closed || pending) return;
    pending = withBot(bot, () => startProgress(app, at, runId, false)).catch(() => null);
  };
  const begin = () => {
    if (closed || started) return;
    started = true;
    const native = startCot(app, runId, { chatId: at.chatId, originMessageId: at.messageId, inThread: at.inThread, bot });
    beginning = reactLark(at.messageId, "OnIt", bot).then((id) => { working = id; }).catch(() => {});
    if (!native) fallback();
    else {
      timer = setInterval(() => {
        if (!closed && !cotLiveFor(runId) && getRun(app, runId).status === "running") fallback();
      }, 15_000);
      timer.unref();
    }
  };
  const listener = (e: { type: string; runId?: string; status?: string; event?: { type: string; data: unknown } }) => {
    if (closed || e.runId !== runId) return;
    if (e.type === "run" && e.status === "running") begin();
    if (e.type === "run-event" && e.event) cotEvent(app, runId, e.event);
  };
  app.events.on("event", listener);
  if (getRun(app, runId).status === "running") begin();
  let closing: Promise<Progress | null> | undefined;
  return {
    close(): Promise<Progress | null> {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      app.events.off("event", listener);
      closing = (async () => {
        await beginning;
        const progress = await pending ?? null;
        if (working) await unreactLark(at.messageId, working, bot).catch(() => {});
        return progress;
      })();
      return closing;
    },
  };
}
