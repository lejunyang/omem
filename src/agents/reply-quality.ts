/**
 * A last look at a reply before it goes to a person: replies that say nothing are sent back to the
 * agent once (jobs.ts). Like the write-time check of memories (memory/quality.ts) this only catches
 * shapes that are plainly not an answer; whether an answer is right is not judged here.
 *
 * - marker: an internal word for “nothing to say” written out as the reply. Saying nothing is a tool
 *   call (stay_quiet), never a word.
 * - intent: only what it is about to do (“我核对一下…”), no result and no follow-up arranged.
 * - ack: only an acknowledgement (“收到，我看看”), nothing done and nothing arranged.
 * - hedge: only ways out (“可能…建议进一步确认…以实际为准”), no conclusion, no evidence, and not
 *   saying which piece of information is missing.
 *
 * The rules were tuned on real replies so that an ordinary short answer passes: a greeting, a
 * confirmation of what was just done, a fact followed by the next step.
 */
export type ReplyProblem = { kind: "marker" | "intent" | "ack" | "hedge"; why: string };
export type ReplyContext = {
  /** The turn arranged to come back (a wake-up, a delegation, a question to someone): “I'll look” is then true. */
  followUp?: boolean;
  /** The turn changed something (a write tool ran): a bare “好的” after doing what was asked is fine. */
  acted?: boolean;
};

const MARKER = /^[\s*`_"“”（(]*(quiet|silent|no[_ ]?reply|无需回复|不需要回复|不用回复|保持安静)[\s*`_"“”）)。.!！]*$/i;

const LEAD = "(?:好的?|收到|明白|了解|嗯+|ok|行|那|那么|接下来|现在|然后|稍后|马上|这就|首先)?[，,、\\s]*";
const WHO = "(?:我|我们|我这边|这边)";
const WHEN = "(?:先|来|去|再|会|将|这就|马上|稍后|接下来|现在|正在|继续|需要|要|得|准备|打算)*";
const DO = "(?:检查|核对|核实|核验|确认|看看|看一下|看下|看|查看|查一下|查下|查|排查|跟进|处理|研究|了解|梳理|整理|分析|定位|读一下|读|翻一下|对一下|对比|比对|验证|复查|复核|同步|更新|补充|补|记录|记|把)";
const INTENT = new RegExp(`^${LEAD}${WHO}${WHEN}${DO}`, "i");
/** Words that show something was found or done; a sentence with one is not only an intent. */
const RESULT = /发现|结论|原因|已完成|已修复|已更新|已发送|已发出|已记录|已记下|已保存|已安排|已设好|已停止|已确认|已核对|已同步|没有发现|没发现|没问题|有问题|不存在|src:|mem:|https?:\/\/|\[\[|`[^`]+`|\d{3,}/;
/** Sentences that carry nothing by themselves and do not count for or against. */
const FILLER = /^(已结束|继续监控|继续等待|先这样|就这样|稍等|请稍等|收到|好的?|ok|嗯+)$/i;

const ACK = new RegExp(
  `^(?:好的?|收到|明白|了解|嗯+|ok|行|可以|没问题|知道了)[，,。.!！～~\\s]*(?:${WHO}?(?:稍后|晚点|马上|这就|待会儿?|一会儿?|回头|先|来|去|会)*(?:看看|看一下|看下|处理|跟进|回复你?|答复你?|确认|查一下|查|研究)?(?:一下)?)?[。.!！～~\\s]*$`,
  "i",
);

const HEDGES = ["可能", "或许", "也许", "大概", "似乎", "不确定", "无法确定", "不能确定", "难以确定", "尚不清楚", "不太清楚", "建议进一步", "建议你确认", "建议确认", "建议核实", "建议联系", "以实际为准", "仅供参考", "需要进一步", "有待确认", "有待核实", "视情况而定"];
/** What makes a hedged reply an answer after all: a conclusion, evidence, or naming what is missing. */
const GROUNDED = /src:|mem:|https?:\/\/|\[\[|```|`[^`]+`|结论|原因是|是因为|因此|所以|已确认|确认了|查到|查过|核对过|缺少|还缺|还差|需要你提供|请提供|请告诉我|麻烦提供|\d{2,}/;

const sentences = (text: string) => text.split(/[。！？!?；;\n]+/).map((s) => s.trim().replace(/^[-*\d.、\s>]+/, "")).filter(Boolean);

export function replyProblem(text: string, ctx: ReplyContext = {}): ReplyProblem | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (MARKER.test(t)) return { kind: "marker", why: "回复只有一个表示“不用说话”的内部标记" };
  if (t.length <= 60 && ACK.test(t) && !ctx.acted && !ctx.followUp) return { kind: "ack", why: "只应了一声，没有做什么，也没有安排之后回来" };
  if (t.length <= 160 && !ctx.followUp) {
    const parts = sentences(t).filter((s) => !FILLER.test(s));
    if (parts.length && parts.every((s) => INTENT.test(s) && !RESULT.test(s))) return { kind: "intent", why: "只说了接下来要做什么，没有结果，也没有安排之后回来" };
  }
  if (t.length <= 600 && !GROUNDED.test(t)) {
    const n = HEDGES.reduce((sum, h) => sum + (t.split(h).length - 1), 0);
    if (n >= 3 && n * 60 >= t.length) return { kind: "hedge", why: "只有“可能”“建议再确认”这类退路，没有结论和依据，也没说缺哪一个信息" };
  }
  return null;
}

/** What the agent is told when its reply is sent back (once). `mayStayQuiet`: nobody waits on this turn. */
export function reviseNote(p: ReplyProblem, mayStayQuiet: boolean): string {
  const quiet = mayStayQuiet ? "没有要告诉对方的，就调 stay_quiet，什么都不发。" : "";
  const how =
    p.kind === "marker"
      ? `不说话是调用 stay_quiet，不是在回复里写一个词。${mayStayQuiet ? "没有要说的就调 stay_quiet；" : "这一轮有人在等回答，"}有要说的就直接写正文。`
      : p.kind === "hedge"
        ? "给出结论和依据（引用原件、页面或代码）；确实定不了，就说清楚缺的是哪一个信息、谁能提供。不要用“可能”“建议进一步确认”收尾。"
        : `把事情做完再回，回的是结果；要对方等，就先安排好之后回来（wake 或交办），再说清在等什么、什么时候回。${quiet}`;
  return `刚才这条回复没有发出去：${p.why}。${how}重新写这条回复，只写正文。`;
}
