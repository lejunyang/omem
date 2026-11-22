import { z } from "zod";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { COMMAND_OUTPUT_LIMIT, now } from "../core/util.ts";
import { applicationUrl, recordAccess } from "./credential-access.ts";
import { credentialMethods, type CredentialCommand } from "./credential-registry.ts";
import { expireCommandCredential } from "./credentials.ts";
import { executableName, field } from "./operation-policy.ts";

import type { ToolContext } from "./tools.ts";
import { OWNER } from "../core/users.ts";

export function reportable(ctx: ToolContext) {
  return ctx.actor === "agent" && !!ctx.runId && !ctx.shadow && !ctx.boardAccess && !ctx.view && ctx.role !== "guest" && ctx.commandHomeUser !== null &&
    (ctx.commandHomeUser ?? OWNER) === (ctx.userId ?? OWNER);
}

export const outcomeSchema = z.object({
  command: z.string().min(1).max(100), args: z.array(z.string().max(100_000)).max(10_000),
  code: z.number().int(), output: z.string().max(COMMAND_OUTPUT_LIMIT),
}).strict();

export function credentialCommand(name: string) {
  for (const method of credentialMethods()) {
    const command = method.provides.commands.find(c => executableName(c.name) === executableName(name));
    if (command) return { method, command };
  }
}

export function commandResource(command: CredentialCommand, args: string[]) {
  const options = new Map<string, string | true>();
  for (const [i, arg] of args.entries()) {
    if (arg === "--") break;
    const flag = /^--?([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (flag) {
      const next = args[i + 1];
      options.set(flag[1]!, flag[2] ?? (next !== undefined && !next.startsWith("-") ? next : true));
    }
  }
  const words = args.filter(a => !a.startsWith("-"));
  for (const { match, key } of command.resource ?? []) {
    if (match.subcommand?.some((w,i) => words[i] !== w)) continue;
    if (match.args && (match.args.length !== args.length || match.args.some((w,i) => w !== args[i]))) continue;
    if (Object.entries(match.options ?? {}).some(([k,v]) => typeof v === "boolean" ? v !== options.has(k) : v !== options.get(k))) continue;
    let complete = true;
    const resource = key.replace(/\{option\.([\w-]+)\}/g, (_, opt: string) => {
      const value = options.get(opt);
      if (typeof value === "string" && value) return value;
      complete = false;
      return "";
    });
    if (complete && resource.length <= 1024) return resource;
  }
}

function parseObject(s: string): object | undefined {
  try {
    const data: unknown = JSON.parse(s);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch { /* The command may also print human-readable diagnostics. */ }
}
export function classifyFailure(command: CredentialCommand, output: string) {
  let json = parseObject(output);
  if (!json) {
    for (const line of output.split("\n").reverse()) if ((json = parseObject(line))) break;
  }
  if (json && command.outcomes) {
    for (const reason of Object.keys(command.outcomes) as (keyof typeof command.outcomes)[]) {
      if (reason === "applyUrl" || !command.outcomes[reason]?.some(p => field(json,p.json) === p.equals)) continue;
      const path = command.outcomes.applyUrl;
      return { reason, applyUrl: path ? applicationUrl(field(json,path)) : null };
    }
  }
  return { reason: "failed" as const, applyUrl: null };
}

export async function credentialOutcome(app: App, user: string, runId: string, req: z.infer<typeof outcomeSchema>) {
  const entry = credentialCommand(req.command);
  if (!entry) return {};
  const { method, command } = entry;
  const resource = commandResource(command, req.args);
  if (req.code === 0) {
    if (resource) recordAccess(app, method.kind, resource, user, true, runId);
    run(app.db, "update credential_holds set last_used_at=? where user_id=? and kind=?", now(), user, method.kind);
    return {};
  }
  const result = classifyFailure(command, req.output);
  if (result.reason === "expired" || result.reason === "unauthenticated") await expireCommandCredential(app, user, method);
  if (resource && result.reason === "denied") recordAccess(app, method.kind, resource, user, false, runId, result.applyUrl ?? undefined);
  return result;
}
