import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { embedQuery } from "../search/embeddings.ts";
import { getMemory, type Memory } from "./store.ts";

/**
 * Passive recall: before a chat turn, memories close enough to the new message are put in front
 * of the agent so it does not have to think of calling `recall` first. Only a gate on the cosine
 * score decides — below the threshold nothing is added, so an unrelated message costs no tokens.
 * Preferences and experience are left out: every run already gets them (runner.learnedContext).
 * Needs memory vectors (embeddings on); without them it returns nothing.
 */
export type PassiveHit = { memory: Memory; score: number };

export async function passiveRecall(
  app: App,
  input: { text: string; spaces: string[] | null; userId: string; spec?: string | null; exclude?: Set<string>; threshold?: number; limit?: number },
): Promise<PassiveHit[]> {
  const cfg = app.config.memory.passive;
  if (!cfg.enabled) return [];
  const text = input.text.trim();
  if (text.length < 4) return [];
  const q = await embedQuery(app, text);
  if (!q) return [];
  const threshold = input.threshold ?? cfg.threshold;
  const where = ["status = 'active'", "embedding is not null", "kind not in ('preference', 'experience')", "(agent is null or agent = ?)", "(user_id is null or user_id = ?)"];
  const params: (string | number)[] = [input.spec ?? "", input.userId];
  if (input.spaces) {
    if (!input.spaces.length) return [];
    where.push(`space_id in (${input.spaces.map(() => "?").join(",")})`);
    params.push(...input.spaces);
  }
  const rows = all<{ id: string; embedding: Uint8Array }>(app.db, `select id, embedding from memories where ${where.join(" and ")}`, ...params);
  const scored: { id: string; score: number }[] = [];
  for (const r of rows) {
    if (input.exclude?.has(r.id)) continue;
    const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    if (v.length !== q.length) continue;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    if (s >= threshold) scored.push({ id: r.id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, input.limit ?? cfg.limit).map((h) => ({ memory: getMemory(app, h.id), score: h.score }));
}

/** The block a chat turn carries; empty when nothing passed the gate. */
export function passiveBlock(hits: PassiveHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map(({ memory: m }) => `- mem:${m.id} [${m.kind}] ${m.subject ? m.subject + "：" : ""}${m.content}（${m.validFrom?.slice(0, 10) ?? "?"} 起）`);
  return `## 可能相关的记忆\n\n按这条消息自动找到的，只供参考：不相关就忽略，不要为了用上而提起；用到时照常写 mem:<id>，要核实或找更多用 recall。\n\n${lines.join("\n")}`;
}
