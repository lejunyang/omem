import { ClientSideConnection, ndJsonStream, type McpServer, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../core/config.ts";
import { archiveSession } from "./session-archive.ts";
import { resolveModelOption } from "./models.ts";
import { idleWatchdog, launch, stop } from "./spawn.ts";
import { agentRunError, replyFromSegments, type AgentEvent, type AgentProbe, type AgentRequest, type AgentResult } from "./types.ts";

// Provider queue text shown as a normal message by some CLIs (traex included).
const QUEUE_TEXT = /(?:排队|队列|queue[d]?|waiting (?:in )?(?:the )?queue)[^\d]{0,20}(\d+)?/i;
const QUEUE_END_TEXT = /(?:已排到|轮到你|队列已结束|(?:no longer|out of) (?:in )?queue|开始处理你的请求)/i;
// Housekeeping lines some CLIs print as message text before the model answers.
const AGENT_NOTICE = /^\s*(?:Skill descriptions were shortened|Disable unused skills or plugins)/i;

function optionValues(option: SessionConfigOption): string[] {  if (option.type !== "select") return [];
  const out: string[] = [];
  for (const o of option.options as unknown[]) {
    const group = o as { options?: { value: string }[]; value?: string };
    if (Array.isArray(group.options)) out.push(...group.options.map((x) => x.value));
    else if (typeof group.value === "string") out.push(group.value);
  }
  return out;
}

export type AcpOpenOptions = {
  cwd: string;
  mcp?: AgentRequest["mcp"];
  extraMcp?: AgentRequest["extraMcp"];
  allowWrites?: boolean;
  modes?: string[];
  env?: Record<string, string>;
  /** Continue an earlier agent session (resume, or load when only that is offered). */
  resumeSessionId?: string;
  probe?: boolean;
  strictSelection?: { model?: boolean; effort?: boolean };
  /** Max time to wait in the provider queue before failing with kind="queue". 0 = unlimited. */
  queueTimeoutMs?: number;
};

/**
 * A connected ACP agent session that can take several prompt turns. Threads
 * keep one alive between messages so the agent keeps its own working context
 * (files read, tool results); one-shot runs open, prompt once and close.
 */
export type AcpHandle = {
  sessionId: string;
  agent: string;
  /** true when an earlier session was resumed (the agent remembers it). */
  resumed: boolean;
  alive(): boolean;
  prompt(text: string, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult>;
  close(): void;
  /** Remove an omem-owned temporary session from the backend list, when advertised. */
  discard(): Promise<void>;
  probe?: AgentProbe;
};

export async function openAcp(profile: AgentProfile, opts: AcpOpenOptions, emitSetup: (e: AgentEvent) => void = () => {}): Promise<AcpHandle> {
  const child = launch(profile.command, profile.args, { cwd: opts.cwd, env: { ...profile.env, ...opts.env } });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  let dead = false;
  let fail: (e: Error) => void = () => {};
  let failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => {});
  const exitError = (code: number | null) => new Error(`Agent 进程退出（${code}）${/auth|login|登录|unauthori/i.test(stderr) ? "：需要登录对应 Agent CLI" : ""}\n${stderr.slice(-800)}`);
  child.once("error", (e) => {
    dead = true;
    fail(e);
  });
  child.once("exit", (code) => {
    dead = true;
    fail(exitError(code));
  });
  // Everything the agent says goes to the emitter of the turn in progress.
  let emit = emitSetup;
  let touch = () => {};
  let replaying = false;
  let text = "";
  let contextUsage: AgentResult["contextUsage"];
  let sessionId = "";
  // Text between tool calls; the last segment is the reply proper (see replyFromSegments).
  let segments: string[] = [""];
  // Whether the model produced anything real (text, thought, tool call) in the current turn.
  let gotOutput = false;
  // Remember unknown session update kinds once per process (for OMEM_DEBUG_ACP).
  const seenUnknown = new Set<string>();
  // The active prompt registers queue handling here so sessionUpdate can switch watchdogs.
  let promptQueue: { enter: (position?: number, message?: string) => void; exit: () => void } | null = null;
  const tools = new Map<string, { title: string; kind?: string; status?: string }>();
  const output = new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((resolve, reject) => child.stdin.write(chunk, (e) => (e ? reject(e) : resolve()))),
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      // Tap raw lines: the SDK validates session/update against its schema and drops
      // non-standard kinds (traex queue_begin/queue_end), so queue state is read here.
      let pending = "";
      child.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        pending += chunk.toString("utf8");
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (/queue/i.test(line)) sniffQueue(line);
        }
        if (pending.length > 1_000_000) pending = "";
      });
      child.stdout.once("end", () => {
        try {
          controller.close();
        } catch {}
      });
    },
  });
  function sniffQueue(line: string) {
    let msg: { method?: string; params?: { update?: Record<string, unknown> } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const u = msg.params?.update;
    if (msg.method !== "session/update" || !u) return;
    const q = queueStatusOf(u);
    if (!q) return;
    touch();
    emit({ type: "queue", ...q });
    if (q.queued) promptQueue?.enter(q.position, q.message);
    else promptQueue?.exit();
  }
  const connection = new ClientSideConnection(
    () => ({
      async requestPermission(request) {
        touch();
        const kind = request.toolCall.kind ?? "other";
        const allowed = opts.allowWrites || !["edit", "delete", "move"].includes(kind);
        const option = request.options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once")) ?? request.options.find((o) => o.kind.startsWith(allowed ? "allow" : "reject"));
        emit({ type: "status", text: `${allowed ? "允许" : "拒绝"}操作：${request.toolCall.title ?? kind}` });
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate({ sessionId: updatedSession, update }) {
        if (sessionId && updatedSession !== sessionId) return;
        touch();
        if (replaying) return; // history replayed by session/load is not new output
        switch (update.sessionUpdate) {
          case "usage_update":
            if (Number.isFinite(update.used) && update.used >= 0 && Number.isFinite(update.size) && update.size > 0) {
              contextUsage = { used: update.used, size: update.size };
              emit({ type: "usage", ...contextUsage });
            }
            break;
          case "agent_message_chunk":
            if (update.content.type === "text") {
              // CLI housekeeping notices (traex: "Skill descriptions were shortened…") are not the answer.
              if (AGENT_NOTICE.test(update.content.text)) {
                emit({ type: "status", text: update.content.text.trim().slice(0, 200) });
                break;
              }
              gotOutput = true;
              text += update.content.text;
              segments[segments.length - 1] += update.content.text;
              emit({ type: "text", text: update.content.text });
              // Some agents show provider queue state as ordinary message text.
              const q = QUEUE_TEXT.exec(update.content.text);
              if (q) {
                const position = q[1] ? Number(q[1]) : undefined;
                promptQueue?.enter(Number.isFinite(position) ? position : undefined);
              } else if (QUEUE_END_TEXT.test(update.content.text)) promptQueue?.exit();
            }
            break;
          case "agent_thought_chunk":
            gotOutput = true;
            if (update.content.type === "text") emit({ type: "thought", text: update.content.text });
            break;
          case "tool_call": {
            gotOutput = true;
            if (segments[segments.length - 1].trim()) segments.push("");
            const t = { title: update.title, kind: update.kind ?? undefined, status: update.status ?? "pending" };
            tools.set(update.toolCallId, t);
            emit({ type: "tool", id: update.toolCallId, ...t, input: update.rawInput });
            break;
          }
          case "tool_call_update": {
            const prev = tools.get(update.toolCallId) ?? { title: update.title ?? "tool" };
            const t = { ...prev, title: update.title ?? prev.title, status: update.status ?? prev.status };
            tools.set(update.toolCallId, t);
            if (update.status === "completed" || update.status === "failed") emit({ type: "tool", id: update.toolCallId, ...t });
            break;
          }
          case "plan":
            emit({ type: "plan", entries: update.entries.map((e) => ({ content: e.content, status: e.status })) });
            break;
          default: {
            // Non-standard kinds that survive SDK validation; queue state is read from raw lines (sniffQueue).
            if (!seenUnknown.has(update.sessionUpdate)) {
              seenUnknown.add(update.sessionUpdate);
              if (process.env.OMEM_DEBUG_ACP) console.warn(`[acp] 未识别的 sessionUpdate：${update.sessionUpdate}`, JSON.stringify(update).slice(0, 500));
            }
          }
        }
      },
      async readTextFile() {
        throw new Error("omem does not expose client fs");
      },
      async writeTextFile() {
        throw new Error("omem does not expose client fs");
      },
    }),
    ndJsonStream(output, input),
  );
  const close = () => {
    dead = true;
    stop(child);
  };
  // Setup gets the profile's idle budget too.
  const setupWatch = idleWatchdog(profile.idleTimeoutMs, () => {
    fail(new Error(`Agent 超过 ${Math.round(profile.idleTimeoutMs / 1000)} 秒没有任何活动，已停止`));
    close();
  });
  touch = () => setupWatch.touch();
  try {
    const init = await Promise.race([
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "omem", version: "0.2.0" },
      }),
      failed,
    ]);
    touch();
    const caps = init.agentCapabilities as { mcpCapabilities?: { http?: boolean }; loadSession?: boolean; sessionCapabilities?: { resume?: unknown; delete?: unknown } } | undefined;
    const httpMcp = !!caps?.mcpCapabilities?.http;
    const mcpServers: McpServer[] = opts.mcp
      ? httpMcp
        ? [{ type: "http", name: "omem", url: opts.mcp.url, headers: [{ name: "authorization", value: `Bearer ${opts.mcp.token}` }] }]
        : [
            {
              name: "omem",
              command: opts.mcp.stdio.command,
              args: opts.mcp.stdio.args,
              env: Object.entries({ OMEM_URL: opts.mcp.baseUrl, OMEM_TOKEN: opts.mcp.token }).map(([name, value]) => ({ name, value })),
            },
          ]
      : [];
    for (const [name, srv] of Object.entries(opts.extraMcp ?? {})) {
      if ("url" in srv) {
        if (httpMcp) mcpServers.push({ type: "http", name, url: srv.url, headers: Object.entries(srv.headers).map(([n, value]) => ({ name: n, value })) });
        else emitSetup({ type: "status", text: `该 Agent 不支持 HTTP MCP，跳过 ${name}` });
      } else mcpServers.push({ name, command: srv.command, args: srv.args, env: Object.entries(srv.env).map(([n, value]) => ({ name: n, value })) });
    }
    type SessionInfo = {
      sessionId?: string;
      modes?: { availableModes: { id: string }[]; currentModeId: string } | null;
      configOptions?: SessionConfigOption[] | null;
      /** Older agents (gemini, qwen, …) list models here and switch with session/set_model. */
      models?: { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string } | null;
    };
    let session: SessionInfo | null = null;
    let resumed = false;
    if (opts.resumeSessionId && (caps?.sessionCapabilities?.resume || caps?.loadSession)) {
      try {
        if (caps.sessionCapabilities?.resume)
          session = (await Promise.race([connection.resumeSession({ sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers }), failed])) as SessionInfo;
        else {
          replaying = true;
          session = (await Promise.race([connection.loadSession({ sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers }), failed])) as SessionInfo;
          replaying = false;
        }
        sessionId = opts.resumeSessionId;
        resumed = true;
      } catch (e) {
        replaying = false;
        if (dead) throw e;
        emitSetup({ type: "status", text: `无法恢复之前的 Agent 会话，改为新会话：${(e as Error).message.slice(0, 120)}` });
      }
    }
    if (!session) {
      session = (await Promise.race([connection.newSession({ cwd: opts.cwd, mcpServers }), failed])) as SessionInfo;
      sessionId = session.sessionId!;
    }
    touch();
    // Permission mode: prefer the role's choice when the agent offers it.
    let disposal: Promise<void> | undefined;
    const discard = () => disposal ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        if (!resumed && !caps?.sessionCapabilities?.delete && profile.archiveArgs?.length) {
          close();
          await archiveSession(profile, sessionId, opts.cwd, opts.env);
        } else if (!dead && caps?.sessionCapabilities?.delete && !resumed) {
          // A cancelled/failed prompt has already rejected `failed`; cleanup has its own budget.
          await Promise.race([connection.deleteSession({ sessionId }), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("会话清理超时")), 5000);
          })]);
        } else if (!resumed && !caps?.sessionCapabilities?.delete && !opts.probe) {
          emitSetup({ type: "status", text: "该后端不支持自动清理会话，历史可能仍显示在后端列表中" });
        }
      } catch (e) {
        emitSetup({ type: "status", text: `后端会话清理失败：${(e as Error).message.slice(0, 120)}` });
      } finally {
        clearTimeout(timer);
        close();
      }
    })();
    const modes = session.modes?.availableModes ?? [];
    const wanted = pickMode(opts.modes ?? [], modes.map((m) => m.id));
    if (wanted && session.modes?.currentModeId !== wanted) await Promise.race([connection.setSessionMode({ sessionId, modeId: wanted }), failed]);
    let options = session.configOptions ?? [];
    const agentName = init.agentInfo?.name ?? profile.command;
    if (opts.probe) {
      const effortsByModel = await probeEfforts(connection, sessionId, options, failed);
      const probe = {
        agent: `${init.agentInfo?.name ?? profile.command} ${init.agentInfo?.version ?? ""}`.trim(),
        modes: modes.map((m) => m.id),
        options: [
          ...options.map((o) => ({ id: o.id, category: (o as { category?: string }).category ?? null, current: (o as { currentValue?: string }).currentValue ?? null, values: optionValues(o) })),
          ...(!options.some(isModelOption) && session.models?.availableModels?.length
            ? [{ id: "model", category: "model", current: session.models.currentModelId ?? null, values: session.models.availableModels.map((m) => m.modelId) }]
            : []),
        ],
        ...(effortsByModel ? { effortsByModel } : {}),
      };
      await discard();
      return { sessionId, agent: agentName, resumed, alive: () => false, prompt: async () => ({ text: "", stopReason: "probe", agent: agentName }), close, discard, probe };
    }
    for (const [key, value] of [
      ["model", profile.model],
      ["effort", profile.effort],
    ] as const) {
      if (!value) continue;
      const option = options.find((o) => (key === "model" ? isModelOption(o) : o.category === "thought_level" || /effort|reasoning/.test(o.id)));
      if (!option && key === "model" && session.models?.availableModels?.length) {
        const ids = session.models.availableModels.map((m) => m.modelId);
        const chosen = resolveModelOption(value, ids);
        if (!chosen.matched) {
          if (opts.strictSelection?.model) throw new Error(`指定模型 ${value} 不可用，可选：${ids.join(", ")}`);
          emitSetup({ type: "status", text: `该 Agent 没有 ${value}，可选：${ids.join(", ")}；用它的默认模型` });
          continue;
        }
        if (session.models.currentModelId !== chosen.value) await Promise.race([connection.extMethod("session/set_model", { sessionId, modelId: chosen.value }), failed]);
        if (chosen.value !== value) emitSetup({ type: "status", text: `模型名按 ${value} 匹配为 ${chosen.value}` });
        continue;
      }
      if (!option) {
        if (opts.strictSelection?.[key]) throw new Error(`该 Agent 不支持设置 ${key}，无法使用指定值 ${value}`);
        emitSetup({ type: "status", text: `该 Agent 不支持设置 ${key}，使用其默认值` });
        continue;
      }
      const values = optionValues(option);
      const chosen = key === "model" ? resolveModelOption(value, values) : { value, matched: values.includes(value) };
      if (!chosen.matched) {
        if (opts.strictSelection?.[key]) throw new Error(`指定 ${key}=${value} 不可用，可选：${values.join(", ")}`);
        // Never kill the conversation over a model name: fall back to the agent default.
        emitSetup({ type: "status", text: `该 Agent 没有 ${value}，可选：${values.join(", ")}；用它的默认${key === "model" ? "模型" : "思考强度"}` });
        continue;
      }
      if ((option as { currentValue?: string }).currentValue === chosen.value) continue;
      const reply = await Promise.race([connection.setSessionConfigOption({ sessionId, configId: option.id, value: chosen.value }), failed]);
      options = reply.configOptions ?? options;
    }
    emitSetup({ type: "status", text: `${resumed ? "已恢复" : "已连接"} ${agentName}${profile.model ? ` · ${profile.model}` : ""}` });
    setupWatch.close();
    let busy = false;
    return {
      sessionId,
      agent: agentName,
      resumed,
      alive: () => !dead,
      close,
      discard,
      async prompt(promptText, turnEmit, signal) {
        if (dead) throw new Error("Agent 进程已结束");
        if (busy) throw new Error("这个 Agent 会话正在处理上一条消息");
        busy = true;
        emit = turnEmit;
        text = "";
        contextUsage = undefined;
        segments = [""];
        gotOutput = false;
        // A fresh failure channel for this turn: an earlier exit error has already been consumed.
        failed = new Promise<never>((_, reject) => (fail = reject));
        failed.catch(() => {});
        // Silence before the model's first token is the provider not starting the request
        // (queue/capacity); silence after real output is a stalled turn. Only the former is
        // worth retrying on a fallback backend/model.
        const idleError = () =>
          gotOutput
            ? agentRunError(`Agent 超过 ${Math.round(profile.idleTimeoutMs / 1000)} 秒没有任何活动，已停止`, "idle")
            : agentRunError(`模型 ${Math.round(profile.idleTimeoutMs / 1000)} 秒内没有开始回答（可能在服务端排队），已停止`, "queue", true);
        // Two budgets: ordinary idle (any update resets it) and a separate, usually longer
        // cap for time spent in the provider queue. Queue events pause the idle watchdog.
        let idleW = idleWatchdog(profile.idleTimeoutMs, () => {
          fail(idleError());
          close();
        });
        let queueW: ReturnType<typeof idleWatchdog> | null = null;
        const startIdle = () => {
          idleW.close();
          idleW = idleWatchdog(profile.idleTimeoutMs, () => {
            fail(idleError());
            close();
          });
        };
        let entered = false;
        let queuedAt = 0;
        let lastPosition: number | undefined;
        promptQueue = {
          enter(position) {
            // Time in the provider queue is not idleness: only the queue budget (if any) applies.
            idleW.close();
            if (entered && position === lastPosition) return;
            const first = !entered;
            entered = true;
            lastPosition = position;
            if (first) {
              queuedAt = Date.now();
              if (!queueW && opts.queueTimeoutMs && opts.queueTimeoutMs > 0) {
                queueW = idleWatchdog(opts.queueTimeoutMs, () => {
                  fail(agentRunError(`排队超过 ${Math.round(opts.queueTimeoutMs! / 60000)} 分钟仍未开始，已停止`, "queue", true));
                  close();
                });
              }
            }
            emit({ type: "status", text: `模型排队中${position ? `，前方约 ${position} 位` : ""}…` });
          },
          exit() {
            if (entered) emit({ type: "status", text: `排队结束（约 ${Math.max(1, Math.round((Date.now() - queuedAt) / 1000))} 秒），开始处理` });
            entered = false;
            lastPosition = undefined;
            queueW?.close();
            queueW = null;
            startIdle();
            idleW.touch();
          },
        };
        // While queued, updates (traex sends the queue status as a standard session_info_update the
        // SDK also delivers) must not re-arm the idle timer: only the queue budget applies.
        touch = () => {
          if (!entered) idleW.touch();
        };
        const onAbort = () => {
          void connection.cancel({ sessionId }).catch(() => {});
          fail(new Error("CANCELLED"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await Promise.race([connection.prompt({ sessionId, prompt: [{ type: "text", text: promptText }] }), failed]);
          if (signal?.aborted) throw new Error("CANCELLED");
          return { text, reply: replyFromSegments(segments), stopReason: result.stopReason, sessionId, agent: agentName, contextUsage };
        } finally {
          idleW.close();
          (queueW as ReturnType<typeof idleWatchdog> | null)?.close();
          promptQueue = null;
          signal?.removeEventListener("abort", onAbort);
          touch = () => {};
          emit = () => {};
          busy = false;
        }
      },
    };
  } catch (error) {
    setupWatch.close();
    close();
    throw explain(error, profile);
  }
}

