import { z } from "zod";
import type { PluginApi, PluginContext } from "../../src/plugins/types.ts";
import { applyAttempt, LEVELS, normalize, PASS, SKILLS, snapshot, snapshotText, wordAccuracy, type Attempt } from "./learner.ts";

/**
 * English practice (docs/v2/plugins.md): the tutor hands in a batch of questions with
 * english_quiz, the owner answers all of them on the plugin page, the host grades what it can
 * (choice, cloze, dictation) and the tutor grades translations with english_grade.
 */
const audio = z.object({
  text: z.string().min(1).max(400).describe("要朗读的英文"),
  lang: z.enum(["en-US", "en-GB"]).default("en-US"),
  rate: z.number().min(0.5).max(1.5).default(1).describe("语速，1 为正常"),
});
const base = {
  id: z.string().max(20).optional().describe("题号，不填自动编"),
  skill: z.enum(SKILLS).describe("考哪项技能"),
  level: z.enum(LEVELS).describe("难度（CEFR）"),
  points: z.array(z.string().max(60)).max(6).default([]).describe("考的知识点：word:<词原形>、phrase:<短语>、grammar:<语法点>，小写英文"),
  explanation: z.string().max(500).optional().describe("提交后给本人看的解释"),
};
const item = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), prompt: z.string().min(1).max(500).describe("题干：中选英给中文，英选中给英文；听音选意可以只写“听录音，选出意思”"), audio: audio.optional(), options: z.array(z.string().min(1).max(200)).min(2).max(6), answer: z.number().int().min(0).describe("正确选项的下标（从 0 开始）"), ...base }),
  z.object({ type: z.literal("cloze"), text: z.string().min(1).max(500).describe("英文句子，空格处写 ___（三个下划线），只留一个空"), prompt: z.string().max(200).optional().describe("提示，如中文意思"), answer: z.array(z.string().min(1).max(80)).min(1).max(5).describe("可接受的答案"), ...base }),
  z.object({ type: z.literal("dictation"), audio, prompt: z.string().max(200).optional(), ...base }),
  z.object({ type: z.literal("translate"), direction: z.enum(["zh-en", "en-zh"]), prompt: z.string().min(1).max(500).describe("要翻译的句子"), reference: z.string().max(500).optional().describe("参考译文，提交后给本人看"), ...base }),
]);
const quiz = z.object({
  title: z.string().min(1).max(60).describe("这一组的标题，如“餐厅点餐 · 第 2 组”"),
  intro: z.string().max(500).optional().describe("开始前的一两句说明"),
  items: z.array(item).min(1).max(20),
});
type Quiz = z.infer<typeof quiz>;
type Item = Quiz["items"][number];

export type ItemResult = { id: string; correct: boolean | null; score: number | null; given: string; expected: string; explanation?: string; feedback?: string; pending: boolean };

const expectedOf = (it: Item) =>
  it.type === "choice" ? it.options[it.answer] : it.type === "cloze" ? it.answer.join(" / ") : it.type === "dictation" ? it.audio.text : it.reference ?? "";
const promptOf = (it: Item) => (it.type === "cloze" ? it.text : it.type === "dictation" ? "（听写）" : it.prompt);

function gradeItem(it: Item, raw: unknown): { given: string; score: number | null } {
  if (it.type === "choice") {
    const i = typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
    return { given: Number.isInteger(i) && it.options[i] !== undefined ? it.options[i] : "", score: i === it.answer ? 1 : 0 };
  }
  const given = typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
  if (it.type === "cloze") return { given, score: it.answer.some((a) => normalize(a) === normalize(given)) ? 1 : 0 };
  if (it.type === "dictation") return { given, score: given ? wordAccuracy(it.audio.text, given) : 0 };
  // An empty translation is simply wrong; anything else waits for the tutor.
  return { given, score: given ? null : 0 };
}

function grade(ctx: PluginContext & { blockId: string }, data: Quiz, answers: Record<string, unknown>) {
  const at = new Date().toISOString();
  const items: ItemResult[] = [];
  const lines: string[] = [];
  for (const it of data.items) {
    const { given, score } = gradeItem(it, answers[it.id!]);
    const correct = score === null ? null : it.type === "dictation" ? score >= 0.9 : score >= PASS;
    const attempt: Attempt = { block: ctx.blockId, item: it.id!, type: it.type, skill: it.skill, level: it.level, points: it.points, prompt: promptOf(it), given, expected: expectedOf(it), score, correct, errorTags: [], feedback: "", at };
    ctx.store.put("attempts", `${ctx.blockId}:${it.id}`, attempt);
    applyAttempt(ctx.store, attempt);
    items.push({ id: it.id!, correct, score, given, expected: expectedOf(it), explanation: it.explanation, pending: score === null });
    const mark = score === null ? "待你评分" : it.type === "dictation" ? `${Math.round(score * 100)}%${correct ? " ✓" : " ✗"}` : correct ? "✓" : "✗";
    const pts = it.points.length ? `（${it.points.join(", ")}）` : "";
    if (it.type === "translate") lines.push(`- ${it.id} 翻译 ${it.direction} ${it.level}${pts} ${mark}：原句“${it.prompt}”，本人“${given || "（没写）"}”${it.reference ? `，参考“${it.reference}”` : ""}`);
    else lines.push(`- ${it.id} ${it.type} ${it.level}${pts} ${mark}：${correct ? "" : `本人“${given || "（没答）"}”，答案“${expectedOf(it)}”`}`);
  }
  const graded = items.filter((i) => !i.pending);
  const pending = items.filter((i) => i.pending);
  const head = `【提交】${data.title}：${graded.length ? `判过分的 ${graded.length} 题对 ${graded.filter((i) => i.correct).length} 题` : "没有可自动判分的题"}${pending.length ? `，${pending.length} 题待你评分` : ""}。`;
  const tail = pending.length
    ? `先用 english_grade(block_id="${ctx.blockId}") 给待评的题打分并写点评，再总结这一组、出下一组。`
    : "点评这一组，再按需要出下一组。";
  return { result: { items, at }, message: [head, ...lines, "", tail].join("\n") };
}

