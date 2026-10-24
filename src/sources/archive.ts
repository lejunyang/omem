import { chatBinding } from "../core/capture-space.ts";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { getSpace, listSpaces } from "../core/spaces.ts";
import { HttpError, json, newId, now, sha256 } from "../core/util.ts";
import { createRun } from "../agents/runs.ts";
import { leafMatches } from "../rules/conditions.ts";
import { OPS } from "../rules/types.ts";
import { getSource, sourceText, type UpsertInput } from "./store.ts";
import { vectorIndex } from "../search/vectors.ts";

export const ARCHIVE_FIELDS = { kind: "材料类型", title: "标题 / 群名", uri: "网址 / 路径", text: "正文", channel: "采集渠道", "meta.wikiSpaceName": "知识库名称", "meta.wikiParentTitle": "所在目录", "meta.wikiPath": "上级目录路径" } as const;
export const ARCHIVE_FIELD_HELP: Record<keyof typeof ARCHIVE_FIELDS, string> = {
  kind: "材料本身的类型，例如文档、聊天、网页；从中文选项中选择。",
  title: "原件标题；聊天材料使用会话名，历史聊天可能带月份。不会读取正文。",
  uri: "原件的网址或文件路径，可按网站域名、目录名、文件名匹配。",
  text: "已经采集并转成可读文本的完整正文；聊天材料是已保存的聊天记录，不包含尚未采集的内容。",
  channel: "材料来自哪里，例如飞书、网页或本地文件；不需要填写程序名。",
  "meta.wikiSpaceName": "飞书知识库的名称，不是 omem 的目标空间名。",
  "meta.wikiParentTitle": "飞书文档直接所属目录的名称，例如“周会”。",
  "meta.wikiPath": "从顶层到直接父目录的完整中文路径，例如“项目 A / 周会 / Q3”，不含当前文档标题；用“包含 项目 A”可匹配该目录下各层文档。",
};
export const ARCHIVE_CHANNELS = { lark: "飞书", onebot: "QQ / 微信", web: "网页", file: "本地文件", note: "手动笔记" } as const;
export const ARCHIVE_KINDS = { doc: "文档", chat: "聊天", note: "笔记", web: "网页", image: "图片", event: "日程", meeting: "妙记 / 会议" } as const;
type Field = keyof typeof ARCHIVE_FIELDS;
export type ArchiveCondition = { field: Field; op: (typeof OPS)[number]; value: string | boolean | string[] } | { all: ArchiveCondition[] } | { any: ArchiveCondition[] } | { not: ArchiveCondition };
export const archiveCondition: z.ZodType<ArchiveCondition> = z.lazy(() => z.union([
  z.object({ field: z.enum(Object.keys(ARCHIVE_FIELDS) as [Field, ...Field[]]), op: z.enum(["equals", "contains", "startsWith", "endsWith", "in", "is"]), value: z.union([z.string().max(2000), z.boolean(), z.array(z.string().max(2000)).max(100)]).describe(`kind 的取值：${JSON.stringify(ARCHIVE_KINDS)}，采集渠道：${JSON.stringify(ARCHIVE_CHANNELS)}。使用键名匹配。`) }).superRefine((c, ctx) => {
    if (!["kind", "channel"].includes(c.field)) return;
    if (!["equals", "in"].includes(c.op)) { ctx.addIssue({ code: "custom", message: "材料类型和采集渠道请使用“是”或“是其中之一”" }); return; }
    const choices = c.field === "kind" ? ARCHIVE_KINDS : ARCHIVE_CHANNELS;
    const values = Array.isArray(c.value) ? c.value : [c.value];
    if (values.some(v => typeof v !== "string" || !Object.hasOwn(choices, v)))
      ctx.addIssue({ code: "custom", path: ["value"], message: `请使用有效选项 ${Object.keys(choices).join("、")}；文档是 doc。` });
  }),
  z.object({ all: z.array(archiveCondition).min(1).max(30) }), z.object({ any: z.array(archiveCondition).min(1).max(30) }), z.object({ not: archiveCondition }),
]));
export const archiveRuleSchema = z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(2000).default(""), enabled: z.boolean().default(false), target: z.string().min(1), conditions: archiveCondition });
export type ArchiveRule = Omit<z.infer<typeof archiveRuleSchema>, "conditions"> & { id: string; conditions: ArchiveCondition | null; migrationNote?: string };
export function listArchiveRules(app: App): ArchiveRule[] {
  return all<{ id: string; body: string }>(app.db, "select id, body from archive_rules order by rowid").map(r => {
    const body = json<Record<string, unknown>>(r.body, {});
    const parsed = archiveRuleSchema.safeParse(body);
    if (parsed.success) return { ...parsed.data, id: r.id };
    return { ...archiveRuleSchema.omit({ conditions: true }).parse(body), id: r.id, enabled: false, conditions: null, migrationNote: "旧条件包含已移除的字段，已停用。请用名称和目录重新设置条件后保存。" };
  });
}
export function saveArchiveRule(app: App, input: unknown, id = newId("ar")) {
  const body = archiveRuleSchema.parse(input);
  if (getSpace(app, body.target).kind === "worktree") throw new HttpError(400, "不能归档到临时工作区");
  // Bound condition depth; archive rules do not execute regular expressions on long originals.
  const validate = (c: ArchiveCondition, depth = 0) => {
    if (depth > 8) throw new HttpError(400, "条件嵌套不能超过 8 层");
    if ("all" in c || "any" in c) ("all" in c ? c.all : c.any).forEach(x => validate(x, depth + 1));
    else if ("not" in c) validate(c.not, depth + 1);
    else if (c.op === "matches") throw new HttpError(400, "归档条件请使用包含、前缀或后缀，避免对长正文执行正则");
  };
  validate(body.conditions);
  run(app.db, "insert into archive_rules(id,body) values(?,?) on conflict(id) do update set body=excluded.body", id, JSON.stringify(body));
  return { ...body, id };
}
/** Rules match top-down; the order is the table's row order, so reordering rewrites the rows. */
export function orderArchiveRules(app: App, ids: string[]) {
  const rows = all<{ id: string; body: string }>(app.db, "select id, body from archive_rules order by rowid");
  if (ids.length !== rows.length || rows.some((r) => !ids.includes(r.id))) throw new HttpError(409, "归档规则已变化，请刷新后再排序");
  tx(app.db, () => {
    run(app.db, "delete from archive_rules");
    for (const id of ids) run(app.db, "insert into archive_rules(id, body) values(?, ?)", id, rows.find((r) => r.id === id)!.body);
  });
  return listArchiveRules(app);
}
export function archiveChannel(input: UpsertInput): string | undefined {
  if (input.uri.startsWith("lark:") || input.meta?.via === "lark-cli") return "lark";
  if (input.uri.startsWith("onebot:")) return "onebot";
  try { if (/(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(new URL(input.uri).hostname)) return "lark"; } catch {}
  if (input.kind === "web") return "web";
  if (input.uri.startsWith("note/")) return "note";
  if (input.meta?.original || input.meta?.directoryRoot || /^(file:|\/|[A-Za-z]:[\\/])/.test(input.uri)) return "file";
  return undefined;
}
export function matchesArchive(c: ArchiveCondition | null, input: UpsertInput): boolean {
  const evaluate = (c: ArchiveCondition): boolean | undefined => {
    if ("all" in c || "any" in c) {
      const values = ("all" in c ? c.all : c.any).map(evaluate);
      if ("all" in c) return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    }
    if ("not" in c) { const value = evaluate(c.not); return value === undefined ? undefined : !value; }
    if (!Object.hasOwn(ARCHIVE_FIELDS, c.field)) return undefined;
    const value = c.field === "channel" ? archiveChannel(input) : c.field.startsWith("meta.") ? input.meta?.[c.field.slice(5)] : input[c.field as "kind" | "title" | "uri" | "text"];
    return value === undefined || value === null ? undefined : leafMatches(c, value);
  };
  return c !== null && evaluate(c) === true;
}
export type Route = { source_id: string; origin_space: string; mode: "manual" | "binding" | "rule" | "ai" | "fallback"; reason: string; rule_id: string | null; decision_hash: string | null; pending: number; ingest: number };
export function sourceRoute(app: App, id: string) { return one<Route>(app.db, "select * from source_routes where source_id=?", id); }
export function routedSource(app: App, origin: string, uri: string) {
  return one<{ id: string; space_id: string }>(app.db, "select s.id,s.space_id from source_locations l join sources s on s.id=l.source_id where l.origin_space=? and l.uri=? and s.deleted_at is null", origin, uri);
}
function matchedRule(app: App, input: UpsertInput) {
  return listArchiveRules(app).find(r => r.enabled && matchesArchive(r.conditions, input));
}

/** Called before storing captured material. Explicit imports never opt into automatic routing. */
export function prepareArchive(app: App, input: UpsertInput): { input: UpsertInput; mode: Route["mode"]; reason: string; ruleId?: string; origin: string; sourceId?: string } | null {
  if (!input.archive || ["code", "conversation", "activity", "work"].includes(input.kind)) return null;
  const found = routedSource(app, input.spaceId, input.uri) ?? one<{ id: string; space_id: string }>(app.db, "select id,space_id from sources where space_id=? and uri=?", input.spaceId, input.uri);
  const prev = found ? sourceRoute(app, found.id) : undefined;
  const origin = prev?.origin_space ?? input.spaceId;
  if (prev?.mode === "manual") return { sourceId: found?.id, input: { ...input, spaceId: found!.space_id }, mode: prev.mode, reason: prev.reason, origin };
  const chatId = typeof input.meta?.chatId === "string" ? input.meta.chatId : undefined;
  const bound = chatId ? chatBinding(app, chatId) : undefined;
  if (bound) {
    return { sourceId: found?.id, input: { ...input, spaceId: bound }, mode: "binding", reason: "来源会话的空间设置", origin };
  }
  if (prev?.mode === "binding" && !chatId) return { sourceId: found?.id, input: { ...input, spaceId: found!.space_id }, mode: prev.mode, reason: prev.reason, origin };
  // A configured non-personal destination is a binding, not an AI inference.
  if (!prev && input.spaceId !== "personal") return { sourceId: found?.id, input, mode: "binding", reason: "采集入口指定空间", origin };
  const rule = matchedRule(app, input);
  if (rule) {
    getSpace(app, rule.target);
    return { sourceId: found?.id, input: { ...input, spaceId: rule.target }, mode: "rule", reason: `归档规则：${rule.name}`, ruleId: rule.id, origin };
  }
  if (prev?.mode === "ai") return { sourceId: found?.id, input: { ...input, spaceId: found!.space_id }, mode: "ai", reason: prev.reason, origin };
  return { sourceId: found?.id, input: { ...input, spaceId: found?.space_id ?? "personal" }, mode: "fallback", reason: "未命中归档规则，暂存个人空间", origin };
}
export function finishArchive(app: App, id: string, prepared: NonNullable<ReturnType<typeof prepareArchive>>) {
  const s = getSource(app, id);
  const old = sourceRoute(app, id);
  const pending = prepared.mode === "fallback" && old?.decision_hash !== s.hash ? 1 : 0;
  run(app.db, `insert into source_routes(source_id,origin_space,mode,reason,rule_id,pending) values(?,?,?,?,?,?)
    on conflict(source_id) do update set mode=excluded.mode,reason=excluded.reason,rule_id=excluded.rule_id,pending=excluded.pending`, id, prepared.origin, prepared.mode, prepared.reason, prepared.ruleId ?? null, pending);
  run(app.db, "insert or ignore into source_locations(origin_space,uri,source_id) values(?,?,?)", prepared.origin, s.uri, id);
  if (pending && listSpaces(app).some(s => s.id !== "personal" && s.kind !== "personal")) queueArchive(app, id);
}
export function queueArchive(app: App, id: string) {
  const s = getSource(app, id);
  const queued = one<{ id: string; input: string }>(app.db, "select id,input from runs where kind='archive' and status='queued' and space_id=? order by created_at limit 1", s.spaceId);
  const ids = queued ? json<{ sourceIds: string[] }>(queued.input, { sourceIds: [] }).sourceIds : [];
  if (queued && ids.length < 40) {
    if (!ids.includes(id)) run(app.db, "update runs set input=? where id=?", JSON.stringify({ sourceIds: [...ids, id] }), queued.id);
  } else createRun(app, { kind: "archive", spaceId: s.spaceId, title: "判断材料归属", input: { sourceIds: [id] }, lane: `archive:${s.spaceId}`, userId: "owner" });
}

/** Keep IDs, chunk IDs, embeddings, message positions and citations stable. */
export function moveSource(app: App, id: string, target: string, reason: string, mode: Route["mode"] = "manual", ruleId?: string, expectedHash?: string) {
  const s = getSource(app, id);
  if (s.deletedAt) throw new HttpError(409, "原件已删除");
  if (expectedHash && s.hash !== expectedHash) throw new HttpError(409, "原件已更新，请重新预览");
  if (["code", "conversation", "activity", "work"].includes(s.kind)) throw new HttpError(400, "代码、对话、活动和工作文件由所属工作区管理");
  if (getSpace(app, target).kind === "worktree") throw new HttpError(400, "不能归档到临时工作区");
  if (one(app.db, "select 1 from sources where space_id=? and uri=? and id!=?", target, s.uri, id)) throw new HttpError(409, "目标空间已有同地址原件，请先处理重复材料");
  tx(app.db, () => {
    run(app.db, "insert or ignore into source_locations(origin_space,uri,source_id) values(?,?,?)", s.spaceId, s.uri, id);
    run(app.db, "update sources set space_id=? where id=?", target, id);
    for (const table of ["chunks", "symbols", "code_refs"]) run(app.db, `update ${table} set space_id=? where source_id=?`, target, id);
    run(app.db, `insert into source_routes(source_id,origin_space,mode,reason,rule_id,decision_hash,pending) values(?,?,?,?,?,?,0)
      on conflict(source_id) do update set mode=excluded.mode,reason=excluded.reason,rule_id=excluded.rule_id,decision_hash=excluded.decision_hash,pending=0`, id, s.spaceId, mode, reason, ruleId ?? null, s.hash);
    run(app.db, "insert into source_moves(source_id,from_space,to_space,reason,at) values(?,?,?,?,?)", id, s.spaceId, target, reason, now());
  });
  vectorIndex().clear();
  app.emit({ type: "changed", entity: "source", id, spaceId: target });
  return getSource(app, id);
}
export function archiveHistory(app: App, id: string) { return all(app.db, "select from_space,to_space,reason,at from source_moves where source_id=? order by id desc limit 50", id); }

/** Preview current-space historical material without changing it; applying rechecks the hash and rule. */
export function previewArchive(app: App, spaceId: string, limit = 100, offset = 0) {
  getSpace(app, spaceId);
  return all<{ id: string }>(app.db, "select id from sources where space_id=? and deleted_at is null and kind not in ('code','conversation','activity','work') order by id limit ? offset ?", spaceId, limit, offset).map(({ id }) => {
    const s = getSource(app, id);
    const r = matchedRule(app, { ...s, text: sourceText(app, id) });
    const pinned = ["manual", "binding"].includes(sourceRoute(app, id)?.mode ?? "") || (typeof s.meta.chatId === "string" && !!chatBinding(app, s.meta.chatId));
    return { id, title: s.title, hash: s.hash, from: s.spaceId, target: pinned ? s.spaceId : r?.target ?? s.spaceId, ruleId: pinned ? undefined : r?.id, ruleVersion: pinned || !r ? undefined : sha256(JSON.stringify(r)), reason: pinned ? "已手动指定或绑定" : r ? `归档规则：${r.name}` : "未命中规则，保留当前空间", conflict: !!r && !!one(app.db, "select 1 from sources where space_id=? and uri=? and id!=?", r.target, s.uri, id) };
  });
}
export function applyArchivePreview(app: App, spaceId: string, entries: { id: string; hash: string; ruleId: string; ruleVersion: string; target: string }[]) {
  return entries.map(e => {
    try {
      const s = getSource(app, e.id);
      if (s.spaceId !== spaceId) throw new HttpError(409, "原件空间已变化");
      if (["manual", "binding"].includes(sourceRoute(app, e.id)?.mode ?? "") || (typeof s.meta.chatId === "string" && !!chatBinding(app, s.meta.chatId))) throw new HttpError(409, "原件已指定归属");
      const r = matchedRule(app, { ...s, text: sourceText(app, e.id) });
      if (!r || r.id !== e.ruleId || r.target !== e.target || sha256(JSON.stringify(r)) !== e.ruleVersion) throw new HttpError(409, "规则已变化，请重新预览");
      moveSource(app, e.id, r.target, `归档规则：${r.name}`, "rule", r.id, e.hash);
      return { id: e.id, ok: true };
    } catch (err) { return { id: e.id, ok: false, error: (err as Error).message }; }
  });
}
