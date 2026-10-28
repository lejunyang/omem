import type { PluginStore } from "../../src/plugins/types.ts";

/**
 * The learner model of the English plugin. Everything here is deterministic: the host keeps
 * the numbers, the tutor reads them (english_snapshot) and decides what to practise next.
 *
 * - attempts  one per answered question (key `<block>:<item>`), graded by the host or the tutor
 * - skills    one rating per skill, Elo-like: the question's level is its difficulty
 * - points    one per knowledge point (word:bill, phrase:to-go, grammar:present-perfect)
 */
export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export const SKILLS = ["vocab", "grammar", "listening", "translation", "reading"] as const;
export type Level = (typeof LEVELS)[number];
export type Skill = (typeof SKILLS)[number];

const DIFFICULTY: Record<Level, number> = { A1: 700, A2: 850, B1: 1000, B2: 1150, C1: 1300, C2: 1450 };
export const START_RATING = 1000;
/** A question counts as answered right from this score on (dictation, translation). */
export const PASS = 0.7;

export function levelOf(rating: number): Level {
  const i = Math.round((rating - DIFFICULTY.A1) / 150);
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, i))];
}

export function nextRating(rating: number, level: Level, score: number, k = 32) {
  const expected = 1 / (1 + 10 ** ((DIFFICULTY[level] - rating) / 400));
  return Math.round((rating + k * (score - expected)) * 10) / 10;
}

