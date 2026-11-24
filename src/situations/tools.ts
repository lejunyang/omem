import { z } from "zod";
import type { ToolContext } from "../agents/tools.ts";
import { getRun, runUser } from "../agents/runs.ts";
import { findThread } from "../agents/threads.ts";
import { all, one } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { listContexts } from "../channels/listen.ts";
import { requireSituation, saveSituation } from "./settings.ts";
import { instanceOfThread, MAX_EXTENSION_MINUTES, startSituation, updateSituation } from "./instances.ts";
import { proposeSituation } from "./teaching.ts";

const name = z.string().trim().min(1).max(80);
const note = z.string().trim().min(1).max(2000);
const recognize = z.string().trim().min(1).max(1000);
export const saveSituationArgs = z.object({ id: z.string().optional(), name: name.optional(), note: note.optional(), recognize: recognize.optional(),
  space: z.string().optional(), spec: name.optional(), owner_requested: z.boolean().optional().describe("只有本人这轮明确要建或改才写 true；自己提议留空，回复后等卡片确认") });
export const startSituationArgs = z.object({ name: z.string().trim().min(1).max(100).describe("情境确切名字或 id"), about: note });
export const updateSituationArgs = z.object({ current: z.string().trim().min(1).max(300).optional(), extend_minutes: z.number().int().min(1).max(MAX_EXTENSION_MINUTES).optional(), summary: z.string().trim().min(1).max(3000).optional().describe("结束这一回并写小结") });
export const proposeSituationArgs = z.object({ name, note, recognize, item_id: z.string(), steps: z.array(z.string().trim().min(1).max(100)).min(3).max(6), until: z.string().trim().min(1).max(100) });

function ownerConversation(ctx: ToolContext, ownerTurn: boolean) {
  if (!ctx.runId || !ownerTurn || ctx.spec || (ctx.role && ctx.role !== "assistant") || ctx.peer || runUser(ctx.app, ctx.runId) !== OWNER || (ctx.userId ?? OWNER) !== OWNER)
    throw new HttpError(403, "只能由主助手在本人自己的对话里设置或开始情境");
  const r = getRun(ctx.app, ctx.runId);
  const t = typeof r.input.conversationId === "string" && findThread(ctx.app, r.input.conversationId);
  if (!t || t.channel === "listen" || t.userId !== OWNER || r.input.fromAsk || r.input.guest || r.input.rule) throw new HttpError(403, "这一轮不是本人的对话");
  const ids = (r.input.messageIds as string[] | undefined) ?? [];
  const rows = all<{ id: string; meta: string }>(ctx.app.db, "select id,meta from messages where conversation_id=? and id in (select value from json_each(?))", t.id, JSON.stringify(ids));
  if (rows.some(m => JSON.parse(m.meta).asker)) throw new HttpError(403, "访客在场的这一轮不能管理情境");
  return { t, r, ids: rows.filter(m => { const x = JSON.parse(m.meta); return !x.speaker && !x.asker && !x.wake && !x.fromAsk; }).map(m => m.id) };
}

export async function saveFromChat(ctx: ToolContext, a: z.infer<typeof saveSituationArgs>, ownerTurn: boolean, write: (space?: string | null) => string, currentChat: string | null) {
  const { t, r } = ownerConversation(ctx, ownerTurn);
  const before = a.id ? requireSituation(ctx.app, OWNER, a.id) : null;
  if (before) write(before.spaceId);
  const { context: c, proposed, previousNote, confirmation } = await saveSituation(ctx.app, OWNER, { id: a.id, name: a.name, note: a.note, recognize: a.recognize, spec: a.spec, spaceId: write(a.space ?? before?.spaceId) },
    { currentChat, ...(a.owner_requested ? {} : { confirmation: { runId: r.id, conversationId: t.id } }) });
  return [`情境 ${c.id}「${proposed.name}」${confirmation ? (before ? "等待本人确认改动，原版继续生效；回复后展示确认卡片" : "等待本人启用，回复后展示确认卡片") : "已保存，" + (c.status === "active" ? "已启用" : "保持停用")}`, `怎么认出来：${proposed.recognize}`,
    ...(previousNote !== null && previousNote !== proposed.note ? [`原说明：${previousNote}`, `新说明：${proposed.note}`, "回复中列出这项对照。"] : [`说明：${proposed.note}`])].join("\n");
}

export async function startFromChat(ctx: ToolContext, a: z.infer<typeof startSituationArgs>, ownerTurn: boolean, write: (space?: string | null) => string) {
  const { r, ids } = ownerConversation(ctx, ownerTurn);
  const list = listContexts(ctx.app, { kind: "situation" }).filter(c => c.userId === OWNER);
  const matches = list.filter(c => c.id === a.name || c.name === a.name);
  if (matches.length !== 1) throw new HttpError(400, `请指定一个情境的名字或 id：${list.filter(c => !ctx.spaces || ctx.spaces.includes(c.spaceId ?? "personal")).slice(0, 20).map(c => `${c.name}（${c.id}）`).join("、") || "还没有情境"}`);
  write(matches[0].spaceId);
  const { instance, runId } = await startSituation(ctx.app, OWNER, matches[0].id, a.about, { runId: r.id, refs: ids.slice(-5).map(id => `msg:${id}`) });
  return `已开始：${instance.title}（${instance.id}，事项 ${instance.itemId}），窗口到 ${instance.windowUntil}${runId ? `，处理运行 ${runId}` : ""}。`;
}

export function updateFromTurn(ctx: ToolContext, a: z.infer<typeof updateSituationArgs>, write: (space?: string | null) => string) {
  if (!ctx.runId || (ctx.userId ?? OWNER) !== OWNER || runUser(ctx.app, ctx.runId) !== OWNER) throw new HttpError(403, "只能更新本次运行所在的一回情境");
  const r = getRun(ctx.app, ctx.runId);
  const i = r.kind === "ask" && typeof r.input.conversationId === "string" && instanceOfThread(ctx.app, r.input.conversationId);
  if (!i || i.userId !== OWNER || !r.lane || r.lane !== i.conversationId) throw new HttpError(403, "只能更新本次运行所在的一回情境");
  if (a.current === undefined && a.extend_minutes === undefined && a.summary === undefined) throw new HttpError(400, "请给现状、延长时间或小结");
  write(i.spaceId);
  const next = updateSituation(ctx.app, i, { current: a.current, extendMinutes: a.extend_minutes, summary: a.summary }, r.id);
  return next.status === "ended" ? `已结束「${next.title}」：${next.summary}` : `现状：${next.current}；窗口到 ${next.windowUntil}`;
}

export function proposeFromSettle(ctx: ToolContext, a: z.infer<typeof proposeSituationArgs>, write: (space?: string | null) => string) {
  if (!ctx.runId || (ctx.userId ?? OWNER) !== OWNER || runUser(ctx.app, ctx.runId) !== OWNER) throw new HttpError(403, "只能从本人的事项收尾提议情境");
  const r = getRun(ctx.app, ctx.runId);
  if (r.kind !== "item-settle" || r.input.situationTeaching !== a.item_id) throw new HttpError(403, "只能从本轮正在收尾的事项提议");
  const item = one<{ space_id: string }>(ctx.app.db, "select space_id from items where id=? and user_id=?", a.item_id, OWNER);
  if (!item) throw new HttpError(404, "没有这个事项");
  write(item.space_id);
  return proposeSituation(ctx.app, a.item_id, ctx.runId, a);
}
