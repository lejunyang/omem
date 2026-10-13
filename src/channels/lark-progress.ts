import type { App } from "../core/app.ts";
import { buildCard, reactLark, sendLark, unreactLark, updateLarkCard, type CardBlock } from "./lark-send.ts";

/**
 * Live progress for a bot reply: a "处理中" reaction on the question, then
 * one card that shows the steps the agent takes, a glimpse of its reasoning
 * and the answer as it is written — updated in place every couple of seconds
 * and finally replaced by the answer itself.
 */
const TOOL_LABEL: Record<string, string> = {
  search: "检索",
  scan: "逐行扫描",
  read_source: "读原件",
  source_outline: "看结构",
  find_symbol: "找符号",
  recall: "查记忆",
  read_page: "读页面",
  list_pages: "列页面",
  list_items: "查事项",
  list_sources: "列原件",
  remember: "记下",
  supersede: "更正记忆",
  upsert_item: "更新事项",
  read_conversation: "读会话",
  list_conversations: "找会话",
  delegate_code: "交办编码",
  run_agent: "交给 Agent",
  read_skill: "读技能",
};
function label(title: string) {
  const name = title.replace(/^mcp__omem__/, "").replace(/^omem[.:_]/, "");
  return TOOL_LABEL[name] ?? title.slice(0, 40);
}

export type Progress = { finish(answer: string): Promise<void>; fail(message: string): Promise<void> };

export async function startProgress(app: App, at: { messageId: string; inThread: boolean }, runId: string): Promise<Progress> {
  const started = Date.now();
  let reaction: string | undefined;
  try {
    reaction = await reactLark(at.messageId, "OnIt");
  } catch {}
  const steps: { title: string; done: boolean; id: string }[] = [];
  let thought = "";
  let partial = "";
  let status = "正在理解问题…";
  const render = (): CardBlock[] => {
    const blocks: CardBlock[] = [];
    if (steps.length) blocks.push({ markdown: steps.slice(-6).map((s) => `${s.done ? "✓" : "…"} ${s.title}`).join("\n") });
    else blocks.push({ markdown: status });
    if (thought) blocks.push({ note: thought.slice(-280).replace(/\s+/g, " ") });
    if (partial) blocks.push({ hr: true }, { markdown: partial.slice(-1800) });
    return blocks;
  };
  const card = () => buildCard({ title: `处理中 · ${Math.round((Date.now() - started) / 1000)} 秒`, color: "wathet", blocks: render() });
  const sent = await sendLark({ replyTo: at.messageId, inThread: at.inThread }, { card: card() });
  let dirty = false;
  let closed = false;
  const listener = (e: { type: string; runId?: string; event?: { type: string; data: any } }) => {
    if (e.type !== "run-event" || e.runId !== runId || !e.event) return;
    const { type, data } = e.event;
    if (type === "tool" && data?.title) {
      const s = steps.find((x) => x.id === data.id);
      if (s) s.done = data.status === "completed" || data.status === "failed";
      else steps.push({ id: data.id, title: label(String(data.title)), done: data.status === "completed" });
    } else if (type === "thought-delta") thought += data.text ?? "";
    else if (type === "text-delta") partial += data.text ?? "";
    else if (type === "status" && data?.text) status = String(data.text);
    else return;
    dirty = true;
  };
  app.events.on("event", listener);
  // Feishu allows a few updates per second per message; every 2 s is plenty and safe.
  const timer = setInterval(() => {
    if (!dirty || closed) return;
    dirty = false;
    updateLarkCard(sent.messageId, card()).catch(() => {});
  }, 2000);
  const close = async () => {
    closed = true;
    clearInterval(timer);
    app.events.off("event", listener);
    if (reaction) await unreactLark(at.messageId, reaction);
  };
  return {
    async finish(answer: string) {
      await close();
      const secs = Math.round((Date.now() - started) / 1000);
      const note = `${steps.length ? `${steps.length} 步 · ` : ""}${secs} 秒`;
      // Very long answers do not fit one card: the card keeps the start, the rest follows as messages.
      const head = answer.length > 18000 ? answer.slice(0, 18000) : answer;
      await updateLarkCard(sent.messageId, buildCard({ blocks: [{ markdown: head || "（没有回答）" }, { note }] })).catch(async () => {
        await sendLark({ replyTo: at.messageId, inThread: at.inThread }, { markdown: head });
      });
      if (answer.length > 18000) await sendLark({ replyTo: at.messageId, inThread: at.inThread }, { markdown: answer.slice(18000) });
      await reactLark(at.messageId, "DONE").catch(() => {});
    },
    async fail(message: string) {
      await close();
      await updateLarkCard(sent.messageId, buildCard({ title: "没有完成", color: "red", blocks: [{ markdown: message.slice(0, 4000) }] })).catch(() => {});
    },
  };
}