/** Compare typed answers: case, surrounding punctuation, curly quotes and extra spaces do not count. */
export function normalize(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-level accuracy of a dictation: 1 − word edit distance / words in the sentence. */
export function wordAccuracy(expected: string, given: string) {
  const a = normalize(expected).split(" ").filter(Boolean);
  const b = normalize(given).split(" ").filter(Boolean);
  if (!a.length) return b.length ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.max(0, Math.round((1 - prev[b.length] / a.length) * 100) / 100);
}

export type Attempt = {
  block: string;
  item: string;
  type: string;
  skill: Skill;
  level: Level;
  points: string[];
  prompt: string;
  given: string;
  expected: string;
  /** null while the tutor has not graded it yet. */
  score: number | null;
  correct: boolean | null;
  errorTags: string[];
  feedback: string;
  at: string;
};
export type SkillState = { rating: number; attempts: number; lastAt: string };
export type PointState = { seen: number; correct: number; streak: number; lastScore: number; lastCorrect: boolean; lastAt: string; errors: Record<string, number> };

/** Fold one graded attempt into the skill rating and its knowledge points. */
export function applyAttempt(store: PluginStore, a: Attempt) {
  if (a.score === null) return;
  const s = store.get<SkillState>("skills", a.skill) ?? { rating: START_RATING, attempts: 0, lastAt: a.at };
  store.put("skills", a.skill, { rating: nextRating(s.rating, a.level, a.score), attempts: s.attempts + 1, lastAt: a.at });
  for (const point of a.points) {
    const p = store.get<PointState>("points", point) ?? { seen: 0, correct: 0, streak: 0, lastScore: 0, lastCorrect: false, lastAt: a.at, errors: {} };
    // The question's own verdict (a dictation needs 0.9), falling back to the pass line.
    const ok = a.correct ?? a.score >= PASS;
    const errors = { ...p.errors };
    for (const t of a.errorTags) errors[t] = (errors[t] ?? 0) + 1;
    store.put("points", point, { seen: p.seen + 1, correct: p.correct + (ok ? 1 : 0), streak: ok ? p.streak + 1 : 0, lastScore: a.score, lastCorrect: ok, lastAt: a.at, errors });
  }
}

const DAY = 86400_000;
const localDate = (at: string | number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const rate = (xs: Attempt[]) => (xs.length ? Math.round((xs.filter((x) => x.correct).length / xs.length) * 100) / 100 : null);

/** What the tutor plans from and the page draws: levels, trend, weak and due points, recent errors. */
export function snapshot(store: PluginStore, at = Date.now()) {
  const attempts = store.list<Attempt>("attempts", { since: new Date(at - 30 * DAY).toISOString(), limit: 5000 }).map((r) => r.data).filter((a) => a.score !== null);
  const week = new Date(at - 7 * DAY).toISOString();
  const skills = SKILLS.map((skill) => {
    const s = store.get<SkillState>("skills", skill);
    const mine = attempts.filter((a) => a.skill === skill);
    return {
      skill,
      rating: s?.rating ?? START_RATING,
      level: levelOf(s?.rating ?? START_RATING),
      attempts: s?.attempts ?? 0,
      last7: rate(mine.filter((a) => a.at >= week)),
      before: rate(mine.filter((a) => a.at < week)),
    };
  });
  const points = store.list<PointState>("points", { limit: 5000 });
  const weak = points
    .filter((p) => (p.data.seen >= 2 && p.data.correct / p.data.seen < 0.6) || !p.data.lastCorrect)
    .map((p) => ({ point: p.key, seen: p.data.seen, accuracy: Math.round((p.data.correct / p.data.seen) * 100) / 100, lastScore: p.data.lastScore, lastAt: p.data.lastAt, errors: p.data.errors }))
    .sort((a, b) => a.accuracy - b.accuracy || b.lastAt.localeCompare(a.lastAt))
    .slice(0, 15);
  // Answered right a few times in a row, then not seen for a while (1, 2, 4 … days, at most 30).
  const due = points
    .filter((p) => p.data.streak >= 1 && p.data.lastCorrect && at - Date.parse(p.data.lastAt) >= Math.min(30, 2 ** (p.data.streak - 1)) * DAY)
    .map((p) => ({ point: p.key, streak: p.data.streak, lastAt: p.data.lastAt }))
    .sort((a, b) => a.lastAt.localeCompare(b.lastAt))
    .slice(0, 15);
  const errorCount = new Map<string, number>();
  for (const a of attempts) for (const t of a.errorTags) errorCount.set(t, (errorCount.get(t) ?? 0) + 1);
  const bank = new Map<string, number>();
  for (const e of store.list<BankEntry>("bank", { limit: 5000 })) bank.set(e.data.scene || "", (bank.get(e.data.scene || "") ?? 0) + 1);
  const daily = Array.from({ length: 14 }, (_, i) => {
    const date = localDate(at - (13 - i) * DAY);
    const mine = attempts.filter((a) => localDate(a.at) === date);
    return { date, count: mine.length, accuracy: rate(mine) };
  });
  return {
    total: store.count("attempts"),
    today: daily[daily.length - 1].count,
    skills,
    weak,
    due,
    errors: [...errorCount].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    daily,
    bank: { total: [...bank.values()].reduce((a, b) => a + b, 0), scenes: [...bank].map(([scene, count]) => ({ scene, count })).sort((a, b) => b.count - a.count) },
  };
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

const bankText = (s: ReturnType<typeof snapshot>) =>
  `题库：${s.bank.total ? `共 ${s.bank.total} 题（${s.bank.scenes.map((x) => `${x.scene || "不限场景"} ${x.count}`).join("、")}）` : "空"}`;

export function snapshotText(s: ReturnType<typeof snapshot>) {
  if (!s.total) return `还没有作答记录：第一次练习。先出一组覆盖词汇、语法、听力、翻译的摸底题（A2–B2 都有），根据结果再定方向。\n${bankText(s)}`;
  const lines = [
    `作答 ${s.total} 题，今天 ${s.today} 题。`,
    "技能水平（分数 / 等级 / 已答题数 / 近 7 天正确率 / 之前）：",
    ...s.skills.map((k) => `- ${k.skill}：${k.rating} / ${k.level} / ${k.attempts} / ${pct(k.last7)} / ${pct(k.before)}`),
    `薄弱知识点：${s.weak.length ? s.weak.map((w) => `${w.point}（${w.seen} 次，正确率 ${pct(w.accuracy)}${Object.keys(w.errors).length ? `，错误：${Object.keys(w.errors).join("、")}` : ""}）`).join("；") : "暂无"}`,
    `该复习的知识点：${s.due.length ? s.due.map((d) => d.point).join("、") : "暂无"}`,
    `近 30 天常见错误：${s.errors.length ? s.errors.map((e) => `${e.tag} ${e.count}`).join("、") : "暂无"}`,
    `近 14 天每天题数：${s.daily.map((d) => d.count).join(" ")}`,
    bankText(s),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- question bank

/** A question the tutor wrote ahead of time; drawn into a set when the owner wants the next one. */
export type BankEntry = { item: Record<string, unknown> & { type: string; skill: Skill; level: Level; points: string[] }; scene: string; addedAt: string };

const TYPE_ORDER = ["choice", "cloze", "dictation", "translate"];

/**
 * Pick the next set from the bank, deterministically: questions on weak points first, then points
 * due for review, then the asked scene, at about the owner's level (the same or one above); no
 * more than half of one type (a quarter for translations, which wait for the tutor's grading) and
 * one question per point where possible. Null when the bank cannot
 * make a set (too few questions, or too few for the scene: then the tutor writes it).
 */
export function pickFromBank(entries: { key: string; data: BankEntry }[], snap: ReturnType<typeof snapshot>, opts: { size: number; scene?: string }) {
  if (entries.length < opts.size) return null;
  const scene = opts.scene?.trim() || "";
  if (scene && entries.filter((e) => e.data.scene === scene).length < Math.ceil(opts.size / 2)) return null;
  const weak = new Set(snap.weak.map((w) => w.point));
  const due = new Set(snap.due.map((d) => d.point));
  const level = new Map(snap.skills.filter((k) => k.attempts > 0).map((k) => [k.skill, LEVELS.indexOf(k.level)]));
  const score = (e: BankEntry) => {
    let s = 0;
    if (e.item.points.some((p) => weak.has(p))) s += 3;
    if (e.item.points.some((p) => due.has(p))) s += 2;
    if (scene && e.scene === scene) s += 2;
    const mine = level.get(e.item.skill);
    if (mine !== undefined) {
      const gap = LEVELS.indexOf(e.item.level) - mine;
      s += gap === 0 || gap === 1 ? 1 : gap < 0 ? -1 : 0;
    }
    return s;
  };
  const ranked = [...entries].sort((a, b) => score(b.data) - score(a.data) || a.data.addedAt.localeCompare(b.data.addedAt));
  const cap = (type: string) => Math.ceil(opts.size / (type === "translate" ? 4 : 2));
  const picked: typeof entries = [];
  const types = new Map<string, number>();
  const seen = new Set<string>();
  for (const strict of [true, false]) {
    for (const e of ranked) {
      if (picked.length >= opts.size) break;
      if (picked.includes(e)) continue;
      const t = e.data.item.type;
      if (strict && ((types.get(t) ?? 0) >= cap(t) || e.data.item.points.some((p) => seen.has(p)))) continue;
      picked.push(e);
      types.set(t, (types.get(t) ?? 0) + 1);
      for (const p of e.data.item.points) seen.add(p);
    }
  }
  return picked.sort((a, b) => TYPE_ORDER.indexOf(a.data.item.type) - TYPE_ORDER.indexOf(b.data.item.type));
}
