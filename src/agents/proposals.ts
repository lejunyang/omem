import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { customizeRole, isBuiltinRole, saveRoleOverride, updateRoleMeta } from "./builtin-roles.ts";
import { findAgentSpec, saveAgentSpec, saveSkill } from "./specs.ts";

/**
 * Changes proposed for a profile (agent spec or built-in role) by its review: a new prompt, a
 * skill to write and attach, or settings (tools, skills). They change behaviour for every later
 * run, so nothing applies until the owner says so on the profile page.
 */
export const proposalContent = {
  prompt: z.object({ prompt: z.string().trim().min(1).max(12000) }),
  skill: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/), description: z.string().trim().min(1), body: z.string().trim().min(1) }),
  settings: z.object({ add_tools: z.array(z.string()).default([]), remove_tools: z.array(z.string()).default([]), add_skills: z.array(z.string()).default([]), remove_skills: z.array(z.string()).default([]) }),
};
export type ProposalKind = keyof typeof proposalContent;

export function profileExists(app: App, name: string) {
  return isBuiltinRole(name) || !!findAgentSpec(app, name);
}

export function createProposal(app: App, input: { target: string; kind: ProposalKind; title: string; reason: string; content: unknown; runId: string | null }) {
  if (!profileExists(app, input.target)) throw new HttpError(404, `没有 Agent 档案或内置角色 ${input.target}`);
  const content = proposalContent[input.kind].parse(input.content);
  // One pending proposal per target and title: a later review refines it instead of piling up.
  const same = one<{ id: string }>(app.db, "select id from profile_proposals where target = ? and kind = ? and title = ? and status = 'pending'", input.target, input.kind, input.title);
  const id = same?.id ?? newId("pp");
  run(
    app.db,
    `insert into profile_proposals(id, target, kind, title, body, reason, status, run_id, created_at) values(?,?,?,?,?,?,'pending',?,?)
     on conflict(id) do update set body = excluded.body, reason = excluded.reason, run_id = excluded.run_id, created_at = excluded.created_at, expiry_notice_at = null`,
    id,
    input.target,
    input.kind,
    input.title,
    JSON.stringify(content),
    input.reason,
    input.runId,
    now(),
  );
  return id;
}

type Row = { id: string; target: string; kind: ProposalKind; body: string; status: string };

export function applyProposal(app: App, id: string, by = "owner") {
  const p = one<Row>(app.db, "select id, target, kind, body, status from profile_proposals where id = ?", id);
  if (!p) throw new HttpError(404, "建议不存在");
  if (p.status !== "pending") throw new HttpError(409, "这条建议已经处理过");
  const content = JSON.parse(p.body);
  const role = isBuiltinRole(p.target);
  if (p.kind === "prompt") {
    const { prompt } = proposalContent.prompt.parse(content);
    if (role) {
      const text = customizeRole(app, p.target);
      const head = /^---\n[\s\S]*?\n---\n/.exec(text)![0];
      saveRoleOverride(app, p.target, `${head}\n${prompt.trim()}\n`);
    } else saveAgentSpec(app, { name: p.target, prompt }, "user");
  } else if (p.kind === "skill") {
    const s = proposalContent.skill.parse(content);
    saveSkill(app, { name: s.name, description: s.description, body: s.body, status: "active" }, "user");
    attachSkills(app, p.target, [s.name], []);
  } else {
    const s = proposalContent.settings.parse(content);
    attachSkills(app, p.target, s.add_skills, s.remove_skills);
    if (s.add_tools.length || s.remove_tools.length) {
      const edit = (tools: string[]) => [...new Set([...tools.filter((t) => !s.remove_tools.includes(t)), ...s.add_tools])];
      if (role) updateRoleMeta(app, p.target, (m) => ({ ...m, tools: edit(m.tools) }), "user");
      else saveAgentSpec(app, { name: p.target, tools: edit(findAgentSpec(app, p.target)!.tools) }, "user");
    }
  }
  run(app.db, "update profile_proposals set status = 'applied', resolved_at = ?, resolved_by = ? where id = ?", now(), by, id);
  return { ok: true };
}

export function rejectProposal(app: App, id: string, by = "owner") {
  const r = run(app.db, "update profile_proposals set status = 'rejected', resolved_at = ?, resolved_by = ? where id = ? and status = 'pending'", now(), by, id);
  if (!r.changes) throw new HttpError(404, "没有待处理的这条建议");
  return { ok: true };
}

/** Attach / detach skills on a spec or a built-in role. */
export function attachSkills(app: App, target: string, add: string[], remove: string[], actor: "user" | "agent" = "user") {
  if (!add.length && !remove.length) return;
  const edit = (skills: string[]) => [...new Set([...skills.filter((x) => !remove.includes(x)), ...add])];
  if (isBuiltinRole(target)) updateRoleMeta(app, target, (m) => ({ ...m, skills: edit(m.skills) }), actor);
  else {
    const spec = findAgentSpec(app, target);
    if (!spec) throw new HttpError(404, `没有 Agent 档案 ${target}`);
    saveAgentSpec(app, { name: target, skills: edit(spec.skills) }, actor);
  }
}


/** Pending proposals expire this many days after they were made (or last refined by a review). */
export const PROPOSAL_DAYS = 14;
/** The owner hears about it this many days before. */
export const PROPOSAL_NOTICE_DAYS = 2;

export function proposalExpiresAt(createdAt: string) {
  return new Date(Date.parse(createdAt) + PROPOSAL_DAYS * 86400_000).toISOString();
}

/**
 * Nightly: pending proposals older than 14 days become "expired" (they can be proposed again by a
 * later review); those that will expire within two days are announced once, in one notification.
 * There is no cap on how many may be pending.
 */
export async function expireProposals(app: App, at = Date.now()) {
  const cutoff = new Date(at - PROPOSAL_DAYS * 86400_000).toISOString();
  const soon = new Date(at - (PROPOSAL_DAYS - PROPOSAL_NOTICE_DAYS) * 86400_000).toISOString();
  const expired = run(app.db, "update profile_proposals set status = 'expired', resolved_at = ?, resolved_by = 'system' where status = 'pending' and created_at < ?", new Date(at).toISOString(), cutoff).changes;
  const due = all<{ id: string; target: string; kind: string; title: string; created_at: string }>(
    app.db,
    "select id, target, kind, title, created_at from profile_proposals where status = 'pending' and created_at < ? and expiry_notice_at is null order by target, created_at",
    soon,
  );
  if (due.length) {
    const { notify } = await import("../core/notify.ts");
    const label: Record<string, string> = { prompt: "提示词", skill: "技能", settings: "设置" };
    const targets = [...new Set(due.map((d) => d.target))];
    notify(app, {
      title: `${due.length} 条档案改进建议两天内过期`,
      body: [
        ...due.slice(0, 12).map((d) => `- ${d.target} · ${label[d.kind] ?? d.kind}：${d.title}（${proposalExpiresAt(d.created_at).slice(0, 10)} 过期）`),
        ...(due.length > 12 ? [`- 另有 ${due.length - 12} 条`] : []),
        "",
        "要用的在 Agent 页采纳；不处理的到期自动过期，之后的复盘还可能再提。",
      ].join("\n"),
      link: `#/agents?tab=agents&${targets.length === 1 ? `${isBuiltinRole(targets[0]) ? "role" : "name"}=${encodeURIComponent(targets[0])}` : ""}`,
    });
    const stamp = new Date(at).toISOString();
    for (const d of due) run(app.db, "update profile_proposals set expiry_notice_at = ? where id = ?", stamp, d.id);
  }
  return { expired, noticed: due.length };
}
