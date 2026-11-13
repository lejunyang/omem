import { z } from "zod";
import type { PluginApi, PluginContext } from "../../src/plugins/types.ts";
import { applyAttempt, applyPoint, applySpeaking, LEVELS, normalize, PASS, pickFromBank, SKILLS, snapshot, snapshotText, wordAccuracy, type Attempt, type BankEntry, type SpeakingAssessment, type SpeakingRecord } from "./learner.ts";

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
  const grading = pending.length ? `先用 english_grade(block_id="${ctx.blockId}") 给待评的题打分并写点评，再` : "";
  const settings = ctx.settings();
  const target = Number(settings.quizSize) * 3;
  const left = ctx.store.count("bank");
  // From the bank the next set is drawn at once; the tutor's part is to comment and keep the bank stocked.
  const tail =
    settings.source === "bank"
      ? `${grading}点评这一组。出题方式是题库：本人点“下一组”会从题库里直接取，不要用 english_quiz 出下一组。题库现在 ${left} 题${left < target ? `，用 english_bank_add 补到约 ${target} 题（按刚才的结果：答错的知识点换个问法再考，薄弱点占三分之一；场景和这一组相同）` : "，够用，不用补"}。`
      : `${grading}总结这一组、出下一组。`;
  return { result: { items, at }, message: [head, ...lines, "", tail].join("\n") };
}

function checkItem(it: Item, i: number) {
  if (it.type === "choice" && it.answer >= it.options.length) throw new Error(`第 ${i + 1} 题的 answer 超出了选项范围（共 ${it.options.length} 个选项，下标从 0 开始）`);
  if (it.type === "cloze" && (it.text.match(/_{3,}/g) ?? []).length !== 1) throw new Error(`第 ${i + 1} 题（cloze）的 text 要有且只有一个 ___`);
}

const BANK_MAX = 300;

// ---------------------------------------------------------------- speaking practice

/**
 * Speaking practice is a block like a quiz: it waits in the session until the owner has talked it
 * through on the page (the shell holds the microphone and the voice model, @omem-ai/plugin-sdk `voice`),
 * then the transcript is handed in as the answer, and the tutor assesses it with english_speaking_grade.
 */
const speakingBlock = z.object({
  scene: z.string().trim().min(1).max(120).describe("场景，如“在餐厅点餐，问推荐菜，说明忌口”；自由聊写“自由对话”"),
  goal: z.string().trim().max(300).optional().describe("这次要刻意练的说法或目标（可选），如“用 Could I… / I'd like… 点餐”"),
});
type SpeakingBlock = z.infer<typeof speakingBlock>;
const speakingAnswer = z.object({
  transcript: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(400),
  startedAt: z.string().max(40),
  endedAt: z.string().max(40),
  model: z.string().max(100).default(""),
});
const DIMENSIONS = ["fluency", "grammar", "vocab", "fit"] as const;
const dimension = z.number().int().min(1).max(5).nullable().default(null);

/** What the voice model is told: play the other person, at the learner's level, help in Chinese when asked. */
export function speakingInstructions(b: SpeakingBlock, o: { level: string | null; accent: string; phrases: string[] }) {
  const free = /^自由(对话|聊)?$/.test(b.scene.trim());
  return [
    "You are an English conversation partner for a Chinese-speaking learner practising speaking.",
    free
      ? "Have a natural conversation on a topic the learner picks; start by asking what they want to talk about."
      : `Scene: ${b.scene}. Play the other person in this scene naturally and keep it going; start by greeting the learner in character.`,
    b.goal ? `What the learner wants to practise this time: ${b.goal}. Give them chances to use it.` : "",
    o.level ? `The learner's speaking level is about ${o.level} (CEFR). Speak natural, everyday English a little above that level; keep each turn short so they speak more than you.` : "Speak natural, everyday English; keep each turn short so the learner speaks more than you.",
    o.phrases.length ? `Expressions they are working on; bring a few into the conversation naturally: ${o.phrases.join(", ")}.` : "",
    `Use ${o.accent === "en-GB" ? "British" : "American"} English.`,
    "If the learner asks in Chinese (or another language) how to say something or what a word means, answer briefly in that language, give the English, then return to the scene in English.",
    "Do not correct every mistake while talking. Only if a mistake blocks understanding, rephrase it naturally (\"Oh, you mean …?\") and go on. A detailed assessment comes after the call.",
  ]
    .filter(Boolean)
    .join("\n");
}

