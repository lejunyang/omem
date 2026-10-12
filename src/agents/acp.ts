import { ClientSideConnection, ndJsonStream, type McpServer, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../core/config.ts";
import { idleWatchdog, launch, stop } from "./spawn.ts";
import type { AgentEvent, AgentRequest, AgentResult } from "./types.ts";

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

/**
 * Run one prompt turn against an ACP agent (Codex/TraeX/Claude Code adapters…).
 * The agent keeps its own tools; omem adds its MCP server for knowledge access.
 */
export async function runAcp(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const child = launch(profile.command, profile.args, { cwd: req.cwd, env: { ...profile.env, ...req.env } });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  let fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => {});
  child.once("error", (e) => fail(e));
  child.once("exit", (code) => fail(new Error(`Agent 进程退出（${code}）${/auth|login|登录|unauthori/i.test(stderr) ? "：需要登录对应 Agent CLI" : ""}\n${stderr.slice(-800)}`)));
  const watchdog = idleWatchdog(profile.idleTimeoutMs, () => {
    fail(new Error(`Agent 超过 ${Math.round(profile.idleTimeoutMs / 1000)} 秒没有任何活动，已停止`));
    stop(child);
  });
  let sessionId = "";
  let connection: ClientSideConnection | undefined;
  const onAbort = () => {
    if (connection && sessionId) void connection.cancel({ sessionId }).catch(() => {});
    fail(new Error("CANCELLED"));
    setTimeout(() => stop(child), 500).unref();
  };
  req.signal?.addEventListener("abort", onAbort, { once: true });

  let text = "";
  const tools = new Map<string, { title: string; kind?: string; status?: string }>();
  try {
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
    connection = new ClientSideConnection(
      () => ({
        async requestPermission(request) {
          watchdog.touch();
          const kind = request.toolCall.kind ?? "other";
          const allowed = req.allowWrites || !["edit", "delete", "move"].includes(kind);
          const option = request.options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once")) ?? request.options.find((o) => o.kind.startsWith(allowed ? "allow" : "reject"));
          emit({ type: "status", text: `${allowed ? "允许" : "拒绝"}操作：${request.toolCall.title ?? kind}` });
          return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
        },
        async sessionUpdate({ update }) {
          watchdog.touch();
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
    const init = await Promise.race([
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "omem", version: "0.2.0" },
      }),
      failed,
    ]);
    watchdog.touch();
    const httpMcp = !!init.agentCapabilities?.mcpCapabilities?.http;
    const mcpServers: McpServer[] = req.mcp
      ? httpMcp
        ? [{ type: "http", name: "omem", url: req.mcp.url, headers: [{ name: "authorization", value: `Bearer ${req.mcp.token}` }] }]
        : [
            {
              name: "omem",
              command: req.mcp.stdio.command,
              args: req.mcp.stdio.args,
              env: Object.entries({ OMEM_URL: req.mcp.baseUrl, OMEM_TOKEN: req.mcp.token }).map(([name, value]) => ({ name, value })),
            },
          ]
      : [];
    const session = await Promise.race([connection.newSession({ cwd: req.cwd, mcpServers }), failed]);
    sessionId = session.sessionId;
    watchdog.touch();

    // Permission mode: prefer the role's choice when the agent offers it.
    const modes = session.modes?.availableModes ?? [];
    const wanted = (req.modes ?? []).find((m) => modes.some((x) => x.id === m));
    if (wanted && session.modes?.currentModeId !== wanted) await Promise.race([connection.setSessionMode({ sessionId, modeId: wanted }), failed]);

    let options = session.configOptions ?? [];
    if (req.probe)
      return {
        text: "",
        stopReason: "probe",
        agent: init.agentInfo?.name ?? profile.command,
        probe: {
          agent: `${init.agentInfo?.name ?? profile.command} ${init.agentInfo?.version ?? ""}`.trim(),
          modes: (session.modes?.availableModes ?? []).map((m) => m.id),
          options: options.map((o) => ({ id: o.id, category: (o as { category?: string }).category ?? null, current: (o as { currentValue?: string }).currentValue ?? null, values: optionValues(o) })),
        },
      };
    for (const [key, value] of [
      ["model", profile.model],
      ["effort", profile.effort],
    ] as const) {
      if (!value) continue;
      const option = options.find((o) => (key === "model" ? o.category === "model" || o.id === "model" : o.category === "thought_level" || /effort|reasoning/.test(o.id)));
      if (!option) {
        emit({ type: "status", text: `该 Agent 不支持设置 ${key}，使用其默认值` });
        continue;
      }
      const values = optionValues(option);
      if (!values.includes(value)) throw new Error(`Agent 不支持 ${key}=${value}。可选：${values.join(", ")}`);
      if (option.currentValue === value) continue;
      const reply = await Promise.race([connection.setSessionConfigOption({ sessionId, configId: option.id, value }), failed]);
      options = reply.configOptions ?? options;
    }
    emit({ type: "status", text: `已连接 ${init.agentInfo?.name ?? profile.command}${profile.model ? ` · ${profile.model}` : ""}` });
    const result = await Promise.race([connection.prompt({ sessionId, prompt: [{ type: "text", text: req.prompt }] }), failed]);
    if (req.signal?.aborted) throw new Error("CANCELLED");
    return { text, stopReason: result.stopReason, sessionId, agent: init.agentInfo?.name ?? profile.command };
  } finally {
    watchdog.close();
    req.signal?.removeEventListener("abort", onAbort);
    stop(child);
  }
}
