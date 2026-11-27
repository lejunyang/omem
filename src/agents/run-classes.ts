/** Stable policy categories shared by settings, the scheduler and the routing model. */
export const runClasses = {
  routine: { name: "日常整理", description: "每来一批材料就跑，次数多、量大，要省、要稳", kinds: ["ingest", "ingest-shadow", "archive", "archive-rule-draft", "thread-summary", "memory-review", "memory-organize", "skill-organize", "item-settle", "item-follow", "item-takeover", "commit-claim", "learn-feed", "note-review", "curate", "sync", "role-merge", "lark-resource-parse"], roles: ["ingest", "archivist", "archive-rule-writer", "summarizer", "memory-reviewer", "memory-organizer", "skill-organizer", "item-keeper", "item-follow", "commit-claim", "note-reviewer", "curator"] },
  watch: { name: "巡检与分诊", description: "频繁触发，需要快速发现和分诊问题", kinds: ["heartbeat", "triage", "mention", "first-look", "digest", "problem-follow", "item-deadline-check", "kb-scout", "wake", "listen-coach"], roles: ["heartbeat", "triager", "mention-triage", "first-look", "distiller", "kb-scout", "listen-coach"] },
  chat: { name: "对话", description: "有人在等回答", kinds: ["ask", "lark-command", "guest", "tutor"], roles: ["assistant", "gatekeeper", "guest", "tutor", "coach"] },
  writing: { name: "写作", description: "写作与组织知识，输出长", kinds: ["wiki-plan", "wiki-write", "wiki-organize", "wiki-resolve", "wiki-lint", "wiki-migrate", "wiki-sweep", "brief", "dream", "work-state"], roles: ["wiki-planner", "wiki-writer", "wiki-organizer", "wiki-checker", "wiki-linter", "brief", "dreamer", "work-state"] },
  coding: { name: "编码", description: "按编码角色的设置实现需求", kinds: ["code", "design", "req-split"], roles: ["coder", "designer", "req-splitter", "business-analyst"] },
  review: { name: "评审", description: "按评审角色的设置独立检查", kinds: ["review", "quality-audit", "outcome-review", "flow-review", "profile-review", "replay-judge", "speaking-review"], roles: ["reviewer", "review-business", "review-arch", "review-style", "review-history", "review-simplify", "review-lead", "replay-judge", "outcome-reviewer"] },
  agents: { name: "调查与交办", description: "档案和其他设备承接的任务，内容差别大", kinds: ["agent", "ai-policy-draft", "agent-followup", "peer-agent", "peer-work", "rule-fire", "rule-script"], roles: [] },
  flows: { name: "流程与研究", description: "按阶段推进，可以为每个阶段指定 AI", kinds: ["flow-stage", "flow-runner", "flow-reconcile", "flow-blocker-check", "study-trial", "peer-trial"], roles: ["flow-reconcile"] },
  supervise: { name: "监工", description: "长任务需要稳定、能力强的 AI", kinds: ["supervise"], roles: ["supervisor"] },
} satisfies Record<string, { name: string; description: string; kinds: string[]; roles: string[] }>;
export type RunClass = keyof typeof runClasses;
export const classIds = Object.keys(runClasses) as RunClass[];
export const internalKinds = ["probe", "replay", "replay-arm"];
export function runClass(kind?: string, role?: string, declared?: RunClass): RunClass | undefined {
  if (kind && internalKinds.includes(kind)) return undefined;
  if (declared) return declared;
  if (role === "supervisor" || kind === "supervise") return "supervise";
  const lookup = (key: "kinds" | "roles", value?: string) => value && classIds.find(id => (runClasses[id][key] as string[]).includes(value));
  return lookup("kinds", kind) || lookup("roles", role) || "agents";
}
