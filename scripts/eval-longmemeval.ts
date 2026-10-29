/**
 * LongMemEval (cleaned, _s variant) on omem: each question's chat history is
 * stored as sources in its own space, then the assistant role answers using
 * omem tools. A judge model grades against the reference answer.
 *
 *   node scripts/eval-longmemeval.ts <longmemeval_s_cleaned.json> [--per-type 4] [--types a,b] [--profile id]
 *        [--judge-model haiku] [--home DIR] [--concurrency 3] [--out results.jsonl]
 *
 * This measures "retrieve and reason over raw history with tools" (no
 * pre-ingestion into memories). Use a cheap model for smoke runs; report the
 * model when quoting numbers.
 *
 * Session-level retrieval only, no model (cheap; run it first):
 *
 *   node scripts/eval-longmemeval.ts <file.json> --recall [--per-type 1000] [--vector] [--home DIR]
 *
 * ranks each question's sessions with omem's search (one hit per session) and reports Recall@5/@10
 * (share of the evidence sessions `answer_session_ids` in the top k), All@10 (every evidence session
 * in the top 10) and NDCG@10, overall and by type; abstention questions (`_abs`) have no evidence and
 * are skipped. LoCoMo converted by scripts/bench/fetch.ts has the same shape.
 */
process.removeAllListeners("warning");
const { readFileSync, appendFileSync, existsSync } = await import("node:fs");
const { join } = await import("node:path");
const { spawn } = await import("node:child_process");
const { boot } = await import("../src/main.ts");
const { createSpace, findSpace } = await import("../src/core/spaces.ts");
const { upsertSource } = await import("../src/sources/store.ts");
const { runRole } = await import("../src/agents/runner.ts");

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const dataPath = args[0];
const perType = Number(opt("--per-type", "4"));
const types = opt("--types", "knowledge-update,temporal-reasoning,multi-session,single-session-user,single-session-preference,single-session-assistant").split(",");
const profileId = opt("--profile", "");
const judgeModel = opt("--judge-model", "haiku");
const home = opt("--home", join(process.cwd(), ".scratch", "eval-lme"));
const concurrency = Number(opt("--concurrency", "3"));
const out = opt("--out", join(home, "results.jsonl"));

type Q = { question_id: string; question_type: string; question: string; question_date: string; answer: string; haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: { role: string; content: string }[][]; answer_session_ids?: string[]; /** Questions sharing one history (LoCoMo) share a space. */ haystack_key?: string };
const data = JSON.parse(readFileSync(dataPath, "utf8")) as Q[];
const recallMode = args.includes("--recall");
// --types all: every type in the file (LoCoMo's categories differ from LongMemEval's).
const typeList = opt("--types", "") === "all" || (recallMode && !args.includes("--types")) ? [...new Set(data.map((q) => q.question_type))] : types;
const picked = typeList.flatMap((t) => data.filter((q) => q.question_type === t).slice(0, recallMode && !args.includes("--per-type") ? Infinity : perType));
const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);

if (recallMode) {
  await sessionRecall();
  process.exit(0);
}

const { app, server } = await boot(home, { port: 0, quiet: true, background: false });

