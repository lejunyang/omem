import type { App } from "../core/app.ts";

/**
 * Native "thinking process" bubble for a turn in Feishu, via the `message_cot`
 * endpoint (AG-UI events): the collapsible bubble Feishu's own agents show —
 * reasoning paragraphs and tool calls, the in-flight one spinning until its
 * result arrives, the whole stream folded after the reply.
 *
 * Lifecycle: create once per turn → append entries (debounced, one PUT in
 * flight) → finish with RUN_FINISHED. Any failure only disables the bubble;
 * the ordinary answer card is unaffected.
 */

type ToolStatus = "pending" | "running" | "done" | "failed";
type Entry =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; id: string; name: string; title: string; status: ToolStatus; result?: string };

type State = {
  chatId: string;
  originMessageId?: string;
  inThread: boolean;
  turnId: string;
  cotId?: string;
  messageId?: string;
  entries: Entry[];
  sentEntries: number;
  disabled: boolean;
  pumping: boolean;
  queued: boolean;
  finish?: "done" | "error";
  settled: boolean;
  timers: ReturnType<typeof setTimeout>[];
};

const states = new Map<string, State>();
const TIMEOUT = 15_000;

let sdk: { request: (o: { method: string; url: string; data?: unknown; params?: unknown; timeout?: number }) => Promise<any> } | null = null;
export function setCotSdk(c: typeof sdk) {
  sdk = c;
}
export function cotAvailable() {
  return !!sdk;
}

const ev = (event_type: string, content: Record<string, unknown>) => ({ event_type, content, timestamp: Date.now() });

function iconFor(name: string): string {
  const n = name.toLowerCase();
  if (/bash|shell|command|\bexec\b|命令/.test(n)) return "bash";
  if (/write|edit|patch|apply|修改|保存/.test(n)) return "write";
  if (/read|cat|view|读取|查看/.test(n)) return "read";
  if (/grep|glob|search|fetch|scan|find_symbol|查找|搜索|检索/.test(n)) return "search";
  if (/task|todo|plan|计划/.test(n)) return "task";
  return "default";
}

