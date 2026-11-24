export const runKinds = [
  "commit-claim", "item-follow", "flow-reconcile", "flow-review", "study-trial", "peer-work", "peer-trial", "flow-stage", "flow-runner", "archive",
  "archive-rule-draft", "ask", "agent", "agent-followup", "thread-summary", "learn-feed", "ingest",
  "wiki-plan", "wiki-write", "wiki-lint", "wiki-organize", "wiki-resolve", "wiki-migrate", "heartbeat",
  "dream", "code", "review", "tutor", "sync", "brief", "curate",
  "ingest-shadow", "note-review", "memory-review", "memory-organize", "skill-organize", "item-settle", "role-merge",
  "profile-review", "rule-fire", "rule-script", "guest", "lark-command", "lark-resource-parse", "wake",
  "triage", "digest", "peer-agent", "replay", "replay-arm", "replay-judge", "kb-scout",
  "req-split", "design", "speaking-review", "mention", "work-state", "quality-audit", "wiki-sweep",
  "listen-coach", "outcome-review", "problem-follow",
] as const;
export type RunKind = (typeof runKinds)[number];
