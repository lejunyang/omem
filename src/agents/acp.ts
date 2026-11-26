import { keyedModelEnv } from "../core/config.ts";
import { ClientSideConnection, ndJsonStream, type McpServer, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { Readable } from "node:stream";
import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { archiveSession } from "./session-archive.ts";
import { resolveModelOption } from "./models.ts";
import { launchConfigEnv, requirePluginBackend } from "./catalog.ts";
import { sandboxStartError, idleWatchdog, launch, stop } from "./spawn.ts";
import { accountOf } from "./sandbox.ts";
import { isQuotaMessage } from "./capacity.ts";
import { claudeRateLimitEvent } from "./quota.ts";
import { agentRunError, replyFromSegments, sessionPrompt, type AgentEvent, type AgentProbe, type AgentRequest, type AgentResult, type SessionCleanup } from "./types.ts";
import { keyEnv } from "../core/ai-keys.ts";
import { NetworkUnavailableError } from "./network-policy.ts";

// Provider queue text shown as a normal message by some CLIs (traex included).
const QUEUE_TEXT = /(?:排队|队列|queue[d]?|waiting (?:in )?(?:the )?queue)[^\d]{0,20}(\d+)?/i;
const QUEUE_END_TEXT = /(?:已排到|轮到你|队列已结束|(?:no longer|out of) (?:in )?queue|开始处理你的请求)/i;
// Housekeeping lines some CLIs print as message text before the model answers.
// Also the agent's own warnings about its setup (a model its catalog has no metadata for, features under development).
const AGENT_NOTICE = /^\s*(?:Skill descriptions were shortened|Disable unused skills or plugins|Warning: (?:Model metadata for\b|Under-development features enabled))/i;
/**
 * Codex hands a provider's error back as the turn's last message instead of failing it: "exceeded
 * retry limit, last status: 429 Too Many Requests", "unexpected status 403 Forbidden: …", "We're
 * currently experiencing high demand…". Such a turn is a failure (`codexErrorReply`).
 */
const CODEX_ERROR_REPLY = /^(?:exceeded retry limit, last status: (\d{3})\b|unexpected status (\d{3})\b|We[’']re currently experiencing high demand\b)/i;
export function codexErrorReply(last: string): Error | null {
  const m = CODEX_ERROR_REPLY.exec(last.trim());
  if (!m) return null;
  const status = Number(m[1] ?? m[2] ?? 503);
  // Busy or failing upstream: worth another backend. A refusal (403, 404…): not retried as busy.
  return agentRunError(`后端报错：${last.trim().slice(0, 300)}`, status === 429 || status >= 500 ? "rate-limit" : "other");
}
const STREAM_QUOTA_NOTICE = /^⚠\uFE0F? Individual quota reached\. Please upgrade your subscription to increase your limits\.(?: Resets in (?:\d+[dhms]\s*)+\.)?$/i;

function optionValues(option: SessionConfigOption): string[] {  if (option.type !== "select") return [];
  const out: string[] = [];
  for (const o of option.options as unknown[]) {
    const group = o as { options?: { value: string }[]; value?: string };
    if (Array.isArray(group.options)) out.push(...group.options.map((x) => x.value));
    else if (typeof group.value === "string") out.push(group.value);
  }
  return out;
}

/** Option names → values, for a model chosen by the name the agent shows (Doubao's ids are numbers). */
function optionNames(option: SessionConfigOption): Map<string, string> {
  const out = new Map<string, string>();
  if (option.type !== "select") return out;
  for (const o of option.options as unknown[]) {
    const group = o as { options?: { value: string; name?: string }[]; value?: string; name?: string };
    for (const x of Array.isArray(group.options) ? group.options : [group]) if (typeof x.value === "string" && typeof x.name === "string" && x.name) out.set(x.name, x.value);
  }
  return out;
}
/** A model by its value first, then by the name shown for it. */
function resolveModelChoice(typed: string, values: string[], names: Map<string, string>) {
  const byValue = resolveModelOption(typed, values);
  if (byValue.matched) return byValue;
  const name = resolveModelOption(typed, [...names.keys()]);
  return name.matched ? { value: names.get(name.value)!, matched: true } : byValue;
}

/**
 * What the agent tells about each model besides its id: the entry's description and `_meta` (a
 * provider may put a model's daily limit or what is left of it there). Kept as text, not parsed:
 * which fields mean what differs per agent, and the chooser reads it as written.
 */
export function modelNotes(option: SessionConfigOption | undefined, available?: { modelId: string; name?: string; description?: string | null; _meta?: unknown }[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (id: unknown, e: { name?: unknown; description?: unknown; _meta?: unknown }) => {
    if (typeof id !== "string") return;
    const parts = [
      typeof e.description === "string" && e.description.trim() ? e.description.trim() : "",
      e._meta && typeof e._meta === "object" && Object.keys(e._meta).length ? JSON.stringify(e._meta) : "",
    ].filter(Boolean);
    if (parts.length) out[id] = parts.join(" ").slice(0, 300);
  };
  if (option?.type === "select") {
    for (const o of option.options as unknown[]) {
      const group = o as { options?: Record<string, unknown>[]; value?: unknown };
      if (Array.isArray(group.options)) for (const x of group.options) add(x.value, x);
      else add(group.value, group as Record<string, unknown>);
    }
  }
  for (const m of available ?? []) add(m.modelId, m);
  return out;
}

export type AcpOpenOptions = {
  ownSandbox?: AgentRequest["ownSandbox"];
  workspace?: AgentRequest["workspace"];
  app?: App;
  runId?: string | null;
  signal?: AbortSignal;
  cwd: string;
  cleanup?: SessionCleanup;
  mcp?: AgentRequest["mcp"];
  extraMcp?: AgentRequest["extraMcp"];
  allowWrites?: boolean;
  modes?: string[];
  fullAccess?: boolean;
  acpWritable?: boolean;
  env?: Record<string, string>;
  /** Continue an earlier agent session (resume, or load when only that is offered). */
  resumeSessionId?: string;
  /** Standing instructions, as the session's system prompt when the agent takes one. */
  system?: string;
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
  /** true when the standing instructions went in as the session's system prompt. */
  system: boolean;
  alive(): boolean;
  prompt(text: string, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult>;
  close(): void;
  stopped?: Promise<void>;
  /** Remove an omem-owned temporary session from the backend list, when advertised. */
  discard(): Promise<void>;
  /**
   * Hand words to the turn in progress without waiting for it to call a tool (codex-acp's
   * `_session/steering`): "injected" when the turn took them; otherwise the caller keeps them for later.
   */
  steer(text: string): Promise<"injected" | "idle" | "unsupported" | "failed">;
  probe?: AgentProbe;
};

/** How long a run that named a thinking level waits, within one session, for the agent to list that setting. */
let effortWaitMs = 3_000;
export function setEffortWaitForTests(ms: number) {
  effortWaitMs = ms;
}

/**
 * How long to wait before opening a fresh session when the agent listed less than it is known to have
 * (openAcpOnce `cutDown`): for a run whose model or level was named, and for the others (which go on with
 * the agent's defaults once these are used up).
 */
let catalogRetryMs = { named: [15_000, 30_000, 60_000, 120_000], other: [15_000, 45_000] };
export function setCatalogRetryForTests(v: typeof catalogRetryMs) {
  const before = catalogRetryMs;
  catalogRetryMs = v;
  return before;
}

/**
 * Open a session, and open a fresh one after a wait when the agent's list of models or thinking levels
 * came back cut down. An adapter that cannot fetch its model catalog at that moment (a flaky network, a
 * login being refreshed) serves a shorter built-in list without thinking levels; seen on a real machine,
 * the same backend lists everything again a minute or a few later, and a session started on the cut-down
 * list tends to hang. A run that named its model or level keeps trying for some minutes and then fails
 * with a retryable error; one that did not goes on with the agent's defaults after two tries.
 */
export async function openAcp(profile: AgentProfile, opts: AcpOpenOptions, emitSetup: (e: AgentEvent) => void = () => {}): Promise<AcpHandle> {
  const named = !!(opts.strictSelection?.model || opts.strictSelection?.effort);
  const waits = named ? catalogRetryMs.named : catalogRetryMs.other;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= waits.length;
    try {
      return await openAcpOnce(profile, last && !named ? { ...opts, tolerateCatalog: true } : opts, emitSetup);
    } catch (e) {
      if (!(e instanceof Error) || (e as { kind?: string }).kind !== "catalog" || last || opts.probe || opts.signal?.aborted) throw e;
      const wait = waits[attempt];
      emitSetup({ type: "status", text: `${e.message}；${Math.round(wait / 1000)} 秒后重开会话再试（第 ${attempt + 1} 次）` });
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new Error("CANCELLED")); };
        const timer = setTimeout(() => { opts.signal?.removeEventListener("abort", onAbort); resolve(); }, wait);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

async function openAcpOnce(profile: AgentProfile, opts: AcpOpenOptions & { tolerateCatalog?: boolean }, emitSetup: (e: AgentEvent) => void = () => {}): Promise<AcpHandle> {
  if (opts.signal?.aborted) throw new Error("CANCELLED");
  // What this backend listed the last time it was probed (probe.ts): what it is known to have.
  const probes = opts.app && !opts.probe ? await import("./probe.ts") : null;
  const known = probes ? probes.cachedProbe(opts.app!, profile.id, accountOf(profile)?.userId) : null;
  // The model and level go in at launch where the backend takes them (catalog.ts launchConfig): the session then
  // runs on them even while its catalog lists neither. A level the backend is known not to have for the model is left out.
  const levelKnown = !profile.effort || !probes || !known || !!known.error || probes.effortsFor(known, profile.model).includes(profile.effort);
  // A key's model settings (Codex's context window in its CODEX_CONFIG) are the base the launch config adds to.
  const atLaunch = opts.probe ? {} : launchConfigEnv({ ...profile, env: { ...profile.env, ...keyedModelEnv(profile) } }, { model: profile.model, effort: levelKnown ? profile.effort : null });
  const env = { ...profile.env, ...keyEnv(profile), ...atLaunch, ...opts.mcp?.env, ...opts.env };
  const child = await (await import("./egress-run.ts")).launchRun(profile, opts, sandbox => {
    requirePluginBackend(profile);
    return launch(profile.command, profile.args, { cwd: opts.cwd, env, workspace: opts.workspace, ownSandbox: opts.ownSandbox, sandbox });
  });
  const guardedToken = env.OMEM_COMMAND_GATE && env.OMEM_TOKEN === opts.mcp?.token ? opts.mcp?.token : undefined;
  const stopped = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
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
  /** The newest option list the agent sent on its own (`config_option_update`), until setup reads it. */
  let announced: SessionConfigOption[] | null = null;
  let onAnnounced: (() => void) | null = null;
  let text = "";
  let contextUsage: AgentResult["contextUsage"];
  let sessionId = "";
  let discard: (() => Promise<void>) | undefined;
  /** Set when setup gives up on a session it resumed that is still good (a cut-down catalog): it is not deleted. */
  let keepSession = false;
  // Text between tool calls; the last segment is the reply proper (see replyFromSegments).
  let segments: string[] = [""];
  // Whether the model produced anything real (text, thought, tool call) in the current turn.
  let gotOutput = false;
  // Remember unknown session update kinds once per process (for OMEM_DEBUG_ACP).
  const seenUnknown = new Set<string>();
  // The active prompt registers queue handling here so sessionUpdate can switch watchdogs.
  let promptQueue: { enter: (position?: number, message?: string) => void; exit: () => void } | null = null;
  const tools = new Map<string, { title: string; kind?: string; status?: string; startedAt?: number }>();
  const output = new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((resolve, reject) => child.stdin.write(chunk, (e) => (e ? reject(e) : resolve()))),
  });
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  // Tap raw lines: the SDK validates session/update against its schema and drops
  // non-standard kinds (traex queue_begin/queue_end), so queue state is read here.
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (/queue/i.test(line)) sniffQueue(line);
    }
    if (pending.length > 1_000_000) pending = "";
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
        const { acpPermission } = await import("./acp-permission.ts");
        const { optionId, message } = await acpPermission(request, {
          app: opts.app, token: opts.mcp?.token, runId: opts.runId, backend: profile.id, cwd: opts.cwd,
          guardedDir: guardedToken ? env.OMEM_COMMAND_GATE : undefined,
          writable: opts.acpWritable ?? !!opts.allowWrites,
        });
        emit({ type: "status", text: message });
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate({ sessionId: updatedSession, update }) {
        if (sessionId && updatedSession !== sessionId) return;
        touch();
        if (update.sessionUpdate === "config_option_update") {
          announced = update.configOptions;
          onAnnounced?.();
          return;
        }
        if (replaying) return; // history replayed by session/load is not new output
        switch (update.sessionUpdate) {
          case "usage_update": {
            // claude-agent-acp passes Claude's rate-limit info along on a usage update.
            const limit = claudeRateLimitEvent((update._meta as Record<string, unknown> | undefined)?.["_claude/rateLimit"]);
            if (limit) emit(limit);
            if (Number.isFinite(update.used) && update.used >= 0 && Number.isFinite(update.size) && update.size > 0) {
              contextUsage = { used: update.used, size: update.size };
              emit({ type: "usage", ...contextUsage });
            }
            break;
          }
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
              if (!STREAM_QUOTA_NOTICE.test(update.content.text.trim())) emit({ type: "text", text: update.content.text });
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
            const t = { title: update.title, kind: update.kind ?? undefined, status: update.status ?? "pending", startedAt: Date.now() };
            tools.set(update.toolCallId, t);
            emit({ type: "tool", id: update.toolCallId, title: t.title, kind: t.kind, status: t.status, input: update.rawInput });
            break;
          }
          case "tool_call_update": {
            const prev = tools.get(update.toolCallId) ?? { title: update.title ?? "tool" };
            const t = { ...prev, title: update.title ?? prev.title, status: update.status ?? prev.status };
            tools.set(update.toolCallId, t);
            // How long the call took (diag reports the p90; slow omem tools show up there).
            const { startedAt, ...shown } = t;
            if (update.status === "completed" || update.status === "failed") {
              const output = toolOutput(update.content, update.rawOutput);
              emit({ type: "tool", id: update.toolCallId, ...shown, ...(startedAt ? { ms: Date.now() - startedAt } : {}), ...(output ? { output } : {}) });
            }
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
  const onSetupAbort = () => { fail(new Error("CANCELLED")); close(); };
  opts.signal?.addEventListener("abort", onSetupAbort, { once: true });
  if (opts.signal?.aborted) onSetupAbort();
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
        clientInfo: { name: "omem", version: "0.0.1" },
      }),
      failed,
    ]);
    touch();
    const caps = init.agentCapabilities as { mcpCapabilities?: { http?: boolean }; loadSession?: boolean; sessionCapabilities?: { resume?: unknown; delete?: unknown; systemPrompt?: unknown } } | undefined;
    const httpMcp = !!caps?.mcpCapabilities?.http;
    // Standing instructions as the system prompt (ACP systemPrompt, append mode): not a message the
    // agent can compact away, and Codex keeps them with a resumed session. Sent again on resume,
    // since some agents (Claude Code) set the system prompt per process.
    const system = opts.system && caps?.sessionCapabilities?.systemPrompt ? { systemPrompt: { mode: "append", content: [{ type: "text", text: opts.system }] } } : {};
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
          session = (await Promise.race([connection.resumeSession({ sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers, ...system }), failed])) as SessionInfo;
        else {
          replaying = true;
          session = (await Promise.race([connection.loadSession({ sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers, ...system }), failed])) as SessionInfo;
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
      session = (await Promise.race([connection.newSession({ cwd: opts.cwd, mcpServers, ...system }), failed])) as SessionInfo;
      sessionId = session.sessionId!;
    }
    opts.cleanup?.created(sessionId);
    let disposal: Promise<void> | undefined;
    discard = () => disposal ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const operation = async () => {
          if (opts.signal?.reason instanceof NetworkUnavailableError) throw opts.signal.reason;
          if (resumed) return;
          if (!caps?.sessionCapabilities?.delete && profile.archiveArgs?.length) {
            close();
            await archiveSession(profile, sessionId, opts.cwd, opts.env);
          } else if (caps?.sessionCapabilities?.delete) {
            // A cancelled/failed prompt has already rejected `failed`; cleanup has its own budget.
            // The agent keeps sessions on disk, so one whose process has gone (or whose connection
            // closed while it sat idle in the background pool) is deleted through a new connection.
            const here = dead ? Promise.reject(new Error("ACP connection closed")) : connection.deleteSession({ sessionId }).catch(e => { throw promptError(e); });
            await Promise.race([here, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("会话清理超时")), 5000);
            })]).catch(async (e) => {
              if (!dead && !/connection closed|EPIPE|ECONNRESET|会话清理超时/i.test((e as Error).message)) throw e;
              close();
              if (opts.signal?.reason instanceof NetworkUnavailableError) throw opts.signal.reason;
              await deleteAcpSession(profile, sessionId, opts.cwd, { ...opts.mcp?.env, ...opts.env }, opts.signal?.reason instanceof NetworkUnavailableError ? opts.signal : undefined);
            });
          } else {
            throw new Error("该后端不支持自动清理会话，历史可能仍显示在后端列表中");
          }
        };
        if (opts.cleanup && !resumed) await opts.cleanup.discard(sessionId, operation);
        else await operation();
      } catch (e) {
        emitSetup({ type: "status", text: `后端会话清理失败：${(e as Error).message.slice(0, 120)}` });
      } finally {
        clearTimeout(timer);
        close();
      }
    })();
    // Persist ownership before events or setup choices can fail or the host can exit.
    if (!opts.probe) emitSetup({ type: "session", sessionId, resumed });
    touch();
    // Permission mode: prefer the role's choice when the agent offers it.
    const modes = session.modes?.availableModes ?? [];
    const full = opts.fullAccess && !opts.probe ? pickMode(["full-access"], modes.map((m) => m.id)) : undefined;
    if (opts.fullAccess && !opts.probe) emit({ type: "status", text: full ? `完全访问：${full}（${opts.ownSandbox || accountOf(profile) ? "后端自己的沙箱和审批关了，边界是 omem 的沙箱" : "命令不进沙箱、不审批"}）` : "这个后端没有完全访问模式，仍按沙箱和审批运行" });
    const wanted = full ?? pickMode(opts.modes ?? [], modes.map((m) => m.id));
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
        ...(() => {
          const notes = modelNotes(options.find(isModelOption), session.models?.availableModels);
          return Object.keys(notes).length ? { modelNotes: notes } : {};
        })(),
      };
      await discard();
      return { sessionId, agent: agentName, resumed, system: false, alive: () => false, prompt: async () => ({ text: "", stopReason: "probe", agent: agentName }), close, discard, steer: async () => "unsupported", probe };
    }
    // What this backend listed the last time it was probed (probe.ts). A session that lists less than that
    // got a cut-down catalog: not “this agent has no such model / level”, but “not right now” (see openAcp).
    // The model and level the session itself says it is on (“model[level]” or “model/level”), which is how one
    // started on a launch-time config shows them when its catalog lists neither.
    const onNow = /^(.*?)(?:\[([^\]]+)\]|\/([^/]+))?$/.exec(session.models?.currentModelId ?? "");
    const levelNow = onNow?.[2] ?? onNow?.[3] ?? null;
    const cutDown = (key: "model" | "effort", value: string, offered: string[]) => {
      if (opts.tolerateCatalog || !probes || !known || known.error) return;
      const usual = key === "model" ? known.models ?? [] : probes.effortsFor(known, profile.model);
      if (!(key === "model" ? resolveModelOption(value, usual).matched : usual.includes(value))) return;
      // A session being resumed is kept: the next try picks it up again.
      keepSession = resumed;
      const now = offered.length ? `这次只列出 ${offered.slice(0, 12).join("、")}` : key === "effort" ? "这次没有列出思考强度" : "这次没有列出模型";
      // Either it could not fetch its model catalog just now, or it no longer has this one and the probe is old: the same from here.
      throw agentRunError(`指定的${key === "model" ? "模型" : "思考强度"} ${value} 这次不可用：${agentName} 上次检测时有它，${now}（多半是它这会儿没取到模型目录；一直这样就在 设置 → AI 里重新检测）`, "catalog");
    };
    for (const [key, value] of [
      // A third party's key: the model went in at launch; the agent's own list has only its vendor's models.
      ["model", profile.keyModels ? undefined : profile.model],
      ["effort", profile.effort],
    ] as const) {
      if (!value) continue;
      const find = () => options.find((o) => (key === "model" ? isModelOption(o) : o.category === "thought_level" || /effort|reasoning/.test(o.id)));
      let option = find();
      if (!option && key === "effort" && levelNow !== value) {
        // An adapter may list the thinking levels only in its answer to a model choice, or some seconds after the
        // session opens: one has opened sessions before its model list was loaded, and a run that named a level
        // then failed within a second and passed when retried. So ask again by choosing the model it already has,
        // and when the level was asked for by name keep asking for a while before deciding there is no such setting.
        const started = Date.now();
        const until = started + (opts.strictSelection?.effort ? effortWaitMs : 0);
        for (let pause = 300; ; pause = Math.min(pause * 2, 2_500)) {
          if (announced) {
            options = announced;
            announced = null;
            option = find();
            if (option) break;
          }
          const model = options.find(isModelOption) as { id: string; currentValue?: string } | undefined;
          if (model?.currentValue) {
            const again = await Promise.race([connection.setSessionConfigOption({ sessionId, configId: model.id, value: model.currentValue }), failed]).catch(() => null);
            if (again?.configOptions) options = again.configOptions;
            option = find();
          }
          if (option || Date.now() >= until) break;
          if (pause === 300) emitSetup({ type: "status", text: "后端还没列出思考强度的选项，等它加载完再取" });
          await Promise.race([
            new Promise<void>((done) => {
              const timer = setTimeout(done, pause);
              onAnnounced = () => {
                clearTimeout(timer);
                done();
              };
            }),
            failed,
          ]);
          onAnnounced = null;
          touch();
        }
        if (option && Date.now() - started > 1_000) emitSetup({ type: "status", text: `思考强度的选项过了 ${Math.round((Date.now() - started) / 1000)} 秒才出现` });
      }
      if (!option && key === "model" && session.models?.availableModels?.length) {
        const ids = session.models.availableModels.map((m) => m.modelId);
        const chosen = resolveModelChoice(value, ids, new Map(session.models.availableModels.flatMap(m => m.name ? [[m.name, m.modelId] as const] : [])));
        if (!chosen.matched) {
          cutDown("model", value, ids);
          if (opts.strictSelection?.model) throw new Error(`指定模型 ${value} 不可用，可选：${ids.join(", ")}`);
          emitSetup({ type: "status", text: `该 Agent 没有 ${value}，可选：${ids.join(", ")}；用它的默认模型` });
          continue;
        }
        if (session.models.currentModelId !== chosen.value) await Promise.race([connection.extMethod("session/set_model", { sessionId, modelId: chosen.value }), failed]);
        if (chosen.value !== value) emitSetup({ type: "status", text: `模型名按 ${value} 匹配为 ${chosen.value}` });
        continue;
      }
      if (!option && key === "effort" && levelNow === value && (!profile.model || onNow?.[1] === ((options.find(isModelOption) as { currentValue?: string } | undefined)?.currentValue ?? onNow?.[1]))) {
        // Started on this level (the launch-time config): nothing to choose, though the agent lists no levels now.
        emitSetup({ type: "status", text: `思考强度 ${value} 已在启动时指定（后端这次没有列出思考强度）` });
        continue;
      }
      if (!option) {
        cutDown(key, value, []);
        if (opts.strictSelection?.[key]) throw new Error(`该 Agent 不支持设置 ${key}，无法使用指定值 ${value}`);
        emitSetup({ type: "status", text: `该 Agent 不支持设置 ${key}，使用其默认值` });
        continue;
      }
      const values = optionValues(option);
      const chosen = key === "model" ? resolveModelChoice(value, values, optionNames(option)) : { value, matched: values.includes(value) };
      if (!chosen.matched) {
        cutDown(key, value, values);
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
    opts.signal?.removeEventListener("abort", onSetupAbort);
    let busy = false;
    /** Whether the agent takes words mid-turn (`_session/steering`); null until tried. */
    let steerable: boolean | null = null;
    return {
      sessionId,
      agent: agentName,
      resumed,
      system: "systemPrompt" in system,
      alive: () => !dead,
      close,
      stopped,
      discard: discard!,
      async steer(steerText) {
        if (dead || !busy) return "idle";
        if (steerable === false) return "unsupported";
        try {
          const r = await connection.extMethod("_session/steering", { sessionId, prompt: [{ type: "text", text: steerText }], _meta: { steering: { idleBehavior: "promptRequired" } } }) as { outcome?: string };
          steerable = true;
          return r?.outcome === "injected" ? "injected" : r?.outcome === "promptRequired" ? "idle" : "failed";
        } catch (e) {
          // Agents without it answer "Method not found": stop asking for this session.
          if (/method not found|-32601/i.test(`${(e as { message?: string }).message ?? ""} ${(e as { code?: number }).code ?? ""}`)) steerable = false;
          return steerable === false ? "unsupported" : "failed";
        }
      },
      async prompt(promptText, turnEmit, signal) {
        if (signal?.aborted) { if (signal.reason instanceof NetworkUnavailableError) close(); throw new Error("CANCELLED"); }
        if (dead) throw new Error("Agent 进程已结束");
        if (busy) throw new Error("这个 Agent 会话正在处理上一条消息");
        busy = true;
        opts.cleanup?.active?.(sessionId, true);
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
          if (signal?.reason instanceof NetworkUnavailableError) close();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const endCommandTurn = guardedToken ? (await import("./tools.ts")).beginCommandTurn(guardedToken) : undefined;
        try {
          const result = await Promise.race([connection.prompt({ sessionId, prompt: [{ type: "text", text: promptText }] }), failed]).catch((e) => { throw promptError(e); });
          if (signal?.aborted) throw new Error("CANCELLED");
          const last = segments.at(-1)!.trim();
          if (STREAM_QUOTA_NOTICE.test(last)) throw agentRunError(last, "quota");
          const codexError = codexErrorReply(last);
          if (codexError) throw codexError;
          return { text, reply: replyFromSegments(segments), stopReason: result.stopReason, sessionId, agent: agentName, contextUsage };
        } finally {
          endCommandTurn?.();
          idleW.close();
          (queueW as ReturnType<typeof idleWatchdog> | null)?.close();
          promptQueue = null;
          signal?.removeEventListener("abort", onAbort);
          touch = () => {};
          emit = () => {};
          try { if (!(signal?.reason instanceof NetworkUnavailableError)) await opts.cleanup?.children?.(sessionId); }
          catch (e) { emitSetup({ type: "status", text: `后端子会话清理失败，稍后重试：${(e as Error).message.slice(0, 160)}` }); }
          finally { opts.cleanup?.active?.(sessionId, false); busy = false; }
        }
      },
    };
  } catch (error) {
    opts.signal?.removeEventListener("abort", onSetupAbort);
    setupWatch.close();
    if (!(opts.signal?.reason instanceof NetworkUnavailableError) && !keepSession) await discard?.();
    close();
    await stopped;
    // The agent quit while starting: what it printed says why better than the closed connection.
    const why = dead && error instanceof Error && /connection closed/i.test(error.message) && stderr.trim() ? exitError(child.exitCode) : error;
    throw sandboxStartError(accountOf(profile), stderr) ?? explain(why, profile);
  }
}

