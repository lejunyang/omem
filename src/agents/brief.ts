import { HttpError } from "../core/util.ts";

/**
 * What an agent puts in front of the owner to decide or act on (a question, a blocked report, a
 * stage's result): one sentence first, then short sections. The check stops only the plain wall of
 * text; how to write one is in roles/_common.md ("给本人看的问题和报告").
 */
export const BRIEF_RULE =
  "第一段只写一句：要本人定什么（或卡在什么上、要谁做什么）。之后分段，每段用加粗的小标题开头：**现在**（现状和查实的事实）、**问题**（卡在哪、为什么，原因落到文件、接口或服务）、**做法**（可选的做法和各自的影响，推荐的放第一个）、**依据**（引用：src:…、运行、链接、LogID，一行一个）。每段两三句；日志、调查过程、长 ID 列表放进附件或运行，正文只引用。";

/** Text this short reads fine as it is. */
const SHORT = 240;
/** A prose paragraph longer than this is a wall, not a section. */
const PARAGRAPH = 500;
/** The first paragraph says what is asked in a sentence. */
const LEAD = 160;

const paragraphs = (text: string) => text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
/** Lists, quotes, tables and code are structure already, however long. */
const structured = (p: string) => /^(?:[-*+]\s|\d+[.)、]\s?|>|\||```|#{1,6}\s)/.test(p) || p.split("\n").length >= 3;

/** Why this text is not yet something the owner can decide on at a glance, or null. */
export function briefProblem(text: string): string | null {
  const t = text.trim();
  if (t.length <= SHORT) return null;
  const ps = paragraphs(t);
  if (ps.length < 2) return "整段没有分段";
  if (ps[0].replace(/\*\*/g, "").length > LEAD && !structured(ps[0])) return `第一段超过 ${LEAD} 字，不是一句话`;
  const wall = ps.find((p) => !structured(p) && p.length > PARAGRAPH);
  if (wall) return `有一段超过 ${PARAGRAPH} 字（“${wall.slice(0, 24)}…”）`;
  return null;
}

/** Refuses a wall of text with how to write it instead. */
export function checkBrief(text: string | undefined, what: string) {
  const problem = text ? briefProblem(text) : null;
  if (problem) throw new HttpError(400, `${what}${problem}，本人没法一眼看懂。改成这样再交：${BRIEF_RULE}`);
}

/** The first paragraph (what is asked) and the rest, for cards that show them differently. */
export function briefParts(text: string): { lead: string; body: string } {
  const ps = paragraphs(text);
  return { lead: ps[0] ?? "", body: ps.slice(1).join("\n\n") };
}
