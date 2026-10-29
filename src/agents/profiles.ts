import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { listMemories } from "../memory/store.ts";
import { isBuiltinRole, roleHistory, roleOverrideText, roleSourceText, roleState } from "./builtin-roles.ts";
import { loadRole } from "./runner.ts";
import { feedbackStats } from "../channels/lark-feedback.ts";
import { agentSpecHistory, listSkills, readAgentSpec, readSkill } from "./specs.ts";

/**
 * One view of a profile, whether an agent spec the owner made or a built-in role: what it is,
 * what it has learned (attached skills, its own memories), how it has been doing and its history.
 * The profile page and the coach read the same thing.
 */
export function profileDetail(app: App, name: string) {
  const role = isBuiltinRole(name);
  const skillNames = role ? loadRole(name, app).skills : readAgentSpec(app, name).skills;
  const skills = skillNames.map((n) => {
    try {
      const s = readSkill(app, n);
      return { name: s.name, description: s.description, status: s.status as string, body: s.body, files: s.files };
    } catch {
      return { name: n, description: "（技能不存在）", status: "missing", body: "", files: [] as string[] };
    }
  });
  const availableSkills = listSkills(app, { includeDrafts: true }).map((s) => ({ name: s.name, description: s.description, status: s.status }));
  // Only memories that belong to this profile; shared ones live on the memory page.
  const memories = listMemories(app, { agent: name, agentScope: "own", status: "active", limit: 200 });
  const proposals = all<{ id: string; kind: string; title: string; body: string; reason: string; status: string; created_at: string; run_id: string | null }>(
    app.db,
    "select id, kind, title, body, reason, status, created_at, run_id from profile_proposals where target = ? order by created_at desc limit 50",
    name,
  ).map((p) => ({ id: p.id, kind: p.kind, title: p.title, body: p.body, reason: p.reason, status: p.status, createdAt: p.created_at, runId: p.run_id }));
  return {
    kind: role ? ("role" as const) : ("spec" as const),
    skills,
    availableSkills,
    memories,
    proposals,
    usage: profileUsage(app, name),
    history: role ? roleHistory(app, name) : agentSpecHistory(app, name),
    ...(role ? { role: { ...roleState(app, name), source: roleSourceText(name), own: roleOverrideText(app, name) } } : {}),
  };
}

/** How a profile has been used lately: its runs (specs), recalls of its own memories and hits. */
export function profileUsage(app: App, name: string) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const runs = all<{ status: string; n: number }>(
    app.db,
    "select status, count(*) n from runs where kind in ('agent', 'agent-followup') and json_extract(input, '$.spec') = ? and created_at > ? group by status",
    name,
    since,
  );
  const last = one<{ id: string; created_at: string; status: string }>(
    app.db,
    "select id, created_at, status from runs where kind in ('agent', 'agent-followup') and json_extract(input, '$.spec') = ? order by created_at desc limit 1",
    name,
  );
  const recall = one<{ recalls: number; used: number }>(
    app.db,
    "select count(*) recalls, coalesce(sum(r.used), 0) used from memory_recalls r join memories m on m.id = r.memory_id where m.agent = ? and r.at > ?",
    name,
    since,
  );
  const lastReview = one<{ value: string }>(app.db, "select value from kv where key = ?", `profile_review_at:${name}`)?.value ?? null;
  // Reactions on what its runs sent in Feishu: the owner's, other users' and guests' apart.
  const feedback = feedbackStats(app, 30).byProfile.find((r) => r.key === name) ?? null;
  return {
    runs30d: Object.fromEntries(runs.map((r) => [r.status, r.n])) as Record<string, number>,
    lastRun: last ? { id: last.id, at: last.created_at, status: last.status } : null,
    recalls30d: recall?.recalls ?? 0,
    recallHits30d: recall?.used ?? 0,
    lastReviewAt: lastReview,
    feedback30d: feedback ? { owner: feedback.owner, others: feedback.others, guests: feedback.guests } : null,
  };
}
