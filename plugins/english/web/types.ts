/** What the page gets from /api/plugins/english (mirrors src/plugins/blocks.ts and ../server.ts). */
export type Audio = { text: string; lang?: string; rate?: number };
export type QuizItem = {
  id: string;
  type: "choice" | "cloze" | "dictation" | "translate";
  skill: string;
  level: string;
  points: string[];
  prompt?: string;
  text?: string;
  audio?: Audio;
  options?: string[];
  direction?: "zh-en" | "en-zh";
  answer?: number | string[];
  reference?: string;
  explanation?: string;
};
export type ItemResult = { id: string; correct: boolean | null; score: number | null; given: string; expected: string; explanation?: string; feedback?: string; pending: boolean };
export type Block = {
  id: string;
  kind: string;
  status: "open" | "submitted" | "shown";
  data: { title: string; intro?: string; items: QuizItem[] };
  answers: Record<string, unknown> | null;
  result: { items: ItemResult[] } | null;
  runId: string | null;
  createdAt: string;
};
export type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string; submission: string | null };
export type Session = { id: string; title: string; agent: string | null; messages: Message[]; blocks: Block[]; busy: string | null };
export type SessionInfo = { id: string; title: string; createdAt: string; updatedAt: string };

export type Snapshot = {
  total: number;
  today: number;
  skills: { skill: string; rating: number; level: string; attempts: number; last7: number | null; before: number | null }[];
  weak: { point: string; seen: number; accuracy: number }[];
  due: { point: string }[];
  errors: { tag: string; count: number }[];
  daily: { date: string; count: number; accuracy: number | null }[];
  bank: { total: number; scenes: { scene: string; count: number }[] };
  settings: { source: string; quizSize: string; voice: string; rate: string; dailyGoal: number };
};

export const SKILL_LABEL: Record<string, string> = { vocab: "词汇", grammar: "语法", listening: "听力", translation: "翻译", reading: "阅读" };
export const TYPE_LABEL: Record<string, string> = { choice: "选择", cloze: "填空", dictation: "听写", translate: "翻译" };

/** Read aloud with the browser's voices; the owner's accent and speed (settings) win over the item's. */
export function speak(a: Audio, slower = false, pref?: { lang: string; rate: number }) {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(a.text);
  u.lang = pref?.lang ?? a.lang ?? "en-US";
  u.rate = (a.rate ?? 1) * (pref?.rate ?? 1) * (slower ? 0.75 : 1);
  const voices = synth.getVoices();
  const voice = voices.find((v) => v.lang === u.lang) ?? voices.find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  synth.speak(u);
  return true;
}
