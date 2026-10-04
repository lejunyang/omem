/** Client-side ACP transport is reused from the official SDK. Agent output is data;
 * thought chunks are discarded. Permission callbacks never silently authorize tools. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  type SessionConfigOption,
  type ContentBlock,
  type McpServer,
  type SessionUpdate,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../../../packages/contracts/src/index.js";
export type Emit = (
  type: "status" | "text" | "permission",
  text: string,
) => void;
export type RuntimeRequestEvent = {
  kind: "permission" | "elicitation";
  sessionId: string;
  turnId: string | null;
  providerRequestId: string;
  options: unknown;
};
export type AcpOptions = {
  mcpServers?: McpServer[];
  expectedSkills?: string[];
  skillDiscoveryTimeoutMs?: number;
  maxOutputChars?: number;
  unbounded?: boolean;
  /** Resolved by the host only after a final tool result is validated and saved. */
  finalSubmission?: Promise<void>;
  onSessionUpdate?: (update: SessionUpdate) => void;
  allowPermission?: (request: RequestPermissionRequest) => boolean;
  contextBudget?: { estimatedInputTokens: number; maxOutputTokens: number; contextReserveTokens: number };
  onRuntimeRequest?: (request: RuntimeRequestEvent) => void | Promise<void>;
};

/** Run a supplied role in its material workspace without inheriting repository
 * development instructions. This controls prompt discovery, not OS file access. */
export function withAgentWorkspace(profile: AgentProfile, workspace: string): AgentProfile {
  if (profile.transport !== "acp" || !/(?:^|[/\\])(?:traex|traecli)(?:\.exe)?$/.test(profile.command)) return profile;
  return { ...profile, args: ["-C", workspace, "-c", "project_doc_max_bytes=0", ...profile.args] };
}