export default function register(api: PluginApi) {
  api.block({
    kind: "quiz",
    description:
      "在练习页上交给本人一组英语题（1–20 题，通常 6–12 题），本人做完一次提交。题型：choice（中选英、英选中、听音选意，可带 audio）、cloze（句子填空）、dictation（听写，audio 是原句）、translate（句子翻译，由你评分）。每题标 skill、level、points。交出后这一轮只说一句开场白，不要在文字里重复题目。",
    schema: quiz,
    prepare: (q) => {
      const used = new Set<string>();
      const items = q.items.map((it, i) => {
        if (it.type === "choice" && it.answer >= it.options.length) throw new Error(`第 ${i + 1} 题的 answer 超出了选项范围（共 ${it.options.length} 个选项，下标从 0 开始）`);
        if (it.type === "cloze" && (it.text.match(/_{3,}/g) ?? []).length !== 1) throw new Error(`第 ${i + 1} 题（cloze）的 text 要有且只有一个 ___`);
        let id = it.id && !used.has(it.id) ? it.id : `q${i + 1}`;
        while (used.has(id)) id += "x";
        used.add(id);
        return { ...it, id, points: it.points.map((p) => p.trim().toLowerCase()).filter(Boolean) };
      });
      return { ...q, items };
    },
    publicView: (q) => ({
      title: q.title,
      intro: q.intro,
      items: q.items.map((it) => {
        const { explanation: _e, ...rest } = it;
        if (rest.type === "choice") {
          const { answer: _a, ...shown } = rest;
          return shown;
        }
        if (rest.type === "cloze") {
          const { answer: _a, ...shown } = rest;
          return shown;
        }
        if (rest.type === "translate") {
          const { reference: _r, ...shown } = rest;
          return shown;
        }
        return rest;
      }),
    }),
    grade,
    presented: (q, id) => `已在练习页上展示“${q.title}”（${q.items.length} 题，${id}）。本人提交后，判过分的结果会作为下一条消息到达；这一轮只说一句开场白，不要在文字里重复题目。`,
  });

  api.tool({
    name: "english_snapshot",
    description: "本人的英语学习画像：各技能的分数和等级、近 7 天与之前的正确率、薄弱知识点、该复习的知识点、常见错误类型、近 14 天的练习量。出题前先看它。",
    schema: z.object({ format: z.enum(["text", "json"]).default("text") }),
    page: true,
    handler: (ctx, a) => {
      const s = snapshot(ctx.store);
      return a.format === "json" ? JSON.stringify(s) : snapshotText(s);
    },
  });

  api.tool({
    name: "english_grade",
    description: "给一组题里待评分的题（翻译）打分，也可以给任何一题补一句点评。score 0–1（0.7 以上算对）；feedback 指出具体问题并给更自然的说法；error_tags 用小写英文短词归类错误（tense、article、preposition、word-choice、word-order、spelling、collocation、omission、meaning）。",
    schema: z.object({
      block_id: z.string(),
      grades: z
        .array(
          z.object({
            item_id: z.string(),
            score: z.number().min(0).max(1).optional().describe("待评分的题必填；已判过的题会忽略"),
            feedback: z.string().max(400).default(""),
            error_tags: z.array(z.string().max(30)).max(5).default([]),
          }),
        )
        .min(1),
    }),
    write: true,
    handler: (ctx, a) => {
      const block = ctx.block(a.block_id);
      if (!block || block.kind !== "quiz") return `没有这一组题：${a.block_id}`;
      if (block.status !== "submitted" || !block.result) return "这一组本人还没有提交";
      const result = block.result as { items: ItemResult[]; at: string };
      const done: string[] = [];
      const problems: string[] = [];
      for (const g of a.grades) {
        const r = result.items.find((i) => i.id === g.item_id);
        const attempt = ctx.store.get<Attempt>("attempts", `${a.block_id}:${g.item_id}`);
        if (!r || !attempt) {
          problems.push(`${g.item_id}：没有这题`);
          continue;
        }
        r.feedback = g.feedback || r.feedback;
        attempt.feedback = g.feedback || attempt.feedback;
        if (g.error_tags.length) attempt.errorTags = [...new Set([...attempt.errorTags, ...g.error_tags.map((t) => t.trim().toLowerCase())])];
        if (r.pending) {
          if (g.score === undefined) {
            problems.push(`${g.item_id}：待评分，需要 score`);
            ctx.store.put("attempts", `${a.block_id}:${g.item_id}`, attempt);
            continue;
          }
          r.score = attempt.score = g.score;
          r.correct = attempt.correct = g.score >= PASS;
          r.pending = false;
          ctx.store.put("attempts", `${a.block_id}:${g.item_id}`, attempt);
          applyAttempt(ctx.store, attempt);
        } else ctx.store.put("attempts", `${a.block_id}:${g.item_id}`, attempt);
        done.push(g.item_id);
      }
      ctx.setBlockResult(a.block_id, result);
      const left = result.items.filter((i) => i.pending).map((i) => i.id);
      return [`已记录 ${done.join("、") || "（无）"}。`, ...problems, left.length ? `还有待评分的：${left.join("、")}` : "这一组都评完了。"].join("\n");
    },
  });
}
