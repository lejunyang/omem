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

type Q = { question_id: string; question_type: string; question: string; question_date: string; answer: string; haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: { role: string; content: string }[][] };
const data = JSON.parse(readFileSync(dataPath, "utf8")) as Q[];
const picked = types.flatMap((t) => data.filter((q) => q.question_type === t).slice(0, perType));
const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);

const { app, server } = await boot(home, { port: 0, quiet: true, background: false });

function load(q: Q) {
  const spaceId = `lme-${q.question_id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (findSpace(app, spaceId)) return spaceId;
  createSpace(app, { id: spaceId, name: spaceId, kind: "personal" });
  q.haystack_sessions.forEach((session, i) => {
    const date = q.haystack_dates[i];
    const text = `# Chat session ${date}\n\n` + session.map((t) => `**${t.role}** (${date}): ${t.content}`).join("\n\n");
    upsertSource(app, { spaceId, kind: "chat", uri: `session-${q.haystack_session_ids[i]}.md`, title: `Chat ${date}`, text, meta: { date } });
  });
  return spaceId;
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
