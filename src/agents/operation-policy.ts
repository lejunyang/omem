import { createHash } from "node:crypto";
import { Script, createContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import type { App } from "../core/app.ts";
import { legacyCommand, migrateCommands, operationRulesSchema, saveConfig, type OperationRule } from "../core/config.ts";
import { OWNER } from "../core/users.ts";
import { toolCommand } from "../core/tools.ts";
import { egressSupport } from "./sandbox.ts";
import { audit } from "../auth/permissions.ts";
import type { ToolContext } from "./tools.ts";

export type HttpSource = NonNullable<Extract<OperationRule["match"], { kind: "http" }>["source"]>;
export type Operation =
  | { kind: "command"; executable: string; argv?: string[]; cwd?: string }
  | { kind: "http"; source?: HttpSource; method: string; url: string; body?: unknown; tunnel?: boolean }
  | { kind: "file"; operation: "read"|"write"|"delete"|"rename"; path: string }
  | { kind: "tool"; server?: string; name: string; args: unknown };
export type OperationWho = { member: string; role?: string; profile?: string; space?: string; backend?: string; runId?: string|null };
export function operationWho(ctx: ToolContext): OperationWho {
  return { member: ctx.userId ?? OWNER, role: ctx.role, profile: ctx.spec, space: ctx.spaceId, backend: ctx.agentProfile, runId: ctx.runId };
}
/** Where each kind of rule is acted on. `browser`: a browser session driven by aad asks before a page's request goes out (agents/http-gate.ts). */
export function enforcedBy() {
  const http: string[] = [];
  if (toolCommand("aad")) http.push("browser");
  if (egressSupport().ok) http.push("egress");
  return { command: ["command-gate", "acp"], file: ["acp"], tool: ["omem"], http };
}
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
  const next = { ...app.config, security: { ...app.config.security, operationRules: rules, commandRules: rules.flatMap(r => legacyCommand(r) ?? []) } };
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
export function field(obj: unknown, path: string): unknown {
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
export function hostMatches(pattern: string, hostname: string) {
  const host = pattern.toLowerCase();
  return host.startsWith("*.") ? hostname.endsWith(host.slice(1)) : hostname === host;
}
type CommandConditions = Pick<OperationRule, "action"> & Pick<Extract<OperationRule["match"], {kind: "command"}>, "subcommand" | "argv" | "argsRegex">;
/** Also embedded in the offline PATH wrapper. Keep this function self-contained. */
export function commandArgsMatch(m: CommandConditions, args: string[], test: (pattern: string, input: string) => boolean) {
  function matchesPrefix(prefix: string[]) {
    const requireAll = m.action === "allow";
    let options = true;
    let mayBeValue = false;
    // Track distinct unfinished prefix lengths, without enumerating combinations of option values.
    let positions = new Set([0]);
    for (const arg of args) {
      if (options && arg === "--") {
        options = false;
        mayBeValue = false;
        continue;
      }
      if (options && arg.startsWith("-") && arg !== "-") {
        mayBeValue = !arg.includes("=");
        continue;
      }
      const next = mayBeValue ? new Set(positions) : new Set<number>();
      for (const pos of positions) {
        if (arg !== prefix[pos]) {
          if (requireAll) return false;
        } else if (pos + 1 === prefix.length) {
          if (!requireAll) return true;
        } else {
          next.add(pos + 1);
        }
      }
      if (!next.size) return requireAll;
      positions = next;
      mayBeValue = false;
    }
    return false;
  }
  return (!m.subcommand?.length || matchesPrefix(m.subcommand)) &&
    (!m.argv || m.argv.every(({index,regex}) => args[index] !== undefined && test(regex,args[index]!))) &&
    (!m.argsRegex || test(m.argsRegex,args.join(" ")));
}
function target({ match: m, action }: OperationRule, op: Operation): boolean | undefined {
  if (m.kind === "command" && op.kind === "command") {
    if (executableName(m.executable) !== executableName(op.executable)) return false;
    const args = op.argv;
    if (!args) return m.subcommand || m.argv || m.argsRegex ? undefined : true;
    return commandArgsMatch({ ...m, action },args,matches);
  }
  if (m.kind === "http" && op.kind === "http") {
    const u = new URL(op.url);
    if (m.source && m.source !== op.source) return false;
    if (!hostMatches(m.host,u.hostname)) return false;
    if (op.tunnel && (m.methods || m.pathRegex || m.body)) return undefined;
    return (!m.methods || m.methods.some(v => v.toUpperCase() === op.method.toUpperCase())) &&
      (!m.pathRegex || matches(m.pathRegex,u.pathname)) && (!m.body || jsonMatches(op.body,m.body));
  }
  if (m.kind === "file" && op.kind === "file") return m.operations.includes(op.operation) && matches(m.pathRegex,op.path);
  if (m.kind === "tool" && op.kind === "tool") return (m.server ?? "omem") === (op.server ?? "omem") && m.name === op.name && (!m.args || m.args.every(p => jsonMatches(op.args,p)));
  return false;
}
/** Whether a rule is on and its scope covers this caller. */
export function ruleApplies(rule: OperationRule, who: OperationWho) {
  const s = rule.scope;
  return rule.enabled && !((s?.members && !s.members.includes(who.member)) ||
    (s?.roles && !s.roles.some(r => r === who.role || r === who.profile)) ||
    (s?.spaces && !s.spaces.includes(who.space ?? "")) || (s?.backends && !s.backends.includes(who.backend ?? "")));
}
export function decide(app: App, op: Operation, who: OperationWho): { rule?: OperationRule; action: OperationRule["action"]|"unavailable" } {
  for (const rule of currentRules(app)) {
    if (!ruleApplies(rule, who)) continue;
    try {
      const match = target(rule, op);
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
    return digest([op.kind,...(rule.match.kind === "http" && rule.match.source ? [op.source] : []),op.method.toUpperCase(),u.host,u.pathname,rule.match.kind === "http" && rule.match.body ? field(op.body,rule.match.body.jsonPath) : null]);
  }
  if (op.kind === "command") return digest([op.kind, executableName(op.executable), op.argv, op.cwd]);
  return digest(op.kind === "tool" ? [op.kind,op.server ?? "omem",op.name,op.args] : op);
}
export function auditOperation(app: App, op: Operation, who: OperationWho, rule: OperationRule|undefined, action: string, result: string, approver?: string) {
  const target = op.kind === "command" ? op.executable : op.kind === "file" ? op.path : op.kind === "tool" ? op.name : op.method + " " + new URL(op.url).host + new URL(op.url).pathname;
  audit(app, who.member, op.kind+"."+action, target.slice(0,300), { kind: op.kind, member: who.member, runId: who.runId, ruleId: rule?.id, revision: rule?.revision, action, result, approver,
    ...(op.kind === "http" && { source: op.source }),
    ...(op.kind === "command" ? { argsHash: digest(op.argv ?? []), commandLine: [op.executable,...(rule?.match.kind === "command" ? rule.match.subcommand ?? [] : [])].join(" ").slice(0,200) } : {}) });
}
