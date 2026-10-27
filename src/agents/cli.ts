import type { AgentProfile } from "../core/config.ts";
import { idleWatchdog, launch, stop } from "./spawn.ts";
import { replyFromSegments, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";

const READ_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "mcp__omem"];

export function claudeArgs(profile: AgentProfile, req: AgentRequest) {
  const args = [...profile.args, "-p", "--output-format", "stream-json", "--verbose"];
  if (!req.persistSession && !req.resumeSessionId) args.push("--no-session-persistence");
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  if (profile.model) args.push("--model", profile.model);
  if (profile.effort) args.push("--effort", profile.effort);
  const servers: Record<string, unknown> = {};
  if (req.mcp) servers.omem = { command: req.mcp.stdio.command, args: req.mcp.stdio.args, env: { OMEM_URL: req.mcp.baseUrl, OMEM_TOKEN: req.mcp.token } };
  for (const [name, srv] of Object.entries(req.extraMcp ?? {})) servers[name] = "url" in srv ? { type: "http", url: srv.url, headers: srv.headers } : srv;
  if (Object.keys(servers).length) args.push("--mcp-config", JSON.stringify({ mcpServers: servers }));
  if (req.allowWrites) args.push("--permission-mode", "acceptEdits", "--allowedTools", [...READ_TOOLS, "Edit", "Write", "MultiEdit", "Bash"].join(","));
  else args.push("--allowedTools", READ_TOOLS.join(","), "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit");
  return args;
}

function tomlString(s: string) {
  return JSON.stringify(s);
}

export function codexArgs(profile: AgentProfile, req: AgentRequest) {
  const args = [...profile.args, "exec", "--json", "--skip-git-repo-check", "--sandbox", req.allowWrites ? "workspace-write" : "read-only"];
  if (!req.persistSession && !req.resumeSessionId) args.push("--ephemeral");
  if (profile.model) args.push("-m", profile.model);
  if (profile.effort) args.push("-c", `model_reasoning_effort=${tomlString(profile.effort)}`);
  if (req.mcp) {
    args.push("-c", `mcp_servers.omem.command=${tomlString(req.mcp.stdio.command)}`);
    args.push("-c", `mcp_servers.omem.args=[${req.mcp.stdio.args.map(tomlString).join(",")}]`);
    args.push("-c", `mcp_servers.omem.env={OMEM_URL=${tomlString(req.mcp.baseUrl)},OMEM_TOKEN=${tomlString(req.mcp.token)}}`);
    // exec 下没法交互审批，MCP 工具默认要审批就会被直接拒绝；只放行 omem 这一个服务器。
    args.push("-c", `mcp_servers.omem.default_tools_approval_mode="approve"`);
  }
  for (const [name, srv] of Object.entries(req.extraMcp ?? {})) {
    if ("url" in srv) args.push("-c", `mcp_servers.${name}.url=${tomlString(srv.url)}`);
    else {
      args.push("-c", `mcp_servers.${name}.command=${tomlString(srv.command)}`);
      args.push("-c", `mcp_servers.${name}.args=[${srv.args.map(tomlString).join(",")}]`);
      if (Object.keys(srv.env).length) args.push("-c", `mcp_servers.${name}.env={${Object.entries(srv.env).map(([k, v]) => `${k}=${tomlString(v)}`).join(",")}}`);
    }
  }
  if (req.resumeSessionId) args.push("resume", req.resumeSessionId);
  args.push("-");
  return args;
}

/** One-shot CLI fallback for agents without ACP. Streams JSON events from stdout. */
export async function runCli(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const isClaude = profile.transport === "claude-cli";
  const args = isClaude ? claudeArgs(profile, req) : codexArgs(profile, req);
  const child = launch(profile.command, args, { cwd: req.cwd, env: { ...profile.env, ...req.mcp?.env, ...req.env } });
  child.stdin.end(req.prompt);
  let text = "";
  // Text between tool calls; the last segment is the reply proper (see replyFromSegments).
  const segments: string[] = [""];
  const cut = () => { if (segments[segments.length - 1].trim()) segments.push(""); };
  let stderr = "";
  let failure = "";
  let buffer = "";
  let sessionId: string | undefined;
  await new Promise<void>((resolve, reject) => {
    const watchdog = idleWatchdog(profile.idleTimeoutMs, () => {
      stop(child);
      reject(new Error("Agent 长时间没有活动，已停止"));
    });
    const onAbort = () => {
      stop(child);
      reject(new Error("CANCELLED"));
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const line = (raw: string) => {
      if (!raw.trim()) return;
      let item: any;
      try {
        item = JSON.parse(raw);
      } catch {
        return;
      }
      watchdog.touch();
      if (typeof item.session_id === "string") sessionId = item.session_id;
      if (item.type === "thread.started" && typeof item.thread_id === "string") sessionId = item.thread_id;
      if (isClaude) {
        if (item.type === "assistant")
          for (const part of item.message?.content ?? []) {
            if (part.type === "text") {
              text += part.text;
              segments[segments.length - 1] += part.text;
              emit({ type: "text", text: part.text });
            } else if (part.type === "tool_use") {
              cut();
              emit({ type: "tool", id: part.id, title: part.name, status: "in_progress", input: part.input });
            }
            else if (part.type === "thinking") emit({ type: "thought", text: part.thinking ?? "" });
          }
        else if (item.type === "result" && item.is_error) failure = String(item.result ?? "Agent 返回错误");
      } else {
        const it = item.item ?? item.msg;
        if (item.type === "item.completed" && it?.type === "agent_message") {
          text += (text ? "\n\n" : "") + it.text;
          segments[segments.length - 1] += (segments[segments.length - 1] ? "\n\n" : "") + it.text;
          emit({ type: "text", text: it.text });
        } else if (item.type === "item.started" && it?.type) {
          cut();
          emit({ type: "tool", id: it.id ?? String(Math.random()), title: it.command ?? it.type, status: "in_progress" });
        }
        else if (item.type === "error" || item.type === "turn.failed") failure = item.message ?? item.error?.message ?? "Agent 返回错误";
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
      watchdog.touch();
    });
    child.once("error", (e) => {
      watchdog.close();
      reject(e);
    });
    child.once("close", (code) => {
      watchdog.close();
      req.signal?.removeEventListener("abort", onAbort);
      line(buffer);
      if (failure) reject(new Error(failure));
      else if (code !== 0 && !text) reject(new Error(`Agent 退出码 ${code}\n${stderr.slice(-800)}`));
      else resolve();
    });
  });
  return { text, reply: replyFromSegments(segments), stopReason: "end_turn", agent: profile.command, sessionId };
}
