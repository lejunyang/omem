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
  | { kind: "tool"; id: string; name: string; title: string; args?: string; status: ToolStatus; result?: string };

type State = {
  chatId: string;
  originMessageId?: string;
  inThread: boolean;
  turnId: string;
  cotId?: string;
  messageId?: string;
  entries: Entry[];
  /** toolCallIds whose START (+ARGS) has already been pushed */
  toolStarted: Set<string>;
  /** toolCallIds whose END+RESULT has already been pushed */
  toolSettled: Set<string>;
  /** Reasoning nodes: how much of each text has been pushed, and which are closed. */
  reasoningSent: Map<string, number>;
  reasoningClosed: Set<string>;
  disabled: boolean;
  pumping: boolean;
  queued: boolean;
  dirty: boolean;
  /** No more input is accepted once the terminal request starts. */
  closing: boolean;
  requestSeq: number;
  finish?: "done" | "error";
  settled: boolean;
  /** RUN_STARTED/REASONING_START prologue already pushed. */
  prologueSent: boolean;
  /** At least one event batch was accepted: the bubble has proven usable this turn. */
  proven: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
  settleExpired?: boolean;
  /** When the provider queue started (shown as one line, then how long it took). */
  queuedAt?: number;
  queuePos?: number;
  timers: ReturnType<typeof setTimeout>[];
};

const states = new Map<string, State>();
const TIMEOUT = 15_000;
/**
 * Max characters of one REASONING_MESSAGE_CONTENT event. Feishu rejects a long event ("content too
 * long") without saying the limit; 1000 Chinese characters stay well under 4 KB of UTF-8.
 */
const COT_CONTENT_MAX = 1000;
/** After a hard failure (e.g. message_cot not enabled for this app) no bubbles are tried for a while. */
let disabledUntil = 0;
const DISABLE_MS = 30 * 60_000;

let sdk: { request: (o: { method: string; url: string; data?: unknown; params?: unknown; timeout?: number }) => Promise<any> } | null = null;
export function setCotSdk(c: typeof sdk) {
  sdk = c;
}
export function cotAvailable() {
  return !!sdk;
}

/**
 * Whether the native bubble is actually able to render this process. It is
 * created lazily, so before the first push succeeds we treat it as "not yet
 * proven": callers should keep their own lightweight progress instead of
 * assuming it works. Once a bubble has pushed at least one event, the bubble
 * owns the process display.
 */
export function cotLiveFor(runId: string) {
  const st = states.get(runId);
  return !!st?.proven && !st.disabled && !st.settled;
}

// The AG-UI gateway takes content as a JSON-encoded STRING (an object is rejected
// with a misleading 41050). Sending it raw was why bubbles stayed empty.
const ev = (event_type: string, content: unknown) => ({ event_type, content: JSON.stringify(content), timestamp: Date.now() });

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

function cotLog(st: Pick<State, "turnId" | "cotId" | "messageId">, action: string, details: Record<string, unknown> = {}, warning = false) {
  // Never log request/response bodies: they may contain reasoning, tool input or credentials.
  const line = `[omem] lark-cot ${JSON.stringify({ at: new Date().toISOString(), runId: st.turnId, cotId: st.cotId, messageId: st.messageId, action, ...details })}`;
  if (warning) console.warn(line);
  else console.info(line);
}

function errorInfo(error: unknown) {
  const e = error as { message?: unknown; code?: unknown; response?: { status?: unknown; data?: { code?: unknown; msg?: unknown; log_id?: unknown } } } | null;
  const data = e?.response?.data;
  const msg = String(data?.msg ?? e?.message ?? "");
  const code = data?.code ?? e?.code;
  return {
    code: typeof code === "number" || (typeof code === "string" && /^[A-Z_0-9]{1,40}$/.test(code)) ? code : undefined,
    httpStatus: typeof e?.response?.status === "number" ? e.response.status : undefined,
    logId: typeof data?.log_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.log_id) ? data.log_id : undefined,
    // Classify the message instead of copying text that may echo a rejected payload.
    reason: /content too long/i.test(msg) ? "content-too-long" : /timeout|timed out/i.test(msg) ? "timeout" : /no user authority/i.test(msg) ? "no-user-authority" : /invalid|illegal/i.test(msg) ? "invalid-data" : "request-failed",
    eventIndex: /event\[(\d+)\]/i.exec(msg)?.[1],
  };
}

