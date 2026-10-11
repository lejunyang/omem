import type { AgentProfile } from "../core/config.ts";
import { idleWatchdog, launch, stop } from "./spawn.ts";
import type { AgentEvent, AgentRequest, AgentResult } from "./types.ts";

const READ_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "mcp__omem"];

function claudeArgs(profile: AgentProfile, req: AgentRequest) {
  const args = [...profile.args, "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  if (profile.model) args.push("--model", profile.model);
  if (profile.effort) args.push("--effort", profile.effort);
  if (req.mcp)
    args.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: { omem: { command: req.mcp.stdio.command, args: req.mcp.stdio.args, env: { OMEM_URL: req.mcp.baseUrl, OMEM_TOKEN: req.mcp.token } } } }),
    );
  if (req.allowWrites) args.push("--permission-mode", "acceptEdits", "--allowedTools", [...READ_TOOLS, "Edit", "Write", "MultiEdit", "Bash"].join(","));
  else args.push("--allowedTools", READ_TOOLS.join(","), "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit");
  return args;
}

function tomlString(s: string) {
  return JSON.stringify(s);
}

function codexArgs(profile: AgentProfile, req: AgentRequest) {
  const args = [...profile.args, "exec", "--json", "--skip-git-repo-check", "--sandbox", req.allowWrites ? "workspace-write" : "read-only"];
  if (profile.model) args.push("-m", profile.model);
  if (profile.effort) args.push("-c", `model_reasoning_effort=${tomlString(profile.effort)}`);
  if (req.mcp) {
    args.push("-c", `mcp_servers.omem.command=${tomlString(req.mcp.stdio.command)}`);
    args.push("-c", `mcp_servers.omem.args=[${req.mcp.stdio.args.map(tomlString).join(",")}]`);
    args.push("-c", `mcp_servers.omem.env={OMEM_URL=${tomlString(req.mcp.baseUrl)},OMEM_TOKEN=${tomlString(req.mcp.token)}}`);
  }
  args.push("-");
  return args;
}

/** One-shot CLI fallback for agents without ACP. Streams JSON events from stdout. */
export async function runCli(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const isClaude = profile.transport === "claude-cli";
  const args = isClaude ? claudeArgs(profile, req) : codexArgs(profile, req);
  const child = launch(profile.command, args, { cwd: req.cwd, env: { ...profile.env, ...req.env } });
  child.stdin.end(req.prompt);
  let text = "";
  let stderr = "";
  let failure = "";
  let buffer = "";
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
      if (isClaude) {
        if (item.type === "assistant")
          for (const part of item.message?.content ?? []) {
            if (part.type === "text") {
              text += part.text;
              emit({ type: "text", text: part.text });
            } else if (part.type === "tool_use") emit({ type: "tool", id: part.id, title: part.name, status: "in_progress", input: part.input });
            else if (part.type === "thinking") emit({ type: "thought", text: part.thinking ?? "" });
          }
        else if (item.type === "result" && item.is_error) failure = String(item.result ?? "Agent 返回错误");
      } else {
        const it = item.item ?? item.msg;
        if (item.type === "item.completed" && it?.type === "agent_message") {
          text += (text ? "\n\n" : "") + it.text;
          emit({ type: "text", text: it.text });
        } else if (item.type === "item.started" && it?.type) emit({ type: "tool", id: it.id ?? String(Math.random()), title: it.command ?? it.type, status: "in_progress" });
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
  return { text, stopReason: "end_turn", agent: profile.command };
}
