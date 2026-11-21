import type { AgentProfile, OperationRule } from "../core/config.ts";
import { accountOnlyCatalog, acpCatalog } from "./catalog.ts";
import { gateOperation, type Decision } from "./command-gate.ts";
import { parsedBody } from "./http-gate.ts";
import { currentRules, decide, digest, fingerprint, hostMatches, operationWho, ruleApplies, type Operation } from "./operation-policy.ts";
import type { Destination } from "./egress-proxy.ts";
import type { ToolContext } from "./tools.ts";

export function backendHosts(profile: AgentProfile) {
  const entry = [...acpCatalog,...accountOnlyCatalog].find(e => e.id === (profile.source ?? profile.id) || e.command === profile.command);
  const hosts = new Set(entry?.egressHosts ?? []);
  for (const key of ["OPENAI_BASE_URL","ANTHROPIC_BASE_URL","GOOGLE_GEMINI_BASE_URL"]) {
    const value = profile.env[key];
    if (value) { const url = new URL(value); if (/^https?:$/.test(url.protocol)) hosts.add(url.host); }
  }
  return hosts;
}

export function egressPolicy(ctx: ToolContext, own: Set<string>) {
  const { app } = ctx;
  const who = operationWho(ctx);
  const pending = new Map<string, { host: string; answer: Promise<Decision> }>();
  return { pending,
    needsBody(url: URL) {
      return currentRules(app).some(r => r.match.kind === "http" && r.match.body && ruleApplies(r,who) && hostMatches(r.match.host,url.hostname));
    },
    async check(d: Destination) {
      const settings = app.config.security.egress;
      const op: Operation = { kind: "http", method: d.method, url: d.url.href, tunnel: d.tunnel, body: parsedBody({ body: d.body?.toString(), contentType: d.contentType }) };
      const backend = !d.private && own.has(d.url.host);
      if (backend) return { allowed: true, backend };
      function evaluate() {
        const result = decide(app,op,who);
        if (result.rule && result.action !== "unavailable" && (!d.private || result.action !== "log")) return result;
        const unsure = result.action === "unavailable";
        const config = app.config.security.egress;
        const action = d.private ? "deny" : unsure ? config.tunnelWhenUnsure : config.default;
        const title = d.private ? "内网地址需要显式放行" : unsure ? "隧道内的请求条件不可见" : "默认出网策略";
        const rule: OperationRule = { id: "egress/" + digest([d.url.host,title,result.rule?.id,result.rule?.revision,action]), enabled: true, revision: 1, title, action, match: { kind: "http", host: d.url.hostname } };
        return { rule, action };
      }
      const initial = evaluate();
      const fallback = !currentRules(app).includes(initial.rule!);
      const ask = () => gateOperation(app,ctx,op,{},undefined,{ evaluate, fallback, waitSeconds: settings.waitSeconds });
      if (initial.action !== "approve") {
        // Default-allow traffic is recorded once per host in the run summary.
        if (initial.action === "allow" && fallback && !d.tunnel) return { allowed: true };
        const answer = await ask();
        return { allowed: answer.decision === "allow", reason: answer.message };
      }
      const key = digest([initial.rule!.id,initial.rule!.revision,fingerprint(op,initial.rule!)]);
      let group = pending.get(key);
      if (!group) {
        if (pending.size >= 16) return { allowed: false, reason: "出网审批等待数已达上限" };
        group = { host: d.url.host, answer: ask().finally(() => pending.delete(key)) };
        pending.set(key,group);
      }
      const answer = await group.answer;
      return { allowed: answer.decision === "allow", reason: answer.message };
    }
  };
}