const env = (cwd: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("BOTMUX_") &&
        !["OMEM_TOKEN", "CLAUDECODE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
          "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key),
    ),
  ),
  // Exported originals are a captured workspace, not the enclosing development
  // checkout. Git's implicit parent discovery must not cross that boundary.
  // This avoids accidental context leakage; it is not a filesystem sandbox.
  // Git ignores a ceiling equal to its starting directory. Include the parent
  // as well so a command from either the workspace root or a child stops here.
  GIT_CEILING_DIRECTORIES: [realpathSync(cwd), dirname(realpathSync(cwd)), process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(delimiter),
});
function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
  }, 1500);
  timer.unref();
}
function launch(profile: AgentProfile, args: string[], cwd: string) {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const child = spawn(profile.command, args, {
    cwd,
    env: env(cwd),
    stdio: "pipe",
    shell: false,
    detached: process.platform !== "win32",
  });
  // A process exiting before a write can emit EPIPE independently of the write
  // callback. The lifecycle promise reports failure; never crash the API process.
  child.stdin.on("error", () => {});
  return child;
}
export function optionValues(option: SessionConfigOption) {
  if (option.type !== "select") return [];
  return option.options.flatMap((o) => ("options" in o ? o.options : [o]));
}
export function assertContextBudget(configOptions: SessionConfigOption[], budget: NonNullable<AcpOptions["contextBudget"]>): number | null {
  const option = configOptions.find(o => o.category === "model" || o.id === "model");
  if (!option) return null;
  const selected = optionValues(option).find(o => o.value === option.currentValue);
  const metadata = selected?._meta as { trae?: { contextWindow?: number } } | undefined;
  const contextWindow = metadata?.trae?.contextWindow;
  if (!contextWindow || !Number.isFinite(contextWindow)) return null;
  const required = budget.estimatedInputTokens + budget.maxOutputTokens + budget.contextReserveTokens;
  if (required > contextWindow) throw new Error(`Model context budget exceeded: estimated input + output + reserve ${required} > discovered context window ${contextWindow}`);
  return contextWindow;
}
export async function acp(
  profile: AgentProfile,
  cwd: string,
  blocks: ContentBlock[] | null,
  emit: Emit,
  signal: AbortSignal,
  options: AcpOptions = {},
) {
  const startedAt = performance.now();
  let initializedAt = startedAt;
  let promptStartedAt: number | undefined;
  let promptFinishedAt: number | undefined;
  let firstToolAt: number | undefined;
  const toolCalls = new Map<string, string>();
  const child = launch(profile, profile.args, cwd);
  // Track the 'close' event from spawn time so we never miss it after stop().
  // On Windows, 'close' fires only after the process exits AND its stdio
  // streams are destroyed — that is when the OS releases the cwd handle.
  // Awaiting it in finally prevents the caller's rmSync from racing teardown.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let failure = "";
  let terminalFailure: Error | undefined;
  child.stderr.on("data", (data) => {
    failure = (failure + data.toString()).slice(-4000);
  });
  let rejectExit: (e: Error) => void = () => {};
  const exited = new Promise<never>((_, reject) => {
    rejectExit = reject;
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(
        new Error(
          `ACP process exited (${code}); check agent login and profile. ${failure.includes("auth") ? "Authentication required." : ""}`,
        ),
      ),
    );
  });
  // Attaching immediately prevents an unhandled rejection on a spawn failure.
  void exited.catch(() => {});
  const timeout = setTimeout(() => {
    terminalFailure = new Error("Agent timed out");
    rejectExit(terminalFailure);
    stop(child);
  }, profile.timeoutMs);
  let connection: ClientSideConnection | undefined;
  let sessionId: string | undefined;
  let availableCommands: string[] = [];
  let usage: Record<string, unknown> = {};
  let outputChars = 0;
  let completion: "probe" | "end_turn" | "validated_submission" = "probe";
  let resolveDiscovery = () => {};
  const discovery = new Promise<void>((resolve) => {
    resolveDiscovery = resolve;
  });
  const cancel = () => {
    void connection?.cancel({ sessionId: sessionId || "" }).catch(() => {});
    terminalFailure = new Error("CANCELLED");
    rejectExit(terminalFailure);
    stop(child);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw Error("CANCELLED");
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) =>
          child.stdin.write(chunk, (e) => (e ? reject(e) : resolve())),
        );
      },
    });
    let inputClosed = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        let total = 0;
        child.stdout.on("data", (chunk: Buffer) => {
          if (inputClosed) return;
          total += chunk.length;
          if (!options.unbounded && total > 32_000_000) {
            rejectExit(new Error("ACP wire output budget exceeded"));
            stop(child);
            return;
          }
          controller.enqueue(new Uint8Array(chunk));
        });
        child.stdout.once("end", () => {
          if (inputClosed) return;
          inputClosed = true;
          controller.close();
        });
        child.stdout.once("error", (error) => {
          if (inputClosed) return;
          inputClosed = true;
          controller.error(error);
        });
      },
      cancel() {
        inputClosed = true;
      },
    });
    const stream = ndJsonStream(output, input);
    connection = new ClientSideConnection(
      () => ({
        requestPermission: async (request) => {
          const once = request.options.find(o => o.kind === "allow_once");
          if (once && options.allowPermission?.(request)) return { outcome: { outcome: "selected", optionId: once.optionId } };
          await options.onRuntimeRequest?.({
            kind: "permission",
            sessionId: sessionId || request.sessionId,
            turnId: request.toolCall.toolCallId,
            providerRequestId: request.toolCall.toolCallId,
            options: request.options,
          });
          emit(
            "permission",
            `Agent 请求额外操作权限：${request.toolCall.title || "未命名操作"}。当前只读问答不会自动执行。`,
          );
          return { outcome: { outcome: "cancelled" } };
        },
        createElicitation: async (request) => {
          const scope = request as unknown as {
            sessionId?: unknown;
            requestId?: unknown;
            toolCallId?: unknown;
          };
          const providerRequestId = String(
            scope.toolCallId ?? scope.requestId ?? "elicitation",
          );
          await options.onRuntimeRequest?.({
            kind: "elicitation",
            sessionId: String(scope.sessionId ?? sessionId ?? ""),
            turnId: scope.toolCallId ? String(scope.toolCallId) : null,
            providerRequestId,
            options: request,
          });
          emit(
            "permission",
            "Agent 请求补充输入；当前后台任务不会等待并已拒绝。",
          );
          return { action: "decline" };
        },
        sessionUpdate: async ({ update }) => {
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            firstToolAt ??= performance.now();
            toolCalls.set(update.toolCallId, update.status ?? toolCalls.get(update.toolCallId) ?? "pending");
          }
          if (["tool_call", "tool_call_update", "plan", "usage_update"].includes(update.sessionUpdate)) options.onSessionUpdate?.(update);
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            outputChars += update.content.text.length;
            if (!options.unbounded && outputChars > (options.maxOutputChars ?? 250_000)) {
              terminalFailure = new Error("Agent output limit exceeded");
              rejectExit(terminalFailure);
              stop(child);
              return;
            }
            emit("text", update.content.text);
          } else if (update.sessionUpdate === "tool_call")
            emit("status", `工具状态：${update.title}`);
          else if (update.sessionUpdate === "available_commands_update") {
            availableCommands = update.availableCommands.map(
              (command) => command.name,
            );
            const normalized = new Set(
              availableCommands.map((name) =>
                name.replace(/^\//, "").replace(/^skill:/, ""),
              ),
            );
            if (
              (options.expectedSkills ?? []).every((name) =>
                normalized.has(name),
              )
            )
              resolveDiscovery();
          } else if (update.sessionUpdate === "usage_update")
            usage = {
              used: update.used,
              size: update.size,
              cost: update.cost ?? null,
            };
        },
      }),
      stream,
    );
    const initialized = await Promise.race([
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { terminal_output: true, traex_subagent_parent_tool_call_id: true },
        },
        clientInfo: { name: "omem", version: "0.1.0" },
      }),
      exited,
    ]);
    if (initialized.protocolVersion !== 1)
      throw Error("Unsupported ACP protocol version");
    initializedAt = performance.now();
    const session = await Promise.race([
      connection.newSession({
        cwd,
        mcpServers: options.mcpServers ?? [],
        _meta: {
          trae: { options: { skills: profile.skills, mcpServers: [] } },
        },
      }),
      exited,
    ]);
    sessionId = session.sessionId;
    if (options.expectedSkills?.length) {
      const normalized = new Set(
        availableCommands.map((name) =>
          name.replace(/^\//, "").replace(/^skill:/, ""),
        ),
      );
      if (!options.expectedSkills.every((name) => normalized.has(name)))
        await Promise.race([
          discovery,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(Error("NATIVE_SKILL_DISCOVERY_FAILED")),
              options.skillDiscoveryTimeoutMs ?? 1000,
            ),
          ),
          exited,
        ]);
    }
    let configOptions = session.configOptions || [];
    for (const [key, value] of [
      ["model", profile.model],
      ["reasoning_effort", profile.effort],
    ] as const) {
      if (!value) continue;
      const option = configOptions.find(
        (o) =>
          o.id === key ||
          (key === "model"
            ? o.category === "model"
            : o.category === "thought_level"),
      );
      if (!option || !optionValues(option).some((o) => o.value === value))
        throw Error(`Unsupported ${key}: ${value}`);
      const reply = await Promise.race([
        connection.setSessionConfigOption({
          sessionId,
          configId: option.id,
          value,
        }),
        exited,
      ]);
      configOptions = reply.configOptions;
    }
    const configuredAt = performance.now();
    if (blocks) {
      if (options.contextBudget) assertContextBudget(configOptions, options.contextBudget);
      if (
        blocks.some((b) => b.type === "image") &&
        !initialized.agentCapabilities?.promptCapabilities?.image
      )
        throw Error("This agent does not support images");
      emit("status", "Agent 已连接，正在基于固定证据回答");
      promptStartedAt = performance.now();
      const result = await Promise.race([
        connection.prompt({ sessionId, prompt: blocks }).then(result => ({ kind: "prompt" as const, result })),
        exited,
        ...(options.finalSubmission
          ? [options.finalSubmission.then(() => ({ kind: "submission" as const }))]
          : []),
      ]);
      if (signal.aborted) throw Error("CANCELLED");
      if (terminalFailure) throw terminalFailure;
      if (result.kind === "prompt" && result.result.stopReason !== "end_turn")
        throw Error(`Agent stopped: ${result.result.stopReason}`);
      completion = result.kind === "submission" ? "validated_submission" : "end_turn";
      promptFinishedAt = performance.now();
      // The agent's prompt has completed. Clear the global timeout now so
      // session teardown (closeSession) doesn't race it under parallel load —
      // otherwise a slow prompt leaves no budget for the 1s closeSession race,
      // turning a clean success into a spurious "Agent timed out".
      clearTimeout(timeout);
      // A native role is complete when its final tool submission is accepted.
      // Some CLIs never finish session/prompt after this; cancel that remaining
      // turn without treating it as a user cancellation or losing the result.
      if (completion === "validated_submission")
        void connection.cancel({ sessionId }).catch(() => {});
    }
    if (initialized.agentCapabilities?.sessionCapabilities?.close)
      await Promise.race([
        connection.closeSession({ sessionId }).catch(error => {
          if (completion !== "validated_submission") throw error;
        }),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    if (signal.aborted) throw Error("CANCELLED");
    if (terminalFailure) throw terminalFailure;
    return {
      agentInfo: initialized.agentInfo,
      capabilities: initialized.agentCapabilities,
      configOptions,
      sessionId,
      availableCommands,
      usage,
      completion,
      timings: {
        initializeMs: Math.round(initializedAt - startedAt),
        sessionSetupMs: Math.round(configuredAt - initializedAt),
        promptMs: promptStartedAt === undefined ? 0 : Math.round((promptFinishedAt ?? performance.now()) - promptStartedAt),
        firstToolMs: promptStartedAt === undefined || firstToolAt === undefined ? null : Math.round(Math.max(0, firstToolAt - promptStartedAt)),
        toolCalls: toolCalls.size,
        failedToolCalls: [...toolCalls.values()].filter(status => status === "failed").length,
      },
    };
  } catch (error) {
    if (terminalFailure) throw terminalFailure;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    stop(child);
    // Wait for the child to fully exit and release its cwd handle before
    // returning. stop() sends SIGTERM then escalates to SIGKILL after 1.5s,
    // so 5s is ample. The timeout resolves (never rejects): if it fires the
    // SIGKILL has already run, and the caller's rmSync surfaces any residual
    // lock as a real EPERM rather than being retried.
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}
export function cliArgs(profile: AgentProfile) {
  const { model, effort } = profile;
  if (profile.transport === "claude-cli")
    return [
      ...profile.args,
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
    ];
  return [
    ...profile.args,
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    ...(model ? ["--model", model] : []),
    ...(effort
      ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`]
      : []),
    "-",
  ];
}
export async function cli(
  profile: AgentProfile,
  cwd: string,
  text: string,
  emit: Emit,
  signal: AbortSignal,
) {
  const child = launch(profile, cliArgs(profile), cwd);
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let bytes = 0;
  let emitted = false;
  let malformed = false;
  let providerError = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop(child);
      reject(Error("Agent timed out"));
    }, profile.timeoutMs);
    const cancel = () => {
      stop(child);
      reject(Error("CANCELLED"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
    const line = (raw: string) => {
      if (!raw.trim()) return;
      try {
        const item = JSON.parse(raw);
        if (
          item.type === "item.completed" &&
          item.item?.type === "agent_message"
        ) {
          emit("text", item.item.text);
          emitted = true;
        } else if (item.type === "assistant") {
          for (const p of item.message?.content || [])
            if (p.type === "text") {
              emit("text", p.text);
              emitted = true;
            }
        } else if (item.type === "result") {
          if (item.is_error) providerError = true;
          else if (!emitted && typeof item.result === "string") {
            emit("text", item.result);
            emitted = true;
          }
        } else if (item.type === "error" || item.type === "turn.failed")
          providerError = true;
      } catch {
        malformed = true;
      }
    };
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        stop(child);
        reject(Error("Agent output limit exceeded"));
        return;
      }
      buffer += chunk.toString();
      let n;
      while ((n = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, n));
        buffer = buffer.slice(n + 1);
      }
    });
    child.stderr.resume();
    child.once("error", (e) => {
      clean();
      reject(e);
    });
    child.once("exit", (code) => {
      line(buffer);
      clean();
      if (signal.aborted) return reject(Error("CANCELLED"));
      if (code !== 0 || malformed || providerError || !emitted)
        return reject(
          Error(
            `Agent CLI failed (${code}); check login, model and output protocol`,
          ),
        );
      resolve();
    });
    if (signal.aborted) cancel();
    else child.stdin.end(text);
  }).finally(() => stop(child));
}