/** JSON-RPC errors carry the useful part ("GOOSE_PROVIDER not set", "please log in") in `data`. */
function explain(error: unknown, profile: AgentProfile) {
  if (!(error instanceof Error) || !("code" in error)) return error;
  const e = error as Error & { data?: unknown };
  const detail = e.data === undefined || e.data === null ? "" : typeof e.data === "string" ? e.data : JSON.stringify(e.data).slice(0, 400);
  const text = `${e.message}${detail ? "：" + detail : ""}`;
  const cli = profile.command === "npx" || profile.command === "uvx" ? `${profile.command} ${profile.args.filter((a) => !a.startsWith("-") || a === "-y").slice(0, 2).join(" ")}` : profile.command;
  const hint = /auth|login|log in|api.?key|credential|provider|configur/i.test(text) ? `（先在终端直接运行 ${cli} 完成登录或配置，再回来使用）` : "";
  return new Error(text + hint);
}

/** One prompt turn against an ACP agent (Codex/TraeX/Claude Code adapters…). */
export async function runAcp(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const onAbort = () => {};
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const handle = await openAcp(profile, { cwd: req.cwd, mcp: req.mcp, extraMcp: req.extraMcp, allowWrites: req.allowWrites, modes: req.modes, env: req.env, resumeSessionId: req.resumeSessionId, probe: req.probe, strictSelection: req.strictSelection, queueTimeoutMs: req.queueTimeoutMs }, emit);
  try {
    if (req.probe) return { text: "", stopReason: "probe", agent: handle.agent, probe: handle.probe };
    if (req.signal?.aborted) throw new Error("CANCELLED");
    return await handle.prompt(req.prompt, emit, req.signal);
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
    if (!req.persistSession && !req.resumeSessionId) await handle.discard();
    else handle.close();
  }
}

