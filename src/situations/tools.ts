import { z } from "zod";
import type { ToolContext } from "../agents/tools.ts";
import { getRun, runUser } from "../agents/runs.ts";
import { findThread } from "../agents/threads.ts";
import { all, one, withinTx } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { listContexts } from "../channels/listen.ts";
import { requireSituation, saveSituation } from "./settings.ts";
import { requireInstance, startSituation, updateSituation } from "./instances.ts";
import { attachSituationChat, bindSituationChat, contextForBinding, situationOfRun } from "./chat.ts";
import { MAX_EXTENSION_MINUTES } from "./limits.ts";
import { proposeSituation } from "./teaching.ts";

const name = z.string().trim().min(1).max(80);
const note = z.string().trim().min(1).max(2000);
const recognize = z.string().trim().min(1).max(1000);
export const saveSituationArgs = z.object({ id: z.string().optional(), name: name.optional(), note: note.optional(), recognize: recognize.optional().describe("一句话描述什么时候开始跟进，宿主编成触发条件"),
  reply: z.enum(["none", "draft", "auto"]).optional().describe("这一次的群里：不发、先给本人看、直接发；不填就不改"),
  space: z.string().optional(), spec: name.optional(), owner_requested: z.boolean().optional().describe("只有本人这轮明确要建或改才写 true；自己提议留空，回复后等卡片确认") });
export const startSituationArgs = z.object({ name: z.string().trim().min(1).max(100).describe("持续跟进规则的确切名字或 id"), about: note });
export const updateSituationArgs = z.object({ current: z.string().trim().min(1).max(300).optional(), extend_minutes: z.number().int().min(1).max(MAX_EXTENSION_MINUTES).optional(), summary: z.string().trim().min(1).max(3000).optional().describe("结束这一次并写小结"),
  chat: z.string().trim().min(1).max(100).optional().describe("确认是这一次对应的群后，填 chat_id 绑定或换群；不发消息") });
export const proposeSituationArgs = z.object({ name, note, recognize, item_id: z.string(), steps: z.array(z.string().trim().min(1).max(100)).min(3).max(6), until: z.string().trim().min(1).max(100) });

function ownerConversation(ctx: ToolContext, ownerTurn: boolean) {
  if (!ctx.runId || !ownerTurn || ctx.spec || (ctx.role && ctx.role !== "assistant") || ctx.peer || runUser(ctx.app, ctx.runId) !== OWNER || (ctx.userId ?? OWNER) !== OWNER)
    throw new HttpError(403, "只能由主助手在本人自己的对话里设置持续跟进的规则或开始一次跟进");
  const r = getRun(ctx.app, ctx.runId);
  const t = typeof r.input.conversationId === "string" && findThread(ctx.app, r.input.conversationId);
  if (!t || t.channel === "listen" || t.userId !== OWNER || r.input.fromAsk || r.input.guest || r.input.rule) throw new HttpError(403, "这一轮不是本人的对话");
  const ids = (r.input.messageIds as string[] | undefined) ?? [];
  const rows = all<{ id: string; meta: string }>(ctx.app.db, "select id,meta from messages where conversation_id=? and id in (select value from json_each(?))", t.id, JSON.stringify(ids));
  if (rows.some(m => JSON.parse(m.meta).asker)) throw new HttpError(403, "访客在场的这一轮不能管理持续跟进的规则");
  return { t, r, ids: rows.filter(m => { const x = JSON.parse(m.meta); return !x.speaker && !x.asker && !x.wake && !x.fromAsk; }).map(m => m.id) };
}

export async function saveFromChat(ctx: ToolContext, a: z.infer<typeof saveSituationArgs>, ownerTurn: boolean, write: (space?: string | null) => string, currentChat: string | null) {
  const { t, r } = ownerConversation(ctx, ownerTurn);
  const before = a.id ? requireSituation(ctx.app, OWNER, a.id) : null;
  if (before) write(before.spaceId);
  const { context: c, proposed, previousNote, replyLine, confirmation, conditionsKept } = await saveSituation(ctx.app, OWNER, { id: a.id, name: a.name, note: a.note, recognize: a.recognize, spec: a.spec, spaceId: write(a.space ?? before?.spaceId), ...(a.reply !== undefined && { knobs: { reply: a.reply } }) },
    { currentChat, ...(a.owner_requested ? {} : { confirmation: { runId: r.id, conversationId: t.id } }) });
  return [`持续跟进的规则 ${c.id}「${proposed.name}」${confirmation ? (before ? "等待本人确认改动，原版继续生效；回复后展示确认卡片" : "等待本人启用，回复后展示确认卡片") : "已保存，" + (c.status === "active" ? "已启用" : "保持停用")}`,
    ...(proposed.recognize ? [`什么时候开始：${proposed.recognize}`] : []), ...(conditionsKept ? ["开始的条件是本人在规则页手改过的，这句话只更新了描述、没有重新生成条件；要按新的说法重来，请本人在规则页点“重新生成条件”。"] : []), replyLine,
    ...(previousNote !== null && previousNote !== proposed.note ? [`原说明：${previousNote}`, `新说明：${proposed.note}`, "回复中列出这项对照。"] : [`说明：${proposed.note}`])].join("\n");
}

