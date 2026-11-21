import type { App } from "../core/app.ts";
import { gateOperation, type Decision } from "./command-gate.ts";
import { currentRules, digest, operationWho, ruleApplies } from "./operation-policy.ts";
import type { ToolContext } from "./tools.ts";

/**
 * Where the HTTP operation rules are acted on (docs/v2/command-gate.md, “网页请求”): a browser session
 * an agent drives through aad pauses a page's request, asks here with the run's token, and sends it
 * only on `allow`. Two calls: which requests to ask about at all (so the browser intercepts as little
 * as it can), and one request's decision. The decision is the same gate as a command's: the rules in
 * order, an approval card when a rule asks for one, a grant used once.
 */
export type HttpWatch = { host: string | null; methods: string[] | null };

/**
 * The requests worth pausing for this caller: every rule that could say something other than “send it”
 * (`allow` rules only open a gap in a wider rule: that wider rule is what puts the request here).
 * `revision` changes whenever the answer could.
 */
export function httpWatch(app: App, ctx: ToolContext): { revision: string; watch: HttpWatch[] } {
  const who = operationWho(ctx);
  const rules = currentRules(app).filter((r) => r.match.kind === "http" && r.action !== "allow" && ruleApplies(r, who));
  const seen = new Set<string>();
  const watch: HttpWatch[] = [];
  for (const r of rules) {
    if (r.match.kind !== "http") continue;
    const entry = { host: r.match.host.toLowerCase(), methods: r.match.methods?.length ? [...new Set(r.match.methods.map((m) => m.toUpperCase()))].sort() : null };
    const key = JSON.stringify(entry);
    if (!seen.has(key)) { seen.add(key); watch.push(entry); }
  }
  return { revision: digest(rules.map((r) => [r.id, r.revision])).slice(0, 16), watch };
}

export type HttpGateRequest = { method: string; url: string; body?: string; contentType?: string; page?: { url?: string; title?: string }; session?: string };

/** A JSON body as the rules' `body.jsonPath` reads it; anything else matches no body rule. */
function parsedBody(req: HttpGateRequest): unknown {
  if (!req.body) return undefined;
  const looksJson = /json/i.test(req.contentType ?? "") || /^\s*[[{]/.test(req.body);
  if (!looksJson) return undefined;
  try { return JSON.parse(req.body); } catch { return undefined; }
}

/** One request about to leave a page: let it go, stop it, or stop it until someone approves. */
export async function httpGate(app: App, ctx: ToolContext, req: HttpGateRequest, session?: string): Promise<Decision> {
  let url: URL;
  try { url = new URL(req.url); } catch { return { decision: "deny", message: "请求的地址不是有效的 URL，无法按规则判断" }; }
  if (!/^https?:$/.test(url.protocol)) return { decision: "allow" };
  const page = [req.page?.title, req.page?.url].filter(Boolean).join(" · ");
  return gateOperation(app, ctx, { kind: "http", method: req.method.toUpperCase(), url: url.href, body: parsedBody(req) }, { page }, session ?? req.session);
}