function isModelOption(o: SessionConfigOption) {
  return (o as { category?: string }).category === "model" || o.id === "model";
}

/** Agents name permission modes differently; map omem's role modes onto what the agent offers. */
const MODE_ALIASES: Record<string, string[]> = {
  "read-only": ["read-only", "readonly", "read_only", "ask"],
  plan: ["plan", "architect"],
  default: ["default", "normal", "code"],
  acceptEdits: ["acceptEdits", "accept-edits", "auto_edit", "autoEdit", "auto-edit"],
  auto: ["auto", "agent", "act"],
};
export function pickMode(wanted: string[], available: string[]) {
  for (const w of wanted) for (const alias of MODE_ALIASES[w] ?? [w]) if (available.includes(alias)) return alias;
  return undefined;
}

/**
 * Queue state from a session/update, when the agent reports it: traex sends
 * `session_info_update._meta.trae.queueStatus` ({ state: queued|waiting|ready, position, message })
 * with its headless_queue_status feature on; older builds used ad-hoc queue_* update kinds.
 */
export function queueStatusOf(u: Record<string, unknown>): { queued: boolean; position?: number; message?: string } | null {
  const kind = String(u.sessionUpdate ?? "");
  const meta = (u._meta as { trae?: { queueStatus?: Record<string, unknown> } } | undefined)?.trae?.queueStatus;
  let src: Record<string, unknown> | undefined;
  let state = "";
  if (meta && typeof meta === "object") {
    src = meta;
    state = String(meta.state ?? meta.status ?? "");
  } else if (/queue/i.test(kind) || /queue/i.test(String(u.state ?? ""))) {
    if (/^(agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update|plan)$/.test(kind)) return null;
    src = u;
    state = String(u.state ?? kind);
  }
  if (!src) return null;
  const pos = src.position ?? src.queue_position ?? src.queuePosition;
  const position = typeof pos === "number" && Number.isFinite(pos) ? pos : undefined;
  const message = typeof src.message === "string" && src.message.trim() ? src.message.trim() : undefined;
  const queued = /queued|waiting|wait|pending|begin|position/i.test(state) && !/end|ready|done|finish|start(ed)?$|running|dequeued/i.test(state);
  return { queued, position, message };
}