/**
 * A failed turn: JSON-RPC errors say why in `data` (Codex answers "Internal error" with
 * codexErrorInfo "usageLimitExceeded" and "try again at …" when the plan's quota is spent).
 */
function promptError(error: unknown) {
  if (!(error instanceof Error) || !("code" in error)) return error;
  const data = (error as Error & { data?: unknown }).data;
  const detail = data === undefined || data === null ? "" : typeof data === "string" ? data : JSON.stringify(data).slice(0, 600);
  const text = detail ? `${error.message}：${detail}` : error.message;
  return isQuotaMessage(text) ? agentRunError(text, "quota") : detail ? new Error(text) : error;
}

/** JSON-RPC errors carry the useful part ("GOOSE_PROVIDER not set", "please log in") in `data`. */
function explain(error: unknown, profile: AgentProfile) {
  if (!(error instanceof Error) || !("code" in error)) return error;
  const e = error as Error & { data?: unknown };
  const detail = e.data === undefined || e.data === null ? "" : typeof e.data === "string" ? e.data : JSON.stringify(e.data).slice(0, 400);
  const text = `${e.message}${detail ? "：" + detail : ""}`;
  const cli = profile.command === "npx" || profile.command === "uvx" ? `${profile.command} ${profile.args.filter((a) => !a.startsWith("-") || a === "-y").slice(0, 2).join(" ")}` : profile.command;
  const needsLogin = /auth|login|log in|api.?key|credential|provider|configur/i.test(text);
  const hint = !needsLogin ? "" : accountOf(profile) ? "（这次用的是你自己的账号：在 账号 → 我的 AI 账号 里重新登录后再试）" : `（先在终端直接运行 ${cli} 完成登录或配置，再回来使用）`;
  return new Error(text + hint);
}

