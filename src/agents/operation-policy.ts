import { createHash } from "node:crypto";
import { Script, createContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import type { App } from "../core/app.ts";
import { legacyCommand, migrateCommands, operationRulesSchema, saveConfig, type OperationRule } from "../core/config.ts";
import { OWNER } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import type { ToolContext } from "./tools.ts";

export type Operation =
  | { kind: "command"; executable: string; argv?: string[]; cwd?: string }
  | { kind: "http"; method: string; url: string; body?: unknown }
  | { kind: "file"; operation: "read"|"write"|"delete"|"rename"; path: string }
  | { kind: "tool"; server?: string; name: string; args: unknown };
export type OperationWho = { member: string; role?: string; profile?: string; space?: string; backend?: string; runId?: string|null };
export function operationWho(ctx: ToolContext): OperationWho {
  return { member: ctx.userId ?? OWNER, role: ctx.role, profile: ctx.spec, space: ctx.spaceId, backend: ctx.agentProfile, runId: ctx.runId };
}
export const enforcedBy = { command: ["command-gate","acp"], file: ["acp"], tool: ["omem"], http: [] };
export function currentRules(app: App) {
  const { operationRules, commandRules } = app.config.security;
  return operationRules.length || !commandRules.length ? operationRules : migrateCommands(commandRules);
}
export function saveOperationRules(app: App, input: OperationRule[]) {
  const prior = new Map(currentRules(app).map(r => [r.id,r]));
  const rules = operationRulesSchema.parse(input).map(r => {
    const old = prior.get(r.id);
    return { ...r, revision: old ? old.revision + Number(!isDeepStrictEqual(old, { ...r, revision: old.revision })) : Math.max(1, Date.now()) };
  });
  const next = { ...app.config, security: { operationRules: rules, commandRules: rules.flatMap(r => legacyCommand(r) ?? []) } };
  saveConfig(next, app.home);
  Object.assign(app.config, next);
  return rules;
}
const regexTest = new Script("new RegExp(pattern).test(input)");
class MatchBudget extends Error {}
function matches(pattern: string, input: string) {
  if (input.length > 8192) throw new MatchBudget();
  try { return !!regexTest.runInContext(createContext({ pattern, input }), { timeout: 25 }); }
  catch { throw new MatchBudget(); }
}
function field(obj: unknown, path: string): unknown {
  for (const m of path.matchAll(/\.([\w-]+)|\[(\d+)\]/g)) {
    const k = m[1] ?? m[2]!;
    if (!obj || typeof obj !== "object" || !Object.hasOwn(obj,k)) return undefined;
    obj = (obj as Record<string,unknown>)[k];
  }
  return obj;
}
function jsonMatches(obj: unknown, p: { jsonPath: string; regex: string }) {
  const v = field(obj,p.jsonPath);
  return v !== undefined && matches(p.regex, typeof v === "string" ? v : JSON.stringify(v));
}
export const executableName = (s: string) => process.platform === "win32" ? s.toLowerCase() : s;
function target(m: OperationRule["match"], op: Operation): boolean | undefined {
  if (m.kind === "command" && op.kind === "command") {
    if (executableName(m.executable) !== executableName(op.executable)) return false;
    const args = op.argv;
    if (!args) return m.subcommand || m.argv || m.argsRegex ? undefined : true;
    const words = args.filter(a => !a.startsWith("-"));
    return (!m.subcommand || m.subcommand.every((w,i) => words[i] === w)) &&
      (!m.argv || m.argv.every(({index,regex}) => args[index] !== undefined && matches(regex,args[index]!))) &&
      (!m.argsRegex || matches(m.argsRegex,args.join(" ")));
  }
  if (m.kind === "http" && op.kind === "http") {
    const u = new URL(op.url), host = m.host.toLowerCase();
    return (host.startsWith("*.") ? u.hostname.endsWith(host.slice(1)) : u.hostname === host) &&
      (!m.methods || m.methods.some(v => v.toUpperCase() === op.method.toUpperCase())) &&
      (!m.pathRegex || matches(m.pathRegex,u.pathname)) && (!m.body || jsonMatches(op.body,m.body));
  }
  if (m.kind === "file" && op.kind === "file") return m.operations.includes(op.operation) && matches(m.pathRegex,op.path);
  if (m.kind === "tool" && op.kind === "tool") return (m.server ?? "omem") === (op.server ?? "omem") && m.name === op.name && (!m.args || m.args.every(p => jsonMatches(op.args,p)));
  return false;
}
export function decide(app: App, op: Operation, who: OperationWho): { rule?: OperationRule; action: OperationRule["action"]|"unavailable" } {
  for (const rule of currentRules(app)) {
    const s = rule.scope;
    if (!rule.enabled || (s?.members && !s.members.includes(who.member)) ||
      (s?.roles && !s.roles.some(r => r === who.role || r === who.profile)) ||
      (s?.spaces && !s.spaces.includes(who.space ?? "")) || (s?.backends && !s.backends.includes(who.backend ?? ""))) continue;
    try {
      const match = target(rule.match, op);
      if (match === undefined) return { rule, action: "unavailable" };
      if (match) return { rule, action: rule.action };
    } catch (e) {
      if (e instanceof MatchBudget) return { rule, action: "deny" };
      throw e;
    }
  }
  return { action: "allow" };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function fingerprint(op: Operation, rule: OperationRule) {
  if (op.kind === "http") {
    const u = new URL(op.url);
    return digest([op.kind,op.method.toUpperCase(),u.host,u.pathname,rule.match.kind === "http" && rule.match.body ? field(op.body,rule.match.body.jsonPath) : null]);
  }
  if (op.kind === "command") return digest([op.kind, executableName(op.executable), op.argv, op.cwd]);
  return digest(op.kind === "tool" ? [op.kind,op.server ?? "omem",op.name,op.args] : op);
}
export function auditOperation(app: App, op: Operation, who: OperationWho, rule: OperationRule|undefined, action: string, result: string, approver?: string) {
  const target = op.kind === "command" ? op.executable : op.kind === "file" ? op.path : op.kind === "tool" ? op.name : op.method + " " + new URL(op.url).host + new URL(op.url).pathname;
  audit(app, who.member, "operation."+action, target.slice(0,300), { kind: op.kind, member: who.member, runId: who.runId, ruleId: rule?.id, revision: rule?.revision, action, result, approver,
    ...(op.kind === "command" ? { argsHash: digest(op.argv ?? []), commandLine: [op.executable,...(rule?.match.kind === "command" ? rule.match.subcommand ?? [] : [])].join(" ").slice(0,200) } : {}) });
}