/** One readable line for a tool call: strip MCP prefixes, keep command / path / subject. */
function titleFor(raw: string): string {
  const t = raw.replace(/^mcp(?:\.omem)?[.:_]/, "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 80) : t;
}

async function api(method: "POST" | "PUT", url: string, data: unknown, params?: unknown) {
  if (!sdk) throw new Error("message_cot 不可用");
  const r = await sdk.request({ method, url, data, params, timeout: TIMEOUT });
  if (r && typeof r.code === "number" && r.code !== 0) throw new Error(`${r.code} ${r.msg}`);
  return r?.data ?? r;
}

async function createBubble(st: State) {
  const data: Record<string, unknown> = { receive_id: st.chatId };
  if (st.originMessageId) data.origin_message_id = st.originMessageId;
  data.reply_in_thread = st.inThread;
  const d = await api("POST", "/open-apis/im/v1/message_cot", data, { receive_id_type: "chat_id" });
  if (typeof d?.cot_id !== "string" || typeof d?.message_id !== "string") throw new Error("message_cot 未返回 id");
  st.cotId = d.cot_id;
  st.messageId = d.message_id;
}

function reasoningId(turnId: string, i: number) {
  return `reasoning-${turnId}-${i}`;
}

/** AG-UI events for entries from `from` (the prologue is included on the first push). */
function eventsFor(st: State, from: number): any[] {
  const out: any[] = [];
  if (from === 0) {
    out.push(ev("RUN_STARTED", { threadId: st.turnId, runId: st.turnId }));
    out.push(ev("REASONING_START", { messageId: reasoningId(st.turnId, 0) }));
    // A turn that starts straight into a tool needs one reasoning node to hang the tools under.
    if (st.entries[0]?.kind === "tool") {
      out.push(ev("REASONING_MESSAGE_START", { messageId: reasoningId(st.turnId, 0), role: "reasoning" }));
      out.push(ev("REASONING_MESSAGE_CONTENT", { messageId: reasoningId(st.turnId, 0), delta: "正在处理…" }));
      out.push(ev("REASONING_MESSAGE_END", { messageId: reasoningId(st.turnId, 0) }));
    }
  }
  st.entries.slice(from).forEach((e, k) => {
    const idx = from + k;
    if (e.kind === "reasoning") {
      const mid = reasoningId(st.turnId, idx);
      out.push(ev("REASONING_MESSAGE_START", { messageId: mid, role: "reasoning" }));
      out.push(ev("REASONING_MESSAGE_CONTENT", { messageId: mid, delta: e.text }));
      out.push(ev("REASONING_MESSAGE_END", { messageId: mid }));
    } else {
      out.push(ev("TOOL_CALL_START", {
        toolCallId: e.id,
        icon: iconFor(e.name),
        title: titleFor(e.title || e.name),
        toolCallName: e.name,
        parentMessageId: reasoningId(st.turnId, 0),
      }));
      out.push(ev("TOOL_CALL_END", { toolCallId: e.id }));
      if (e.status === "done" || e.status === "failed") {
        out.push(ev("TOOL_CALL_RESULT", {
          messageId: `tr-${e.id}`,
          toolCallId: e.id,
          role: "tool",
          content: JSON.stringify(e.result
            ? { type: "code", code: e.result.slice(0, 8000) }
            : { type: "text", text: e.status === "failed" ? "失败" : "完成" }),
        }));
      }
    }
  });
  return out;
}

async function append(st: State, events: any[]) {
  for (let i = 0; i < events.length; i += 50) {
    await api("PUT", "/open-apis/im/v1/message_cot", { cot_id: st.cotId, message_id: st.messageId, events: events.slice(i, i + 50) });
  }
}

async function pump(app: App, runId: string, st: State) {
  if (st.pumping || st.disabled) return;
  st.pumping = true;
  try {
    for (;;) {
      if (!st.cotId) {
        await createBubble(st);
        st.sentEntries = 0;
      }
      if (st.sentEntries < st.entries.length) {
        const from = st.sentEntries;
        await append(st, eventsFor(st, from));
        st.sentEntries = st.entries.length;
        continue;
      }
      if (st.finish && !st.settled) {
        const tail: any[] = [ev("REASONING_END", { messageId: reasoningId(st.turnId, 0) })];
        if (st.finish === "done") tail.push(ev("RUN_FINISHED", { threadId: st.turnId, runId: st.turnId, status: "done" }));
        await append(st, tail);
        if (st.finish === "error") await api("POST", `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(st.cotId!)}`, {}, { message_id: st.messageId!, reason: "error" });
        st.settled = true;
      }
      break;
    }
  } catch (e) {
    st.disabled = true;
    console.warn(`[omem] 思考过程气泡本轮不可用（不影响回复）：${(e as Error).message}`);
  } finally {
    st.pumping = false;
    st.queued = false;
    if (st.settled) {
      const t = setTimeout(() => states.delete(runId), 60_000);
      t.unref();
      st.timers.push(t);
    }
  }
}

function schedule(app: App, runId: string, st: State, delay = 700) {
  if (st.disabled || st.queued) return;
  st.queued = true;
  const t = setTimeout(() => void pump(app, runId, st), delay);
  t.unref();
  st.timers.push(t);
}

/** Begin the bubble for a turn, anchored to the message that started it (so it lands in the topic). */
export function startCot(app: App, runId: string, at: { chatId: string; originMessageId?: string; inThread?: boolean }) {
  if (!sdk || states.has(runId)) return;
  const st: State = { chatId: at.chatId, originMessageId: at.originMessageId, inThread: !!at.inThread, turnId: runId, entries: [], sentEntries: 0, disabled: false, pumping: false, queued: false, settled: false, timers: [] };
  states.set(runId, st);
  schedule(app, runId, st, 300);
}

export function cotEvent(app: App, runId: string, e: { type: string; data: any }) {
  const st = states.get(runId);
  if (!st || st.disabled || st.settled) return;
  const { type, data } = e;
  if (type === "thought-delta" || type === "text-delta") {
    const kind = "reasoning" as const;
    const last = st.entries.at(-1);
    if (last && last.kind === kind) last.text += String(data?.text ?? "");
    else st.entries.push({ kind, text: String(data?.text ?? "") });
    schedule(app, runId, st);
  } else if (type === "tool" && data?.id) {
    const id = String(data.id);
    let t = st.entries.find((x): x is Extract<Entry, { kind: "tool" }> => x.kind === "tool" && x.id === id);
    if (!t) {
      t = { kind: "tool", id, name: String(data.title ?? id), title: String(data.title ?? id), status: "pending" };
      st.entries.push(t);
    }
    t.title = String(data.title ?? t.title);
    if (data.status === "completed") t.status = "done";
    else if (data.status === "failed") t.status = "failed";
    else if (data.status) t.status = "running";
    schedule(app, runId, st);
  }
}

export function finishCot(app: App, runId: string, ok: boolean) {
  const st = states.get(runId);
  if (!st || st.disabled || st.settled) return;
  st.finish = ok ? "done" : "error";
  schedule(app, runId, st, 200);
}