function gradeSpeaking(ctx: PluginContext & { blockId: string }, data: SpeakingBlock, answers: Record<string, unknown>) {
  const a = speakingAnswer.safeParse(answers);
  if (!a.success) throw new Error("口语练习的记录格式不对");
  const transcript = a.data.transcript.map((t) => ({ role: t.role, text: t.text.trim() })).filter((t) => t.text);
  if (!transcript.some((t) => t.role === "user")) throw new Error("这次还没有说话，没有可以交给陪练的记录");
  const record: SpeakingRecord = { scene: data.scene, goal: data.goal, startedAt: a.data.startedAt, endedAt: a.data.endedAt, model: a.data.model, transcript, assessment: null };
  ctx.store.put("speaking", ctx.blockId, record);
  const minutes = Math.max(1, Math.round((Date.parse(a.data.endedAt) - Date.parse(a.data.startedAt)) / 60_000) || 1);
  const message = [
    `【口语练习】${data.scene}，约 ${minutes} 分钟，学习者说了 ${transcript.filter((t) => t.role === "user").length} 段。${data.goal ? `这次想练：${data.goal}。` : ""}`,
    "",
    "对话记录（learner 是学习者，partner 是语音模型；学习者的话是语音转写，个别词可能转错）：",
    ...transcript.map((t) => `${t.role === "user" ? "learner" : "partner"}: ${t.text}`),
    "",
    `先 read_skill("english-speaking") 看评价标准，再用 english_speaking_grade(block_id="${ctx.blockId}") 交评价（水平、四项分、完整的评价文字、涉及的知识点）。评价会显示在练习页的这次对话下面，这一轮的文字只写一两句。`,
  ].join("\n");
  return { result: { ...record, minutes }, message };
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
        checkItem(it, i);
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

  api.block({
    kind: "speaking",
    description:
      "在练习页上放一次英语口语练习：本人和语音模型按场景对话（语音模型扮演场景里的另一个人，卡住时可以用中文问），结束后对话记录作为下一条消息回来，你用 english_speaking_grade 评价。本人想练口语、或你觉得该练说的时候用；交出后这一轮只说一句开场白。",
    schema: speakingBlock,
    grade: gradeSpeaking,
    presented: (b, id) => `已在练习页上放好口语练习“${b.scene}”（${id}）。本人对话结束后，记录会作为下一条消息到达；这一轮只说一句开场白。`,
  });

  api.tool({
    name: "english_speaking_start",
    description: "在练习页的会话里放一次口语练习（页面上的“开始对话”用）。",
    schema: z.object({ session_id: z.string(), scene: speakingBlock.shape.scene, goal: speakingBlock.shape.goal }),
    page: true,
    write: true,
    handler: (ctx, a) => JSON.stringify({ blockId: ctx.present("speaking", { scene: a.scene, goal: a.goal || undefined }, a.session_id) }),
  });

  api.tool({
    name: "english_speaking_brief",
    description: "一次口语练习给语音模型的说明：场景、本人的口语水平、正在练的说法、口音（页面开始对话前取）。",
    schema: z.object({ block_id: z.string() }),
    page: true,
    handler: (ctx, a) => {
      const block = ctx.block(a.block_id);
      if (!block || block.kind !== "speaking") throw new Error(`没有这次口语练习：${a.block_id}`);
      if (block.status !== "open") throw new Error("这次口语练习已经交过了；再练一次会新开一次");
      const s = snapshot(ctx.store);
      const speaking = s.skills.find((k) => k.skill === "speaking");
      const level = speaking?.attempts ? speaking.level : s.total ? s.skills.filter((k) => k.attempts).sort((x, y) => y.attempts - x.attempts)[0]?.level ?? null : null;
      // Weak phrases and words make good material; grammar points do not read out as expressions.
      const phrases = s.weak.map((w) => w.point).filter((p) => /^(word|phrase):/.test(p)).slice(0, 6).map((p) => p.replace(/^[a-z]+:/, "").replace(/-/g, " "));
      return JSON.stringify({ instructions: speakingInstructions(block.data as SpeakingBlock, { level, accent: String(ctx.settings().voice ?? "en-US"), phrases }) });
    },
  });

  api.tool({
    name: "english_speaking_grade",
    description:
      "给一次口语练习交评价（read_skill(\"english-speaking\") 里有标准）。level 是这次表现出的口语水平（CEFR）；scores 是四项 1–5 分：fluency 流利度、grammar 语法、vocab 词汇、fit 是否得体并完成场景里的事，证据不够的项写 null；review 是给本人看的完整评价（Markdown，中文，英文例句保留英文）；points 是对话里涉及的知识点（word:/phrase:/grammar:，小写英文），说错或要用中文求助的 correct=false，用得对的 correct=true。",
    schema: z.object({
      block_id: z.string(),
      level: z.enum(LEVELS),
      scores: z.object({ fluency: dimension, grammar: dimension, vocab: dimension, fit: dimension }),
      review: z.string().trim().min(1).max(6000),
      points: z.array(z.object({ point: z.string().max(60), correct: z.boolean(), error_tag: z.string().max(30).optional() })).max(15).default([]),
    }),
    write: true,
    handler: (ctx, a) => {
      const block = ctx.block(a.block_id);
      if (!block || block.kind !== "speaking") return `没有这次口语练习：${a.block_id}`;
      if (block.status !== "submitted" || !block.result) return "这次口语练习本人还没有交";
      const at = new Date().toISOString();
      const assessment: SpeakingAssessment = { level: a.level, scores: { ...a.scores }, review: a.review, at };
      const first = !(block.result as SpeakingRecord).assessment;
      ctx.setBlockResult(a.block_id, { ...block.result, assessment });
      const record = ctx.store.get<SpeakingRecord>("speaking", a.block_id);
      if (record) ctx.store.put("speaking", a.block_id, { ...record, assessment });
      // A second assessment of the same practice corrects the first; it does not count twice.
      if (first) {
        applySpeaking(ctx.store, a.level, at);
        const given = a.scores as Record<string, number | null>;
        const known = DIMENSIONS.map((d) => given[d]).filter((v): v is number => typeof v === "number");
        const score = known.length ? known.reduce((x, y) => x + y, 0) / known.length / 5 : 0.5;
        for (const p of a.points) {
          const point = p.point.trim().toLowerCase();
          if (point) applyPoint(ctx.store, point, p.correct, p.correct ? Math.max(score, PASS) : Math.min(score, 0.5), p.error_tag ? [p.error_tag.trim().toLowerCase()] : [], at);
        }
      }
      return `已记下评价（${a.level}${first ? `，口语水平和 ${a.points.length} 个知识点已更新` : "，改了上一次的评价"}）。`;
    },
  });

  api.tool({
    name: "english_snapshot",
    description: "本人的英语学习画像：各技能的分数和等级、近 7 天与之前的正确率、薄弱知识点、该复习的知识点、常见错误类型、近 14 天的练习量。出题前先看它。",
    schema: z.object({ format: z.enum(["text", "json"]).default("text") }),
    page: true,
    handler: (ctx, a) => {
      const s = snapshot(ctx.store);
      const settings = ctx.settings();
      if (a.format === "json") return JSON.stringify({ ...s, settings });
      return `${snapshotText(s)}\n本人的设置：出题方式 ${settings.source === "bank" ? "题库（本人从题库取下一组，你负责点评和补题）" : "陪练现出（每组由你用 english_quiz 出）"}，每组 ${settings.quizSize} 题，每天目标 ${settings.dailyGoal} 题。`;
    },
  });

  api.tool({
    name: "english_bank_add",
    description:
      "往题库里加题，供本人点“下一组”时直接取（出题方式是题库时用）。题目格式和 english_quiz 的 items 一样（不用写 id）；scene 写这批题的场景，和本人选的场景名一致（如“餐厅点餐”），不限场景的留空。宿主按画像从题库挑题：薄弱和该复习的知识点优先、难度贴近本人等级，所以 points 和 level 要标准。",
    schema: z.object({ scene: z.string().max(40).default(""), items: z.array(item).min(1).max(40) }),
    write: true,
    handler: (ctx, a) => {
      const have = ctx.store.count("bank");
      if (have + a.items.length > BANK_MAX) return `题库最多 ${BANK_MAX} 题，现在有 ${have} 题；少加一些，或等本人做掉一部分再补。`;
      a.items.forEach((it, i) => checkItem(it, i));
      const at = new Date().toISOString();
      for (const it of a.items) {
        const { id: _id, ...rest } = it;
        ctx.store.put("bank", null, { item: { ...rest, points: rest.points.map((p) => p.trim().toLowerCase()).filter(Boolean) }, scene: a.scene.trim(), addedAt: at } satisfies BankEntry);
      }
      return `已加入题库 ${a.items.length} 题（场景：${a.scene || "不限"}），题库现在 ${have + a.items.length} 题。`;
    },
  });

  api.tool({
    name: "english_next",
    description: "从题库里按画像挑下一组题，放进练习页的会话（页面上的“下一组”按钮用）。题库不够时不出题，返回 drawn=false。",
    schema: z.object({ session_id: z.string(), scene: z.string().max(40).optional() }),
    page: true,
    write: true,
    handler: (ctx, a) => {
      const size = Number(ctx.settings().quizSize) || 8;
      const entries = ctx.store.list<BankEntry>("bank", { limit: 5000 });
      const picked = pickFromBank(entries, snapshot(ctx.store), { size, scene: a.scene });
      if (!picked) return JSON.stringify({ drawn: false, bank: entries.length });
      const scene = a.scene?.trim();
      const blockId = ctx.present("quiz", { title: `${scene || "综合"}（题库）`, items: picked.map((e) => e.data.item) }, a.session_id);
      for (const e of picked) ctx.store.delete("bank", e.key);
      return JSON.stringify({ drawn: true, blockId, bank: entries.length - picked.length });
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