/** A short connection of its own: start the agent, initialize, run `work`, stop it. */
async function withAcpConnection<T>(profile: AgentProfile, cwd: string, env: Record<string, string> | undefined, signal: AbortSignal | undefined, work: (connection: ClientSideConnection, caps: { sessionCapabilities?: { delete?: unknown; list?: unknown } } | undefined) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error("CANCELLED");
  requirePluginBackend(profile);
  const child = launch(profile.command, profile.args, { cwd, env: { ...profile.env, ...keyEnv(profile), ...env }, sandbox: accountOf(profile) });
  const onAbort = () => stop(child);
  signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
  const output = new WritableStream<Uint8Array>({ write: (chunk) => new Promise((resolve, reject) => child.stdin.write(chunk, (e) => (e ? reject(e) : resolve()))) });
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const connection = new ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async () => {},
    }),
    ndJsonStream(output, input),
  );
  let timer: NodeJS.Timeout | undefined;
  const exited = new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`Agent 进程退出（${code}）${stderr.trim() ? `：${stderr.trim().slice(-300)}` : ""}`))));
  exited.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        const init = await connection.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "omem", version: "0.0.1" } });
        return work(connection, init.agentCapabilities as { sessionCapabilities?: { delete?: unknown; list?: unknown } } | undefined);
      })(),
      exited,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("会话清理超时")), 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    stop(child);
  }
}

