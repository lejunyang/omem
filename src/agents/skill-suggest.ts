import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { OWNER, personalSpaceId } from "../core/users.ts";
import { embeddingId } from "../search/embedding-index.ts";
import { embedQuery, embedTexts } from "../search/embeddings.ts";
import { groupOf, loadSkillGroups, skillEnabled } from "./skill-groups.ts";
import { listSkills, skillUsable } from "./specs.ts";

/**
 * Skills close to what a turn or a task is about, put in front of the agent with their descriptions
 * (as passive recall does with memories). With this on and vectors there, a run's standing
 * instructions list the other skills by name only (specs.ts skillIndex `compact`), and a message that
 * has nothing to do with any skill carries none of their descriptions.
 *
 * Each skill's `name：description` is embedded once and kept in `<home>/cache/skill-vectors.json` by
 * the hash of that text, per embedding model. Vectors are made in the background: until every skill
 * has one, `skillSuggestReady` is false and runs get the full directory as before.
 */
type State = { model: string; vectors: Map<string, Float32Array>; building: Promise<void> | null; retryAt: number };
const states = new WeakMap<App, State>();

const file = (app: App) => join(app.home, "cache", "skill-vectors.json");
const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");
const textOf = (s: { name: string; description: string }) => `${s.name}：${s.description}`;

type Candidate = { name: string; description: string; group?: string; hash: string };

function candidates(app: App, outside?: ReadonlySet<string>): Candidate[] {
  const groups = loadSkillGroups(app, outside);
  return listSkills(app, { exclude: outside })
    .filter((s) => skillUsable(app, s) && skillEnabled(groups, s.name))
    .map((s) => ({ name: s.name, description: s.description, group: groupOf(groups, s.name), hash: hashOf(textOf(s)) }));
}

function stateOf(app: App, model: string): State {
  let st = states.get(app);
  if (st && st.model === model) return st;
  st = { model, vectors: new Map(), building: null, retryAt: 0 };
  try {
    const raw = JSON.parse(readFileSync(file(app), "utf8")) as { model?: string; vectors?: Record<string, string> };
    if (raw.model === model) {
      for (const [hash, b64] of Object.entries(raw.vectors ?? {})) {
        const buf = Buffer.from(b64, "base64");
        st.vectors.set(hash, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice());
      }
    }
  } catch {}
  states.set(app, st);
  return st;
}

function build(app: App, st: State, list: Candidate[]) {
  return (st.building ??= embedMissing(app, st, list).finally(() => (st.building = null)));
}

async function embedMissing(app: App, st: State, list: Candidate[]) {
  try {
    const missing = list.filter((c) => !st.vectors.has(c.hash));
    // Skills are the owner's library: a plugin's vector provider sees them only when it may see the owner's own space.
    const rows = missing.length ? await embedTexts(app, missing.map(textOf), "passage", [personalSpaceId(OWNER)]) : [];
    if (!rows) {
      st.retryAt = Date.now() + 10 * 60_000;
      return;
    }
    missing.forEach((c, i) => st.vectors.set(c.hash, rows[i]));
    const current = new Set(list.map((c) => c.hash));
    for (const hash of [...st.vectors.keys()]) if (!current.has(hash)) st.vectors.delete(hash);
    mkdirSync(join(app.home, "cache"), { recursive: true });
    writeFileSync(file(app), JSON.stringify({ model: st.model, vectors: Object.fromEntries([...st.vectors].map(([hash, v]) => [hash, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64")])) }));
  } catch (e) {
    st.retryAt = Date.now() + 10 * 60_000;
    console.warn("[omem] 给技能说明算向量失败：", (e as Error).message);
  }
}

/** Starts (or waits for) the vectors of every skill; tests and the first start wait for it. */
export async function prepareSkillVectors(app: App): Promise<boolean> {
  const model = app.config.agents.skillSuggest.enabled ? embeddingId(app.config) : null;
  if (!model) return false;
  const st = stateOf(app, model);
  // A build already under way may have started before the newest skill was saved: wait for it, then make what is still missing.
  if (st.building) await st.building;
  const list = candidates(app);
  if (list.some((c) => !st.vectors.has(c.hash))) await build(app, st, list);
  return list.every((c) => st.vectors.has(c.hash));
}

/**
 * Whether a run starting now can rely on suggestions: the setting is on, there is a vector model and
 * every skill has its vector. Otherwise the missing vectors are made in the background for later runs.
 */
export function skillSuggestReady(app: App): boolean {
  const model = app.config.agents.skillSuggest.enabled ? embeddingId(app.config) : null;
  if (!model) return false;
  const st = stateOf(app, model);
  const list = candidates(app);
  if (!list.length) return false;
  if (list.every((c) => st.vectors.has(c.hash))) return true;
  if (!st.building && Date.now() >= st.retryAt) void build(app, st, list);
  return false;
}

export type SkillHit = { name: string; description: string; group?: string; score: number };

/**
 * The skills closest to `text`, at most `agents.skillSuggest.limit`, each at or above its threshold;
 * empty when nothing is close (an unrelated message costs nothing). `exclude`: skills the run was
 * already told about with their descriptions, or suggested earlier in the same session.
 */
export async function suggestSkills(app: App, input: { text: string; sourceSpace: string; exclude?: ReadonlySet<string>; outside?: ReadonlySet<string> }): Promise<SkillHit[]> {
  const cfg = app.config.agents.skillSuggest;
  const model = cfg.enabled ? embeddingId(app.config) : null;
  const text = input.text.trim();
  if (!model || text.length < 4) return [];
  const st = stateOf(app, model);
  const list = candidates(app, input.outside).filter((c) => !input.exclude?.has(c.name) && st.vectors.has(c.hash));
  if (!list.length) return [];
  const q = await embedQuery(app, text, "query", undefined, [input.sourceSpace]);
  if (!q) return [];
  const hits: SkillHit[] = [];
  for (const c of list) {
    const v = st.vectors.get(c.hash)!;
    if (v.length !== q.length) continue;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    if (s >= cfg.threshold) hits.push({ name: c.name, description: c.description, group: c.group, score: s });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, cfg.limit);
}

/** The block a turn (or a task) carries; empty when nothing was close. */
export function skillBlock(hits: SkillHit[], about: "这条消息" | "这次任务" = "这条消息"): string {
  if (!hits.length) return "";
  const lines = hits.map((h) => `- ${h.name}${h.group ? `（分组 ${h.group}）` : ""}：${h.description}`);
  return `## 可能用得上的技能\n\n按${about}自动找到的，只供参考：不相关就忽略；要用就先 read_skill 读全文再照做。\n\n${lines.join("\n")}`;
}