async function api(st: State, phase: "create" | "append" | "finish" | "complete" | "cleanup", method: "POST" | "PUT", url: string, data: unknown, params?: unknown, events: ReturnType<typeof ev>[] = []) {
  const started = Date.now();
  const requestSeq = ++st.requestSeq;
  const details = {
    phase, method, requestSeq,
    endpoint: url.replace(/\/complete\/.+$/, "/complete/:cotId"),
    eventTypes: events.map((e) => e.event_type),
    contentBytes: events.map((e) => Buffer.byteLength(e.content, "utf8")),
  };
  cotLog(st, "request", details);
  try {
    if (!sdk) throw new Error("message_cot 不可用");
    const r = await sdk.request({ method, url, data, params, timeout: TIMEOUT });
    if (r && typeof r.code === "number" && r.code !== 0) throw Object.assign(new Error("message_cot API error"), { response: { data: r } });
    const result = r?.data ?? r;
    if (phase === "create") {
      if (typeof result?.cot_id !== "string" || typeof result?.message_id !== "string") throw Object.assign(new Error("message_cot 未返回 id"), { code: "MISSING_IDS" });
      st.cotId = result.cot_id;
      st.messageId = result.message_id;
    }
    cotLog(st, "accepted", { ...details, elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    cotLog(st, "rejected", { ...details, elapsedMs: Date.now() - started, ...errorInfo(error) }, true);
    throw error;
  }
}

async function createBubble(st: State) {
  const data: Record<string, unknown> = { receive_id: st.chatId };
  if (st.originMessageId) data.origin_message_id = st.originMessageId;
  data.reply_in_thread = st.inThread;
  await api(st, "create", "POST", "/open-apis/im/v1/message_cot", data, { receive_id_type: "chat_id" });
}

function reasoningId(turnId: string, i: number) {
  return `reasoning-${turnId}-${i}`;
}

/** AG-UI events for entries from `from` (the prologue is included on the first push). */
function eventsFor(st: State): any[] {
  const out: any[] = [];
  if (!st.prologueSent) {
    out.push(ev("RUN_STARTED", { threadId: st.turnId, runId: st.turnId }));
    out.push(ev("REASONING_START", { messageId: reasoningId(st.turnId, 0) }));
    // A turn that starts straight into a tool needs one reasoning node to hang the tools under.
    if (st.entries[0]?.kind === "tool") {
      out.push(ev("REASONING_MESSAGE_START", { messageId: reasoningId(st.turnId, 0), role: "reasoning" }));
      out.push(ev("REASONING_MESSAGE_CONTENT", { messageId: reasoningId(st.turnId, 0), delta: "正在处理…" }));
      out.push(ev("REASONING_MESSAGE_END", { messageId: reasoningId(st.turnId, 0) }));
    }
  }
  // Iterate every entry: new entries need START, existing ones may have just
  // transitioned to done/failed and need END + RESULT. Bookkeeping sets prevent
  // duplicate events across pumps.
  st.entries.forEach((e, idx) => {
    if (e.kind === "reasoning") {
      // Text keeps streaming into the last node: push what is new, close it once something
      // follows it (or the turn ends).
      const mid = reasoningId(st.turnId, idx);
      if (st.reasoningClosed.has(mid)) return;
      const sent = st.reasoningSent.get(mid);
      if (sent === undefined) out.push(ev("REASONING_MESSAGE_START", { messageId: mid, role: "reasoning" }));
      if (e.text.length > (sent ?? 0)) {
        // Feishu rejects a single COT event whose content is too long ("event[n] content too long"):
        // split into capped deltas (it rendered an empty "thinking hidden" bubble when we did not).
        for (let from = sent ?? 0; from < e.text.length; from += COT_CONTENT_MAX)
          out.push(ev("REASONING_MESSAGE_CONTENT", { messageId: mid, delta: e.text.slice(from, from + COT_CONTENT_MAX) }));
      }
      st.reasoningSent.set(mid, e.text.length);
      if (idx < st.entries.length - 1 || st.finish) {
        out.push(ev("REASONING_MESSAGE_END", { messageId: mid }));
        st.reasoningClosed.add(mid);
      }
    } else {
      const settled = e.status === "done" || e.status === "failed";
      if (!st.toolStarted.has(e.id)) {
        out.push(ev("TOOL_CALL_START", {
          toolCallId: e.id,
          icon: iconFor(e.name),
          title: titleFor(e.title || e.name),
          toolCallName: e.name,
          parentMessageId: reasoningId(st.turnId, 0),
        }));
        // While running we stream args and deliberately do NOT send TOOL_CALL_END:
        // the end event (plus result) is what stops the spinner on the tool row.
        if (e.args) out.push(ev("TOOL_CALL_ARGS", { toolCallId: e.id, delta: e.args.slice(0, COT_CONTENT_MAX) }));
        st.toolStarted.add(e.id);
      }
      if (settled && !st.toolSettled.has(e.id)) {
        out.push(ev("TOOL_CALL_END", { toolCallId: e.id }));
        out.push(ev("TOOL_CALL_RESULT", {
          messageId: `tr-${e.id}`,
          toolCallId: e.id,
          role: "tool",
          content: JSON.stringify(e.result
            ? { type: "code", code: e.result.slice(0, COT_CONTENT_MAX) }
            : { type: "text", text: e.status === "failed" ? "失败" : "完成" }),
        }));
        st.toolSettled.add(e.id);
      }
    }
  });
  if (out.length) st.prologueSent = true;
  return out;
}

async function append(st: State, events: ReturnType<typeof ev>[], phase: "append" | "finish" = "append") {
  for (let i = 0; i < events.length; i += 50) {
    const batch = events.slice(i, i + 50);
    await api(st, phase, "PUT", "/open-apis/im/v1/message_cot", { cot_id: st.cotId, message_id: st.messageId, events: batch }, undefined, batch);
  }
}

function expirePendingTools(st: State) {
  let missingTools = 0;
  for (const entry of st.entries) {
    if (entry.kind === "tool" && entry.status !== "done" && entry.status !== "failed") {
      entry.status = "failed";
      entry.result = "未收到工具完成事件";
      missingTools++;
    }
  }
  return missingTools;
}

async function pump(app: App, runId: string, st: State) {
  if (st.pumping || st.disabled || st.settled) return;
  st.pumping = true;
  try {
    if (!st.cotId) await createBubble(st);
    // Input can change during any awaited batch. Drain it before deciding whether to finish.
    do {
      st.dirty = false;
      if (st.settleExpired) {
        const missingTools = expirePendingTools(st);
        if (missingTools) cotLog(st, "settle-timeout", { missingTools }, true);
      }
      const evs = eventsFor(st);
      if (evs.length) {
        await append(st, evs);
        st.proven = true;
      }
    } while (st.dirty && st.finish);
    const allSettled = st.entries.every((e, i) => e.kind === "reasoning" ? st.reasoningClosed.has(reasoningId(st.turnId, i)) : st.toolSettled.has(e.id));
    if (st.finish && allSettled) {
      st.closing = true;
      const tail = [ev("REASONING_END", { messageId: reasoningId(st.turnId, 0) })];
      if (st.finish === "done") tail.push(ev("RUN_FINISHED", { threadId: st.turnId, runId: st.turnId, status: "done" }));
      await append(st, tail, "finish");
      st.proven = true;
      if (st.finish === "error") await api(st, "complete", "POST", `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(st.cotId!)}`, {}, { message_id: st.messageId!, reason: "error" });
      st.settled = true;
      cotLog(st, "settled", { outcome: st.finish });
    }
  } catch (e) {
    st.disabled = true;
    if (st.cotId) {
      try { await api(st, "cleanup", "POST", `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(st.cotId)}`, {}, { message_id: st.messageId!, reason: "error" }); } catch {}
    }
    // Oversized content only disables this bubble; other failures pause new bubbles for 30 minutes.
    const error = errorInfo(e);
    if (error.reason !== "content-too-long") disabledUntil = Date.now() + DISABLE_MS;
    cotLog(st, "disabled", { ...error, cooldownMs: error.reason === "content-too-long" ? 0 : DISABLE_MS }, true);
  } finally {
    st.pumping = false;
    if (st.settled || st.disabled) {
      for (const timer of st.timers) clearTimeout(timer);
      st.timers = [];
      const t = setTimeout(() => states.delete(runId), 60_000);
      t.unref();
      st.timers.push(t);
    } else if (st.dirty) schedule(app, runId, st);
  }
}

function schedule(app: App, runId: string, st: State, delay = 700) {
  if (st.disabled || st.settled || st.closing) return;
  st.dirty = true;
  if (st.pumping || st.queued) return;
  st.queued = true;
  const t = setTimeout(() => { st.queued = false; void pump(app, runId, st); }, delay);
  t.unref();
  st.timers.push(t);
}

/** Begin the bubble for a turn, anchored to the message that started it (so it lands in the topic). */
/** `title`: a first line saying whose process this is (an agent's round in a work topic). */
export function startCot(app: App, runId: string, at: { chatId: string; originMessageId?: string; inThread?: boolean; title?: string }) {
  if (!sdk || states.has(runId)) return false;
  if (Date.now() < disabledUntil) {
    cotLog({ turnId: runId }, "skipped", { reason: "cooldown", remainingMs: disabledUntil - Date.now() });
    return false;
  }
  const st: State = { chatId: at.chatId, originMessageId: at.originMessageId, inThread: !!at.inThread, turnId: runId, entries: at.title ? [{ kind: "reasoning", text: `${at.title}\n\n` }] : [], toolStarted: new Set(), toolSettled: new Set(), reasoningSent: new Map(), reasoningClosed: new Set(), disabled: false, pumping: false, queued: false, dirty: false, closing: false, requestSeq: 0, settled: false, prologueSent: false, proven: false, timers: [] };
  states.set(runId, st);
  schedule(app, runId, st, 300);
  return true;
}

/** Whether a bubble was started for this run (events for it are worth routing). */
export function hasCot(runId: string) {
  return states.has(runId);
}

export function cotEvent(app: App, runId: string, e: { type: string; data: any }) {
  const st = states.get(runId);
  if (!st || st.disabled || st.settled || st.closing) return;
  const { type, data } = e;
  if (type === "thought-delta" || type === "text-delta") {
    const kind = "reasoning" as const;
    const last = st.entries.at(-1);
    if (last && last.kind === kind && !st.reasoningClosed.has(reasoningId(st.turnId, st.entries.length - 1))) last.text += String(data?.text ?? "");
    else st.entries.push({ kind, text: String(data?.text ?? "") });
    schedule(app, runId, st);
  } else if (type === "queue") {
    // Provider queue: text already pushed cannot be rewritten, so the bubble gets one line when
    // the wait starts, the position as it moves, and how long it took when the model starts.
    const add = (text: string) => {
      const last = st.entries.at(-1);
      if (last && last.kind === "reasoning" && !st.reasoningClosed.has(reasoningId(st.turnId, st.entries.length - 1))) last.text += text;
      else st.entries.push({ kind: "reasoning", text });
    };
    const pos = typeof data?.position === "number" ? data.position : undefined;
    if (data?.queued) {
      if (st.queuedAt === undefined) {
        st.queuedAt = Date.now();
        st.queuePos = pos;
        add(`模型排队中${pos ? `，前方约 ${pos} 位` : ""}…`);
      } else if (pos !== undefined && pos !== st.queuePos) {
        st.queuePos = pos;
        add(` ${pos} 位…`);
      } else return;
    } else if (st.queuedAt !== undefined) {
      add(`\n排队结束（约 ${Math.max(1, Math.round((Date.now() - st.queuedAt) / 1000))} 秒），开始处理。\n\n`);
      st.queuedAt = undefined;
      st.queuePos = undefined;
    } else return;
    schedule(app, runId, st);
  } else if (type === "tool" && data?.id) {
    const id = String(data.id);
    let t = st.entries.find((x): x is Extract<Entry, { kind: "tool" }> => x.kind === "tool" && x.id === id);
    if (!t) {
      t = { kind: "tool", id, name: String(data.kind ?? data.name ?? data.title ?? id), title: String(data.title ?? id), status: "pending" };
      st.entries.push(t);
    }
    t.name = String(data.kind ?? data.name ?? t.name);
    t.title = String(data.title ?? t.title);
    // run events carry tool input as `input` (object/string); show a compact preview.
    if (data.input !== undefined) {
      const raw = typeof data.input === "string" ? data.input : JSON.stringify(data.input);
      t.args = raw.slice(0, 2000);
    } else if (typeof data.args === "string") {
      t.args = data.args.slice(0, 2000);
    }
    if (data.status === "completed" || data.status === "done") t.status = "done";
    else if (data.status === "failed") t.status = "failed";
    else if (data.status) t.status = "running";
    schedule(app, runId, st);
  }
}

export function finishCot(app: App, runId: string, ok: boolean) {
  const st = states.get(runId);
  if (!st || st.disabled || st.settled || st.closing) return;
  // A repeated finish must neither extend the deadline nor turn an error into success.
  st.finish = st.finish === "error" || !ok ? "error" : "done";
  if (!st.settleTimer) {
    cotLog(st, "finish-requested", { outcome: st.finish });
    const t = setTimeout(() => {
      if (st.disabled || st.settled || st.closing) return;
      st.settleExpired = true;
      const missingTools = expirePendingTools(st);
      cotLog(st, "settle-timeout", { missingTools }, true);
      schedule(app, runId, st, 0);
    }, 30_000);
    t.unref();
    st.settleTimer = t;
    st.timers.push(t);
  }
  schedule(app, runId, st, 200);
}
