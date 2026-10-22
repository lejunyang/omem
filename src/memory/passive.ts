import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { embedQuery } from "../search/embeddings.ts";
import { similarity } from "./quality.ts";
import { getMemory, type Memory } from "./store.ts";

/**
 * Memories close to a piece of text, by cosine on memory vectors (needs embeddings; empty without).
 * Used three ways: passive recall before a chat turn, the existing memories handed to ingest with
 * new material, and the near-neighbour check before `remember` writes.
 */
export type PassiveHit = { memory: Memory; score: number };

type NearInput = {
  text: string;
  spaces: string[] | null;
  threshold: number;
  limit: number;
  /** Whose memories count: personal ones of this user and shared ones (null = any user). */
  userId?: string | null;
  /** Shared memories plus this profile's own (undefined = all profiles' memories). */
  spec?: string | null;
  /** Leave out preferences and experience (every run already carries them). */
  factsOnly?: boolean;
  exclude?: Set<string>;
  kind?: "query" | "passage";
};

export async function nearMemories(app: App, input: NearInput): Promise<PassiveHit[]> {
  const text = input.text.trim();
  if (text.length < 4) return [];
  if (input.spaces && !input.spaces.length) return [];
  const q = await embedQuery(app, text, input.kind ?? "query");
  if (!q) return [];
  const where = ["status = 'active'", "embedding is not null"];
  const params: (string | number)[] = [];
  if (input.factsOnly) where.push("kind not in ('preference', 'experience')");
  if (input.spec !== undefined) where.push("(agent is null or agent = ?)") && params.push(input.spec ?? "");
  if (input.userId) where.push("(user_id is null or user_id = ?)") && params.push(input.userId);
  if (input.spaces) where.push(`space_id in (${input.spaces.map(() => "?").join(",")})`) && params.push(...input.spaces);
  const rows = all<{ id: string; embedding: Uint8Array }>(app.db, `select id, embedding from memories where ${where.join(" and ")}`, ...params);
  const scored: { id: string; score: number }[] = [];
  for (const r of rows) {
    if (input.exclude?.has(r.id)) continue;
    const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    if (v.length !== q.length) continue;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    if (s >= input.threshold) scored.push({ id: r.id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, input.limit).map((h) => ({ memory: getMemory(app, h.id), score: h.score }));
}

/**
 * Passive recall: before a chat turn, memories close enough to the new message are put in front
 * of the agent so it does not have to think of calling `recall` first. Only a gate on the cosine
 * score decides — below the threshold nothing is added, so an unrelated message costs no tokens.
 * Preferences and experience are left out: every run already gets them (runner.learnedContext).
 */
export async function passiveRecall(
  app: App,
  input: { text: string; spaces: string[] | null; userId: string; spec?: string | null; exclude?: Set<string>; threshold?: number; limit?: number },
): Promise<PassiveHit[]> {
  const cfg = app.config.memory.passive;
  if (!cfg.enabled) return [];
  return nearMemories(app, { ...input, spec: input.spec ?? null, factsOnly: true, threshold: input.threshold ?? cfg.threshold, limit: input.limit ?? cfg.limit });
}

/** The block a chat turn carries; empty when nothing passed the gate. */
export function passiveBlock(hits: PassiveHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map(({ memory: m }) => `- mem:${m.id} [${m.kind}] ${m.subject ? m.subject + "：" : ""}${m.content}（${m.validFrom?.slice(0, 10) ?? "?"} 起）`);
  return `## 可能相关的记忆\n\n按这条消息自动找到的，只供参考：不相关就忽略，不要为了用上而提起；用到时照常写 mem:<id>，要核实或找更多用 recall。\n\n${lines.join("\n")}`;
}

/** Cosine between two memories' vectors above which they are probably about the same thing (bge-small-zh, see docs/v2/evaluation.md). */
export const SAME_TOPIC = 0.75;

/**
 * Pairs of active memories in the same space whose vectors say they are probably about the same
 * thing, at least one of them among `ids` (memories that changed since the last tidy-up).
 */
export function sameTopicPairs(app: App, ids: string[], limit = 30): { a: Memory; b: Memory; score: number }[] {
  if (!ids.length) return [];
  const rows = all<{ id: string; space_id: string; agent: string | null; embedding: Uint8Array }>(app.db, "select id, space_id, agent, embedding from memories where status = 'active' and embedding is not null");
  const vec = (r: (typeof rows)[number]) => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
  const changed = new Set(ids);
  const pairs: { a: string; b: string; score: number }[] = [];
  for (const x of rows) {
    if (!changed.has(x.id)) continue;
    const vx = vec(x);
    for (const y of rows) {
      if (y.id === x.id || y.space_id !== x.space_id || (y.agent ?? "") !== (x.agent ?? "") || (changed.has(y.id) && y.id < x.id)) continue;
      const vy = vec(y);
      if (vy.length !== vx.length) continue;
      let s = 0;
      for (let i = 0; i < vx.length; i++) s += vx[i] * vy[i];
      if (s >= SAME_TOPIC) pairs.push({ a: x.id, b: y.id, score: s });
    }
  }
  return pairs
    .sort((p, q) => q.score - p.score)
    .slice(0, limit)
    .map((p) => ({ a: getMemory(app, p.a), b: getMemory(app, p.b), score: p.score }));
}

const normSubject =(s: string) => s.replace(/[\s·・\-_:：]/g, "").toLowerCase();

/**
 * Existing memories a new one may restate or correct: same space, close vector (or, without
 * vectors, the same subject or many shared bigrams). Exact duplicates are refused earlier by the
 * write checks; these are the near ones the writer should look at and decide about.
 */
export async function memoriesNearWrite(app: App, input: { spaceId: string; content: string; subject?: string; agent?: string | null; replacing?: string }): Promise<Memory[]> {
  const text = input.subject ? `${input.subject}：${input.content}` : input.content;
  const byVector = await nearMemories(app, { text, spaces: [input.spaceId], threshold: SAME_TOPIC, limit: 5, spec: input.agent ?? null, kind: "passage", exclude: input.replacing ? new Set([input.replacing]) : undefined });
  const found = new Map(byVector.map((h) => [h.memory.id, h.memory]));
  const subject = input.subject ? normSubject(input.subject) : "";
  const rows = all<{ id: string; subject: string; content: string }>(
    app.db,
    "select id, subject, content from memories where space_id = ? and status = 'active' and (agent is null or agent = ?) order by updated_at desc limit 2000",
    input.spaceId,
    input.agent ?? "",
  );
  for (const r of rows) {
    if (found.size >= 5) break;
    if (r.id === input.replacing || found.has(r.id)) continue;
    if ((subject && normSubject(r.subject) === subject) || (!byVector.length && similarity(input.content, r.content) >= 0.3)) found.set(r.id, getMemory(app, r.id));
  }
  return [...found.values()];
}
