import { embeddingId } from "../search/embedding-index.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { roleNames } from "../core/config.ts";
import { notify } from "../core/notify.ts";
import { json } from "../core/util.ts";
import { similarity } from "../memory/quality.ts";
import { embedQuery } from "../search/embeddings.ts";
import { applyProposal, rejectProposal, proposalContent } from "./proposals.ts";
import { loadRole } from "./runner.ts";
import { listAgentSpecs, listSkills, setSkillStatus, skillHeld } from "./specs.ts";

export type SkillCandidate = { id: string; name: string; description: string; text: string; owners: string[] };

export function skillCandidates(app: App): SkillCandidate[] {
  const profiles = listAgentSpecs(app, { includeDrafts: true });
  const mounts = profiles.map((s) => ({ name: s.name, skills: s.skills }));
  for (const name of roleNames) mounts.push({ name, skills: loadRole(name, app).skills });
  // Not a draft the owner turned off themselves, nor one a replay already turned on once: trying those
  // again would undo the owner's decision the next time it wins.
  const drafts = listSkills(app, { includeDrafts: true }).filter((s) => s.status === "draft" && !skillHeld(app, s.name) && !skillDisplayTally(app, s.name).adopted).map((s) => ({
    id: `skill:${s.name}`, name: s.name, description: s.description, text: s.body,
    owners: mounts.filter((m) => m.skills.includes(s.name)).map((m) => m.name),
  }));
  const proposals: SkillCandidate[] = [];
  for (const p of all<{ id: string; target: string; body: string }>(app.db, "select id, target, body from profile_proposals where kind = 'skill' and status = 'pending' order by created_at, id")) {
    if (!mounts.some((m) => m.name === p.target)) continue;
    const s = proposalContent.skill.safeParse(json(p.body, {}));
    if (s.success) proposals.push({ id: `proposal:${p.id}`, name: s.data.name, description: s.data.description, text: s.data.body, owners: [p.target] });
  }
  return [...drafts, ...proposals];
}

export function skillTally(app: App, id: string) {
  const r = one<{ wins: number; losses: number; adopted: number }>(app.db,
    `select coalesce(sum(effect = 'helped'), 0) wins, coalesce(sum(effect = 'hurt'), 0) losses,
      coalesce(max(effect = 'adopt'), 0) adopted from replay_effects where target_kind = 'skill' and target_id = ? and status = 'applied'`, id)!;
  return { wins: r.wins, losses: r.losses, adopted: !!r.adopted };
}

/** A materialized skill keeps the verdict of the proposal that created it visible on its page. */
export function skillDisplayTally(app: App, name: string) {
  const tally = skillTally(app, `skill:${name}`);
  for (const p of all<{ id: string }>(app.db, "select id from profile_proposals where kind = 'skill' and status = 'applied' and json_extract(body, '$.name') = ?", name)) {
    const t = skillTally(app, `proposal:${p.id}`);
    tally.wins += t.wins;
    tally.losses += t.losses;
    tally.adopted ||= t.adopted;
  }
  return tally;
}

export function skillTried(app: App, id: string, runId?: string) {
  return !!one(app.db, `select 1 from replays where axis = 'K1' and status != 'failed' and json_extract(variant, '$.candidateId') = ?${runId ? " and base_run_id = ?" : ""} limit 1`, id, ...(runId ? [runId] : []));
}

/** A candidate's name and description do not change between the questions of one night: embedded once. */
const vectors = new Map<string, Promise<number[] | null>>();
function vectorOf(app: App, text: string, spaceId: string) {
  const key = `${app.home}:${spaceId}:${embeddingId(app.config)}:${text}`;
  if (!vectors.has(key)) {
    if (vectors.size >= 200) vectors.clear();
    vectors.set(key, embedQuery(app, text, "query", [spaceId]).then((v) => (v ? [...v] : null)).catch(() => null));
  }
  return vectors.get(key)!;
}

/** Query vectors on both sides; if no model is available use the existing bigram measure. */
export async function fittingSkills(app: App, q: { question: string; spec: string | null; run: { id: string } }, candidates = skillCandidates(app)) {
  const eligible = candidates.filter((s) => (!s.owners.length || s.owners.includes(q.spec ?? "assistant")) && !skillTried(app, s.id, q.run.id));
  if (!eligible.length) return [];
  const spaceId = one<{space_id: string}>(app.db, "select space_id from runs where id=?", q.run.id)?.space_id ?? "personal";
  const vector = await embedQuery(app, q.question, "query", [spaceId]).catch(() => null);
  const out: (SkillCandidate & { score: number })[] = [];
  for (const s of eligible) {
    const text = `${s.name} ${s.description}`;
    const other = vector ? await vectorOf(app, text, spaceId) : null;
    let score: number;
    if (vector && other) {
      let dot = 0, a = 0, b = 0;
      for (let i = 0; i < vector.length; i++) { dot += vector[i] * (other[i] ?? 0); a += vector[i] ** 2; b += (other[i] ?? 0) ** 2; }
      score = a && b && vector.length === other.length ? dot / Math.sqrt(a * b) : 0;
    } else score = similarity(q.question, text);
    if (score >= (vector && other ? 0.5 : 0.2)) out.push({ ...s, score });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Called after recording helped/hurt. State transitions make repeated application silent. */
export function decideSkill(app: App, id: string, replayId: string, markAdopted: () => void) {
  const candidate = skillCandidates(app).find((s) => s.id === id);
  if (!candidate) return;
  const { wins, losses } = skillTally(app, id);
  const threshold = app.config.replay.skills.adoptAfter;
  if (threshold > 0 && wins >= threshold && wins > losses) {
    try {
      if (id.startsWith("skill:")) setSkillStatus(app, candidate.name, "active", "agent");
      else applyProposal(app, id.slice(9), `replay:${replayId}`);
    } catch (e) {
      // The replay itself is done and its verdict stands: the candidate just stays waiting for the owner.
      console.warn(`[omem] 复盘后启用技能「${candidate.name}」失败：${(e as Error).message}`);
      return;
    }
    markAdopted();
    notify(app, { title: `技能「${candidate.name}」复盘后自动启用`, body: `技能「${candidate.name}」在 ${wins} 次复盘里让回答变好，已经启用。不想要的话在 Agent 页的技能里停用。`, urgency: "later", link: "#/agents?tab=skills" });
  } else if (id.startsWith("proposal:") && losses >= 2 && wins === 0) {
    rejectProposal(app, id.slice(9), `replay:${replayId}`);
    run(app.db, "update profile_proposals set reason = reason || char(10) || ? where id = ?", "复盘里加上它两次都答得更差", id.slice(9));
  }
}