/** Session-level Recall@k with omem's search, no model. */
async function sessionRecall() {
  const { App } = await import("../src/core/app.ts");
  const { search } = await import("../src/search/search.ts");
  const { embedPending } = await import("../src/search/embeddings.ts");
  const { all } = await import("../src/core/db.ts");
  const vector = args.includes("--vector");
  const recallHome = opt("--home", join(process.cwd(), ".scratch", vector ? "eval-lme-recall-vector" : "eval-lme-recall"));
  const lib = App.open(recallHome);
  lib.config.embeddings.provider = vector ? "local" : "none";
  const qs = picked.filter((q) => !q.question_id.endsWith("_abs") && q.answer_session_ids?.length);
  const t0 = Date.now();
  for (const q of qs) loadInto(lib, q);
  console.error(`loaded ${qs.length} questions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (vector) for (let n = await embedPending(lib, 64); n; n = await embedPending(lib, 64));
  const sessionOf = new Map(all<{ id: string; uri: string }>(lib.db, "select id, uri from sources").map((r) => [r.id, r.uri.replace(/^session-|\.md$/g, "")]));
  const dcg = (rel: boolean[]) => rel.reduce((s, r, i) => s + (r ? 1 / Math.log2(i + 2) : 0), 0);
  type Acc = { n: number; r5: number; r10: number; all10: number; ndcg: number };
  const zero = (): Acc => ({ n: 0, r5: 0, r10: 0, all10: 0, ndcg: 0 });
  const total = zero();
  const byType = new Map<string, Acc>();
  let ms = 0;
  for (const q of qs) {
    const t = performance.now();
    const hits = await search(lib, q.question, { spaces: [spaceOf(q)], types: ["chunk"], limit: 50, perSource: 1 });
    ms += performance.now() - t;
    const ranked = hits.map((h) => sessionOf.get(h.sourceId!)).filter((x): x is string => !!x);
    const gold = new Set(q.answer_session_ids!.map(String));
    const top = (k: number) => ranked.slice(0, k).filter((s) => gold.has(s)).length;
    const ideal = dcg([...gold].slice(0, 10).map(() => true));
    const acc = byType.get(q.question_type) ?? zero();
    byType.set(q.question_type, acc);
    for (const a of [acc, total]) {
      a.n++;
      a.r5 += top(5) / gold.size;
      a.r10 += top(10) / gold.size;
      a.all10 += top(10) === gold.size ? 1 : 0;
      a.ndcg += dcg(ranked.slice(0, 10).map((s) => gold.has(s))) / (ideal || 1);
    }
  }
  const fmt = (a: Acc) => ({ n: a.n, "Recall@5": +((100 * a.r5) / a.n).toFixed(2), "Recall@10": +((100 * a.r10) / a.n).toFixed(2), "All@10": +((100 * a.all10) / a.n).toFixed(2), "NDCG@10": +((100 * a.ndcg) / a.n).toFixed(2) });
  console.log(JSON.stringify({ data: dataPath.split(/[\\/]/).pop(), mode: vector ? "fts+vector (RRF)" : "fts", ...fmt(total), avgMs: +(ms / Math.max(1, qs.length)).toFixed(1), byType: Object.fromEntries([...byType].map(([k, v]) => [k, fmt(v)])) }, null, 1));
}

function spaceOf(q: Q) {
  return `lme-${(q.haystack_key ?? q.question_id).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** One space per question; one chat source per history session (uri session-<id>.md). */
function loadInto(target: import("../src/core/app.ts").App, q: Q) {
  const spaceId = spaceOf(q);
  if (findSpace(target, spaceId)) return spaceId;
  createSpace(target, { id: spaceId, name: spaceId, kind: "personal" });
  q.haystack_sessions.forEach((session, i) => {
    const date = q.haystack_dates[i];
    const text = `# Chat session ${date}\n\n` + session.map((t) => `**${t.role}** (${date}): ${t.content}`).join("\n\n");
    upsertSource(target, { spaceId, kind: "chat", uri: `session-${q.haystack_session_ids[i]}.md`, title: `Chat ${date}`, text, meta: { date } });
  });
  return spaceId;
}

function load(q: Q) {
  return loadInto(app, q);
}

async function judge(q: Q, response: string): Promise<{ ok: boolean; raw: string }> {
  const abstention = q.question_id.endsWith("_abs");
  const prompt = abstention
    ? `I will give you an unanswerable question, an explanation, and a response from a model. Answer "yes" if the model correctly identifies the question as unanswerable (says it lacks the information), otherwise "no".\n\nQuestion: ${q.question}\nExplanation: ${q.answer}\nModel Response: ${response}\n\nAnswer yes or no only.`
    : `I will give you a question, a correct answer, and a response from a model. Answer "yes" if the response contains the correct answer or is equivalent to it (it may be in another language, add details, or show steps). If the response only contains a subset of the needed information, answer "no".${q.question_type === "temporal-reasoning" ? " Do not penalize off-by-one errors in the number of days." : ""}${q.question_type === "knowledge-update" ? " If the response mentions old information together with the correct updated answer, it is correct." : ""}${q.question_type === "single-session-preference" ? " The answer is a rubric of the user's preference; answer yes if the response satisfies it." : ""}\n\nQuestion: ${q.question}\nCorrect Answer: ${q.answer}\nModel Response: ${response}\n\nAnswer yes or no only.`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await new Promise<string>((resolve) => {
      const child = spawn("claude", ["-p", "--model", judgeModel, "--no-session-persistence"], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out.trim());
      });
      child.stdin.end(prompt);
    });
    if (/\b(yes|no)\b/i.test(raw)) return { ok: /^\W*yes\b/i.test(raw), raw: raw.slice(0, 200) };
  }
  return { ok: false, raw: "JUDGE_FAILED" };
}

async function solve(q: Q) {
  const spaceId = load(q);
  const started = Date.now();
  let answer = "";
  let error = "";
  try {
    const r = await runRole(app, {
      role: "assistant",
      spaceId,
      spaces: [spaceId],
      runId: null,
      profileId: profileId || undefined,
      task: `## 本人刚发来的消息\n\n${q.question}\n\n（提问时间：${q.question_date}。“我”指本人；资料是本人和助手过去的聊天记录，按需检索。直接给出答案，资料里没有就明确说不知道。）`,
    });
    answer = r.text.trim();
  } catch (e) {
    error = (e as Error).message;
  }
  const verdict = error ? { ok: false, raw: "" } : await judge(q, answer);
  const correct = verdict.ok;
  const row = { id: q.question_id, type: q.question_type, correct, judge: verdict.raw, seconds: Math.round((Date.now() - started) / 1000), question: q.question, gold: q.answer, answer: answer.slice(0, 2000), error };
  appendFileSync(out, JSON.stringify(row) + "\n");
  console.error(`${correct ? "✓" : "✗"} [${q.question_type}] ${q.question.slice(0, 70)}  (${row.seconds}s)${error ? " ERR " + error.slice(0, 80) : ""}`);
}

if (args.includes("--rejudge") && existsSync(out)) {
  const { writeFileSync } = await import("node:fs");
  const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map(data.map((q) => [q.question_id, q]));
  for (const r of rows) if (!r.error) Object.assign(r, await judge(byId.get(r.id)!, r.answer).then((v) => ({ correct: v.ok, judge: v.raw })));
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const queue = args.includes("--rejudge") ? [] : picked.filter((q) => !done.has(q.question_id));
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) await solve(q);
  }),
);
await server.close();

const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; correct: boolean });
const byType = new Map<string, { n: number; ok: number }>();
for (const r of rows) {
  const t = byType.get(r.type) ?? { n: 0, ok: 0 };
  t.n++;
  t.ok += r.correct ? 1 : 0;
  byType.set(r.type, t);
}
const total = rows.filter((r) => r.correct).length;
console.log(JSON.stringify({ total: rows.length, accuracy: ((100 * total) / rows.length).toFixed(1), byType: Object.fromEntries([...byType].map(([k, v]) => [k, `${v.ok}/${v.n}`])) }, null, 1));
