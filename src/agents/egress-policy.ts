import type { AgentProfile, OperationRule } from "../core/config.ts";
import { entryForProfile } from "./catalog.ts";
import { gateOperation, type Decision } from "./command-gate.ts";
import { parsedBody } from "./http-gate.ts";
import { currentRules, decide, digest, field, fingerprint, hostMatches, operationWho, ruleApplies, type Operation } from "./operation-policy.ts";
import type { Destination } from "./egress-proxy.ts";
import type { ToolContext } from "./tools.ts";

export function backendHosts(profile: AgentProfile) {
  const entry = entryForProfile(profile);
  const hosts = new Set(entry?.egressHosts ?? []);
  for (const key of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "OMEM_AI_BASE_URL"]) {
    const value = profile.env[key];
    if (value) { const url = new URL(value); if (/^https?:$/.test(url.protocol)) hosts.add(url.host); }
  }
  return hosts;
}

export function egressPolicy(ctx: ToolContext, own: Set<string>, signal?: AbortSignal) {
  const { app } = ctx;
  const who = operationWho(ctx);
  const pending = new Map<string, Promise<Decision>>();
  return {
    needsBody(url: URL) {
      return currentRules(app).some(r => r.match.kind === "http" && r.match.body && ruleApplies(r, who) && hostMatches(r.match.host, url.hostname));
    },
    async check(d: Destination) {
      const settings = app.config.security.egress;
      const op: Operation = { kind: "http", method: d.method, url: d.url.href, tunnel: d.tunnel, body: parsedBody({ body: d.body?.toString(), contentType: d.contentType }) };
      const backend = !d.private && own.has(d.url.host);
      if (backend) return { allowed: true, backend };
      function resolution() {
        const result = decide(app, op, who);
        if (result.rule && result.action !== "unavailable" && (!d.private || result.action !== "log")) return { decision: result, fallback: false, summaryOnly: false };
        const unsure = result.action === "unavailable";
        const config = app.config.security.egress;
        const action = d.private ? "deny" : unsure ? config.tunnelWhenUnsure : config.default;
        const title = d.private ? "内网地址需要显式放行" : unsure ? "隧道内的请求条件不可见" : "默认出网策略";
        const rule: OperationRule = { id: "egress/" + digest([d.url.host, title, result.rule?.id, result.rule?.revision, action]), enabled: true, revision: 1, title, action, match: { kind: "http", host: d.url.hostname } };
        return { decision: { rule, action }, fallback: true, summaryOnly: !d.private && !unsure && action === "allow" };
      }
      const { decision: initial, fallback, summaryOnly } = resolution();
      const evaluate = () => resolution().decision;
      const bodyRule = initial.rule?.match.kind === "http" && initial.rule.match.body;
      const value = bodyRule && field(op.body, bodyRule.jsonPath);
      const fieldSummary = bodyRule ? bodyRule.jsonPath + " = " + (value !== null && typeof value === "object" ? "（结构化值）" : String(value).slice(0, 100)) : undefined;
      const ask = () => {
        const timeout = AbortSignal.timeout(settings.waitSeconds * 1000);
        const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
        return new Promise<Decision>((resolve, reject) => {
          const abort = () => resolve({ decision: "deny", message: signal?.aborted ? "运行已结束" : "出网审批超时，请求已拒绝" });
          if (stop.aborted) { abort(); return; }
          stop.addEventListener("abort", abort, { once: true });
          gateOperation(app, ctx, op, {}, undefined, { evaluate, fallback, signal: stop, fieldSummary, waitSeconds: settings.waitSeconds })
            .then(resolve, reject).finally(() => stop.removeEventListener("abort", abort));
        });
      };
      if (initial.action !== "approve") {
        // Default-allow traffic is recorded once per host in the run summary.
        if (summaryOnly) return { allowed: true };
        const answer = await ask();
        return { allowed: answer.decision === "allow", reason: answer.message };
      }
      const key = digest([initial.rule!.id, initial.rule!.revision, fingerprint(op, initial.rule!)]);
      let group = pending.get(key);
      if (!group) {
        if (pending.size >= 16) return { allowed: false, reason: "出网审批等待数已达上限" };
        group = ask().finally(() => pending.delete(key));
        pending.set(key, group);
      }
      const answer = await group;
      return { allowed: answer.decision === "allow", reason: answer.message };
    }
  };
}