/** Delete a session through a connection of its own: start the agent, `session/delete`, stop it. */
export async function deleteAcpSession(profile: AgentProfile, sessionId: string, cwd: string, env?: Record<string, string>, signal?: AbortSignal) {
  await withAcpConnection(profile, cwd, env, signal, async (connection, caps) => {
    if (!caps?.sessionCapabilities?.delete) throw Object.assign(new Error("该后端不支持自动清理会话：未声明 session/delete"), { unsupportedCleanup: true });
    await connection.deleteSession({ sessionId }).catch(e => { throw promptError(e); });
  });
}

/** Look one session up in the agent's `session/list` (in `cwd`, then anywhere); null when it is not listed. */
export async function findAcpSession(profile: AgentProfile, sessionId: string, cwd: string, signal?: AbortSignal): Promise<{ sessionId: string; cwd?: string | null; title?: string | null; updatedAt?: string | null } | null> {
  return withAcpConnection(profile, cwd, undefined, signal, async (connection, caps) => {
    if (!caps?.sessionCapabilities?.list) throw new Error("该后端没有 session/list");
    for (const scope of [{ cwd }, {}]) {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await connection.listSessions({ ...scope, ...(cursor ? { cursor } : {}) });
        const hit = r.sessions.find(s => s.sessionId === sessionId);
        if (hit) return hit;
        cursor = r.nextCursor ?? undefined;
        if (!cursor) break;
      }
    }
    return null;
  });
}