export async function startFromChat(ctx: ToolContext, a: z.infer<typeof startSituationArgs>, ownerTurn: boolean, write: (space?: string | null) => string) {
  const { r, ids } = ownerConversation(ctx, ownerTurn);
  const list = listContexts(ctx.app, { kind: "situation" }).filter(c => c.userId === OWNER);
  const matches = list.filter(c => c.id === a.name || c.name === a.name);
  if (matches.length !== 1) throw new HttpError(400, `请指定一条持续跟进规则的名字或 id：${list.filter(c => !ctx.spaces || ctx.spaces.includes(c.spaceId ?? "personal")).slice(0, 20).map(c => `${c.name}（${c.id}）`).join("、") || "还没有持续跟进的规则"}`);
  write(matches[0].spaceId);
  const { instance, runId } = await startSituation(ctx.app, OWNER, matches[0].id, a.about, { runId: r.id, refs: ids.slice(-5).map(id => `msg:${id}`) });
  return `已开始：${instance.title}（${instance.id}，事项 ${instance.itemId}），窗口到 ${instance.windowUntil}${runId ? `，处理运行 ${runId}` : ""}。`;
}

export async function updateFromTurn(ctx: ToolContext, a: z.infer<typeof updateSituationArgs>, write: (space?: string | null) => string) {
  const i = situationOfRun(ctx.app, ctx.runId, ctx.userId ?? OWNER);
  if (!ctx.runId || !i || i.userId !== OWNER) throw new HttpError(403, "只能更新本次运行所在的这一次跟进");
  const update = a.current !== undefined || a.extend_minutes !== undefined || a.summary !== undefined;
  if (!update && !a.chat) throw new HttpError(400, "请给现状、延长时间、小结或这一次的群");
  write(i.spaceId);
  const runId = ctx.runId;
  const patch = { current: a.current, extendMinutes: a.extend_minutes, summary: a.summary };
  let next;
  let warning = "";
  if (a.chat) {
    const chat = a.chat;
    contextForBinding(ctx.app, i);
    const { readChat } = await import("../channels/lark-invite.ts");
    const name = await readChat(chat, true);
    next = withinTx(ctx.app.db, () => {
      bindSituationChat(ctx.app, i, chat, name, runId);
      const fresh = requireInstance(ctx.app, i.userId, i.id);
      return update ? updateSituation(ctx.app, fresh, patch, runId) : fresh;
    });
    await attachSituationChat(ctx.app, i, chat, runId).catch((error: Error) => { warning = `；群原件未挂到事项：${error.message}`; });
  } else next = updateSituation(ctx.app, i, patch, runId);
  const bound = a.chat ? `已绑定这一次的群 ${a.chat}（未发消息）${warning}。` : "";
  return bound + (next.status === "ended" ? `已结束「${next.title}」：${next.summary}` : `现状：${next.current}；窗口到 ${next.windowUntil}`);
}

export function proposeFromSettle(ctx: ToolContext, a: z.infer<typeof proposeSituationArgs>, write: (space?: string | null) => string) {
  if (!ctx.runId || (ctx.userId ?? OWNER) !== OWNER || runUser(ctx.app, ctx.runId) !== OWNER) throw new HttpError(403, "只能从本人的事项收尾提议持续跟进的规则");
  const r = getRun(ctx.app, ctx.runId);
  if (r.kind !== "item-settle" || r.input.situationTeaching !== a.item_id) throw new HttpError(403, "只能从本轮正在收尾的事项提议");
  const item = one<{ space_id: string }>(ctx.app.db, "select space_id from items where id=? and user_id=?", a.item_id, OWNER);
  if (!item) throw new HttpError(404, "没有这个事项");
  write(item.space_id);
  return proposeSituation(ctx.app, a.item_id, ctx.runId, a);
}
