import { ClientSideConnection, ndJsonStream, type McpServer, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../core/config.ts";
import { idleWatchdog, launch, stop } from "./spawn.ts";
import type { AgentEvent, AgentProbe, AgentRequest, AgentResult } from "./types.ts";

function optionValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
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
  const tools = new Map<string, { title: string; kind?: string; status?: string }>();
  const output = new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((resolve, reject) => child.stdin.write(chunk, (e) => (e ? reject(e) : resolve()))),
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      child.stdout.once("end", () => {
        try {
          controller.close();
        } catch {}
      });
    },
  });
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
      async sessionUpdate({ update }) {
        touch();
        if (replaying) return; // history replayed by session/load is not new output
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            if (update.content.type === "text") {
              text += update.content.text;
              emit({ type: "text", text: update.content.text });
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") emit({ type: "thought", text: update.content.text });
            break;
          case "tool_call": {
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
    const caps = init.agentCapabilities as { mcpCapabilities?: { http?: boolean }; loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } | undefined;
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
    type SessionInfo = { sessionId?: string; modes?: { availableModes: { id: string }[]; currentModeId: string } | null; configOptions?: SessionConfigOption[] | null };
    let session: SessionInfo | null = null;
    let sessionId = "";
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
    const modes = session.modes?.availableModes ?? [];
    const wanted = (opts.modes ?? []).find((m) => modes.some((x) => x.id === m));
    if (wanted && session.modes?.currentModeId !== wanted) await Promise.race([connection.setSessionMode({ sessionId, modeId: wanted }), failed]);
    let options = session.configOptions ?? [];
    const agentName = init.agentInfo?.name ?? profile.command;
    if (opts.probe) {
      const probe = {
        agent: `${init.agentInfo?.name ?? profile.command} ${init.agentInfo?.version ?? ""}`.trim(),
        modes: modes.map((m) => m.id),
        options: options.map((o) => ({ id: o.id, category: (o as { category?: string }).category ?? null, current: (o as { currentValue?: string }).currentValue ?? null, values: optionValues(o) })),
      };
      close();
      return { sessionId, agent: agentName, resumed, alive: () => false, prompt: async () => ({ text: "", stopReason: "probe", agent: agentName }), close, probe };
    }
    for (const [key, value] of [
      ["model", profile.model],
      ["effort", profile.effort],
    ] as const) {
      if (!value) continue;
      const option = options.find((o) => (key === "model" ? o.category === "model" || o.id === "model" : o.category === "thought_level" || /effort|reasoning/.test(o.id)));
      if (!option) {
        emitSetup({ type: "status", text: `该 Agent 不支持设置 ${key}，使用其默认值` });
        continue;
      }
      const values = optionValues(option);
      if (!values.includes(value)) throw new Error(`Agent 不支持 ${key}=${value}。可选：${values.join(", ")}`);
      if ((option as { currentValue?: string }).currentValue === value) continue;
      const reply = await Promise.race([connection.setSessionConfigOption({ sessionId, configId: option.id, value }), failed]);
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
      async prompt(promptText, turnEmit, signal) {
        if (dead) throw new Error("Agent 进程已结束");
        if (busy) throw new Error("这个 Agent 会话正在处理上一条消息");
        busy = true;
        emit = turnEmit;
        text = "";
        // A fresh failure channel for this turn: an earlier exit error has already been consumed.
        failed = new Promise<never>((_, reject) => (fail = reject));
        failed.catch(() => {});
        const watchdog = idleWatchdog(profile.idleTimeoutMs, () => {
          fail(new Error(`Agent 超过 ${Math.round(profile.idleTimeoutMs / 1000)} 秒没有任何活动，已停止`));
          close();
        });
        touch = () => watchdog.touch();
        const onAbort = () => {
          void connection.cancel({ sessionId }).catch(() => {});
          fail(new Error("CANCELLED"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await Promise.race([connection.prompt({ sessionId, prompt: [{ type: "text", text: promptText }] }), failed]);
          if (signal?.aborted) throw new Error("CANCELLED");
          return { text, stopReason: result.stopReason, sessionId, agent: agentName };
        } finally {
          watchdog.close();
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
    throw error;
  }
}

/** One prompt turn against an ACP agent (Codex/TraeX/Claude Code adapters…). */
export async function runAcp(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const onAbort = () => {};
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const handle = await openAcp(profile, { cwd: req.cwd, mcp: req.mcp, extraMcp: req.extraMcp, allowWrites: req.allowWrites, modes: req.modes, env: req.env, probe: req.probe }, emit);
  try {
    if (req.probe) return { text: "", stopReason: "probe", agent: handle.agent, probe: handle.probe };
    if (req.signal?.aborted) throw new Error("CANCELLED");
    return await handle.prompt(req.prompt, emit, req.signal);
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
    handle.close();
  }
}