/** Negotiate protocol deletion first; an archive command is only a fallback for unsupported agents. */
export async function cleanupAcpSession(profile: AgentProfile, sessionId: string, cwd: string, signal?: AbortSignal) {
  try { await deleteAcpSession(profile, sessionId, cwd, undefined, signal); }
  catch (e) {
    if (!(e as { unsupportedCleanup?: boolean }).unsupportedCleanup || !profile.archiveArgs?.length) throw e;
    if (signal?.aborted) throw new Error("CANCELLED");
    await archiveSession(profile, sessionId, cwd, undefined, signal);
  }
}

/** One prompt turn against an ACP agent (Codex/TraeX/Claude Code adapters…). */
export async function runAcp(profile: AgentProfile, req: AgentRequest & { app?: App }, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const handle = await openAcp(profile, { app: req.app, runId: req.runId, signal: req.signal, cwd: req.cwd, workspace: req.workspace, ownSandbox: req.ownSandbox, cleanup: req.cleanup, mcp: req.mcp, extraMcp: req.extraMcp, allowWrites: req.allowWrites, modes: req.modes, fullAccess: req.fullAccess, acpWritable: req.acpWritable, env: req.env, resumeSessionId: req.resumeSessionId, system: req.system, probe: req.probe, strictSelection: req.strictSelection, queueTimeoutMs: req.queueTimeoutMs }, emit);
  try {
    if (req.probe) return { text: "", stopReason: "probe", agent: handle.agent, probe: handle.probe };
    if (req.signal?.aborted) throw new Error("CANCELLED");
    const prompt = handle.resumed ? req.prompt : req.freshPrompt ?? req.prompt;
    return await handle.prompt(sessionPrompt(handle, req, prompt, emit), emit, req.signal);
  } finally {
    if (req.signal?.reason instanceof NetworkUnavailableError) { handle.close(); await handle.stopped; }
    else if (!req.persistSession && !handle.resumed) await handle.discard();
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
  // No sandbox and no approvals; only when the owner turned on 完全访问 for the run.
  "full-access": ["agent-full-access", "full-access", "bypassPermissions", "bypass_permissions", "danger-full-access", "yolo"],
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

/** The end of what a finished tool call printed (its text content, else its raw output), at most OUTPUT_KEEP characters. */
const OUTPUT_KEEP = 3000;
export function toolOutput(content: unknown, raw: unknown): string {
  const parts: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    const inner = (c as { content?: { type?: string; text?: string } })?.content;
    if (inner?.type === "text" && inner.text) parts.push(inner.text);
  }
  let text = parts.join("\n");
  if (!text && raw != null) {
    const r = raw as { stdout?: unknown; output?: unknown; formatted_output?: unknown };
    text = typeof raw === "string" ? raw : String(r.formatted_output ?? r.output ?? r.stdout ?? "") || JSON.stringify(raw);
  }
  text = text.trim();
  return text.length > OUTPUT_KEEP ? `…${text.slice(-OUTPUT_KEEP)}` : text;
}
