import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { credentialCommand } from "./credential-outcome.ts";
import { gateOperation } from "./command-gate.ts";
import { auditOperation, decide, digest, operationWho, type Operation } from "./operation-policy.ts";
import { toolContextForToken, type ToolContext } from "./tools.ts";

type ToolCall = RequestPermissionRequest["toolCall"];
const fileKinds = { read: "read", edit: "write", delete: "delete", move: "rename" } as const;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(arg => typeof arg === "string");

function operations(call: ToolCall, cwd: string): Operation[] {
  const input = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Record<string, unknown>;
  if (call.kind === "execute") {
    // Adapters may supply the whole command as an array, or separate the executable and arguments.
    // Free-form shell strings and display titles have no reliable argv.
    const command = input.command ?? (input.executable === undefined ? input.argv : undefined);
    const vector = stringArray(command) ? command : undefined;
    const executable = vector?.[0] ?? input.executable ?? input.command;
    if (typeof executable !== "string" || !executable) return [];
    if (!vector && !input.executable && /\s/.test(executable)) return [];
    const argv = vector ? vector.slice(1) : input.argv ?? input.args;
    return [{ kind: "command", executable, argv: stringArray(argv) ? argv : undefined,
      cwd: typeof input.cwd === "string" ? resolve(cwd, input.cwd) : cwd }];
  }
  const kind = call.kind;
  if (kind !== "read" && kind !== "edit" && kind !== "delete" && kind !== "move") return [];
  const paths: unknown[] = [input.path, input.file_path, input.filePath, ...(call.locations ?? []).map(l => l.path)];
  for (const part of call.content ?? []) if (part.type === "diff") paths.push(part.path);
  if (kind === "move") paths.push(input.source, input.destination, input.from, input.to, input.old_path, input.new_path);
  const targets = paths.filter((p): p is string => typeof p === "string" && !!p).map(p => resolve(cwd, p));
  return [...new Set(targets)].map(path => ({ kind: "file", operation: fileKinds[kind], path }));
}

export async function acpPermission(request: RequestPermissionRequest, opts: {
  app?: App; token?: string; runId?: string | null; backend: string; cwd: string; writable: boolean; guardedDir?: string;
}) {
  const { toolCall: call, options } = request;
  const kind = call.kind ?? "other";
  let allowed = opts.writable || !["edit", "delete", "move"].includes(kind);
  let message: string | undefined;
  const ops = operations(call, opts.cwd);
  if (opts.app && ops.length) {
    const ctx: ToolContext | null = opts.token ? toolContextForToken(opts.app, opts.token) : {
      app: opts.app, runId: opts.runId ?? null, spaceId: "", spaces: [], tools: new Set(), agentProfile: opts.backend, actor: "agent",
    };
    if (!ctx) allowed = false;
    else {
      const who = operationWho(ctx);
      for (const raw of ops) {
        const op = raw.kind === "command" ? { ...raw, executable: basename(raw.executable) } : raw;
        const { rule, action } = decide(opts.app, op, who);
        if (action === "log") auditOperation(opts.app, op, who, rule, action, allowed ? "允许" : "拒绝");
        const judged = !rule && op.kind === "command" && op.argv && credentialCommand(op.executable, op.argv)?.command.judge;
        if (action === "deny" || ((judged || action === "approve") && allowed)) {
          const wrapper = opts.guardedDir && op.kind === "command" ? resolve(opts.guardedDir, op.executable) : undefined;
          const throughWrapper = wrapper && raw.kind === "command" && existsSync(wrapper)
            && (raw.executable === basename(raw.executable) || resolve(raw.cwd!, raw.executable) === wrapper)
            && options.some(option => option.kind === "allow_once");
          const gate = await gateOperation(opts.app, ctx, op, {
            stage: throughWrapper ? "before-wrapper" : undefined,
          }, !ctx.runId && opts.token ? digest(opts.token) : undefined);
          if (gate.decision !== "allow") {
            allowed = false;
            message = gate.message;
            break;
          }
        }
      }
    }
  }
  // A backend-wide grant would skip subsequent policy checks. omem MCP checks each call itself.
  const session = !ops.length && allowed && call.title === "MCP tool call approval" && options.find(o => o.optionId === "allow_session");
  const option = session || options.find(o => o.kind === (allowed ? "allow_once" : "reject_once"))
    || (!ops.length ? options.find(o => o.kind.startsWith(allowed ? "allow" : "reject")) : undefined);
  return { optionId: option?.optionId, message: message ?? `${allowed && option ? "允许" : "拒绝"}操作：${call.title ?? kind}` };
}