/**
 * Some agents (traex) offer a reasoning-effort option only after a model that has one is selected,
 * so the default model's session says nothing about effort. Switch through the offered models in
 * the probe session and record each one's levels. Returns undefined when there is no model option.
 */
async function probeEfforts(connection: ClientSideConnection, sessionId: string, options: SessionConfigOption[], failed: Promise<never>): Promise<Record<string, string[]> | undefined> {
  const modelOpt = options.find(isModelOption);
  if (!modelOpt) return undefined;
  const isEffort = (o: SessionConfigOption) => !isModelOption(o) && ((o as { category?: string }).category === "thought_level" || /effort|reasoning/i.test(o.id));
  const out: Record<string, string[]> = {};
  const current = (modelOpt as { currentValue?: string }).currentValue;
  const initialEffort = options.find(isEffort);
  if (current) out[current] = initialEffort ? optionValues(initialEffort) : [];
  for (const model of optionValues(modelOpt).slice(0, 60)) {
    if (model in out) continue;
    try {
      const reply = await Promise.race([connection.setSessionConfigOption({ sessionId, configId: modelOpt.id, value: model }), failed, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 10_000))]);
      const effort = (reply.configOptions ?? []).find(isEffort);
      out[model] = effort ? optionValues(effort) : [];
    } catch {
      // A model that cannot be selected just has no recorded levels.
    }
  }
  return out;
}
