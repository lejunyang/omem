import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace, listSpaces } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";
import { createCard } from "../learn/cards.ts";
import { listItems, upsertItem, getItem, itemEvents } from "../items/store.ts";
import { getMemory, listMemories, memoryHistory, remember, retract, supersede } from "../memory/store.ts";
import { search, type HitType } from "../search/search.ts";
import { importText, importUrl } from "../sources/import.ts";
import { getSource, listSources, readSource, sourceOutline } from "../sources/store.ts";
import { listPages, pageContext, pageExists, readPage, writePage, appendLog } from "../wiki/store.ts";
import { createRun, getRun, listRuns, runEvents, setRunOutput } from "./runs.ts";

export type ToolContext = {
  app: App;
  runId: string | null;
  /** Default space for tools that take an optional `space`. */
  spaceId: string;
  /** Spaces the caller may touch; null = all. */
  spaces: string[] | null;
  tools: Set<string> | null;
  actor: "agent" | "user";
};

type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject;
  write?: boolean;
  handler: (ctx: ToolContext, args: any) => Promise<string> | string;
};

const tools: Tool[] = [];
const def = <S extends z.ZodObject>(t: { name: string; description: string; schema: S; write?: boolean; handler: (ctx: ToolContext, args: z.infer<S>) => Promise<string> | string }) => {
  tools.push(t as unknown as Tool);
};

function space(ctx: ToolContext, requested?: string | null) {
  const id = requested || ctx.spaceId;
  if (!findSpace(ctx.app, id)) throw new HttpError(400, `没有空间 ${id}；用 list_spaces 查看`);
  if (ctx.spaces && !ctx.spaces.includes(id)) throw new HttpError(403, `本次任务不能访问空间 ${id}`);
  return id;
}
/** Reject objects that live outside the spaces this caller may touch. */
function inScope(ctx: ToolContext, spaceId: string, what: string) {
  if (ctx.spaces && !ctx.spaces.includes(spaceId)) throw new HttpError(403, `本次任务不能修改空间 ${spaceId} 中的${what}`);
}
function spacesFor(ctx: ToolContext, requested?: string | null, all = false) {
  if (requested === "*" || all) return ctx.spaces ?? undefined;
  return [space(ctx, requested)];
}

function resolveSource(ctx: ToolContext, ref: string, spaceId?: string | null) {
  const clean = ref.replace(/^src:/, "").replace(/#.*$/, "");
  const byId = one<{ id: string; space_id: string }>(ctx.app.db, "select id, space_id from sources where id = ?", clean);
  const scope = ctx.spaces;
  if (byId && (!scope || scope.includes(byId.space_id))) return byId.id;
  const sid = spaceId ? space(ctx, spaceId) : null;
  const rows = all<{ id: string; space_id: string; uri: string }>(
    ctx.app.db,
    `select id, space_id, uri from sources where (uri = ? or uri like ?) ${sid ? "and space_id = ?" : ""} and deleted_at is null order by length(uri) limit 5`,
    clean,
    `%${clean}`,
    ...(sid ? [sid] : []),
  ).filter((r) => !scope || scope.includes(r.space_id));
  if (rows.length === 1 || (rows.length && rows[0].uri === clean)) return rows[0].id;
  if (rows.length > 1) throw new HttpError(400, `“${ref}”对应多个原件：${rows.map((r) => `${r.id} (${r.space_id}:${r.uri})`).join("; ")}`);
  throw new HttpError(404, `找不到原件 ${ref}`);
}

const fmtLines = (text: string, start: number) =>
  text
    .split("\n")
    .map((l, i) => `${String(start + i).padStart(5)}│${l}`)
    .join("\n");

const sourceKinds: Record<string, HitType[]> = {
  all: ["chunk", "page", "memory", "symbol"],
  sources: ["chunk", "symbol"],
  pages: ["page"],
  memories: ["memory"],
};

// ---------------------------------------------------------------- read tools

def({
  name: "list_spaces",
  description: "列出所有知识空间（领域隔离：个人、项目、代码仓库、学习主题）。",
  schema: z.object({}),
  handler: (ctx) =>
    listSpaces(ctx.app)
      .filter((s) => !ctx.spaces || ctx.spaces.includes(s.id))
      .map((s) => `- ${s.id}（${s.name}，${s.kind}）${s.description ? "：" + s.description : ""}${s.rootPath ? `\n  目录：${s.rootPath}` : ""}`)
      .join("\n") || "（无）",
});

def({
  name: "search",
  description:
    "在知识库中检索：原件片段（文档/代码/聊天）、Wiki 页面、记忆。返回线索而非结论；需要细节时用 read_source / read_page 补读。查代码名称时直接用标识符。",
  schema: z.object({
    query: z.string().describe("自然语言问题或关键词，中英文均可"),
    space: z.string().optional().describe("空间 id；'*' 表示所有可访问空间；默认当前空间"),
    scope: z.enum(["all", "sources", "pages", "memories"]).optional(),
    source_kind: z.enum(["doc", "code", "chat", "note", "web"]).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  handler: async (ctx, a) => {
    const hits = await search(ctx.app, a.query, {
      spaces: spacesFor(ctx, a.space),
      types: sourceKinds[a.scope ?? "all"],
      limit: a.limit ?? 12,
      sourceKinds: a.source_kind ? [a.source_kind] : undefined,
    });
    if (!hits.length) return "没有命中。换个说法、换关键词、去掉限定或搜索其他空间。";
    return hits
      .map((h, i) => {
        const where =
          h.type === "page"
            ? `页面 ${h.spaceId}/${h.path}「${h.title}」`
            : h.type === "memory"
              ? `记忆 ${h.id}（${h.path}${h.status && h.status !== "active" ? "，" + h.status : ""}）${h.title ? "主题：" + h.title : ""}`
              : `原件 ${h.sourceId} ${h.uri} L${h.lineStart}-${h.lineEnd}${h.path && h.path !== h.uri ? " · " + h.path : ""}`;
        return `${i + 1}. ${where}  [${h.via.join("+")}]\n${truncate(h.snippet, 500).replace(/^/gm, "   ")}`;
      })
      .join("\n\n");
  },
});

def({
  name: "read_source",
  description: "读取原件的指定行（带行号）。source 可以是原件 id、路径或路径结尾。每次最多 400 行，长文件分段读。",
  schema: z.object({
    source: z.string(),
    from: z.number().int().min(1).optional(),
    to: z.number().int().min(1).optional(),
    space: z.string().optional(),
  }),
  handler: (ctx, a) => {
    const id = resolveSource(ctx, a.source, a.space);
    const from = a.from ?? 1;
    const to = Math.min(a.to ?? from + 399, from + 399);
    const r = readSource(ctx.app, id, from, to);
    const s = r.source;
    if (s.deletedAt) return `原件 ${s.id}（${s.uri}）已在 ${s.deletedAt} 移除，内容不可用。`;
    const more = r.lineEnd < (s.lines ?? 0) ? `\n……还有 ${(s.lines ?? 0) - r.lineEnd} 行，继续用 from=${r.lineEnd + 1}` : "";
    return `原件 ${s.id} · ${s.spaceId}:${s.uri} · ${s.kind} · 共 ${s.lines} 行 · 更新于 ${s.updatedAt.slice(0, 10)}\n引用格式：[${s.uri}:${r.lineStart}-${r.lineEnd}](src:${s.id}#L${r.lineStart}-L${r.lineEnd})\n\n${fmtLines(r.text, r.lineStart)}${more}`;
  },
});

def({
  name: "source_outline",
  description: "查看原件结构：Markdown 章节或代码符号（函数/类/类型）及其行号，用来决定读哪一段。",
  schema: z.object({ source: z.string(), space: z.string().optional() }),
  handler: (ctx, a) => {
    const id = resolveSource(ctx, a.source, a.space);
    const s = getSource(ctx.app, id);
    const o = sourceOutline(ctx.app, id);
    const lines = [`原件 ${s.id} · ${s.uri}`];
    if (o.symbols.length) lines.push(...o.symbols.map((y) => `- ${y.kind} ${y.qname}  L${y.line_start}-${y.line_end}${y.exported ? " (export)" : ""}  ${truncate(y.signature, 120)}`));
    else lines.push(...[...new Map(o.sections.map((c) => [c.path || c.title, c])).values()].map((c) => `- ${c.path || c.title}  L${c.line_start}-${c.line_end}`));
    return lines.join("\n");
  },
});

def({
  name: "list_sources",
  description: "按标题/路径浏览某空间的原件列表（不是全文检索）。",
  schema: z.object({ space: z.string().optional(), query: z.string().optional(), kind: z.string().optional(), limit: z.number().int().optional() }),
  handler: (ctx, a) => {
    const r = listSources(ctx.app, { spaceId: space(ctx, a.space), q: a.query, kind: a.kind, limit: a.limit ?? 200 });
    return `共 ${r.total} 个原件${r.total > r.sources.length ? `，显示前 ${r.sources.length} 个` : ""}\n` + r.sources.map((s) => `- ${s.id} ${s.uri} (${s.kind}, ${s.lines} 行)`).join("\n");
  },
});

def({
  name: "find_symbol",
  description: "代码导航：按名称找定义位置，以及调用/引用它的地方（名称级匹配，可能有同名误报）。",
  schema: z.object({ name: z.string(), space: z.string().optional() }),
  handler: (ctx, a) => {
    const sp = spacesFor(ctx, a.space);
    const filter = sp ? `and y.space_id in (${sp.map(() => "?").join(",")})` : "";
    const defs = all<{ source_id: string; uri: string; qname: string; kind: string; line_start: number; line_end: number; signature: string }>(
      ctx.app.db,
      `select y.source_id, s.uri, y.qname, y.kind, y.line_start, y.line_end, y.signature from symbols y join sources s on s.id = y.source_id where (y.name = ? or y.qname = ?) ${filter} and s.deleted_at is null limit 20`,
      a.name,
      a.name,
      ...(sp ?? []),
    );
    const short = a.name.split(".").pop()!;
    const refs = all<{ source_id: string; uri: string; from_qname: string; line: number; kind: string }>(
      ctx.app.db,
      `select r.source_id, s.uri, r.from_qname, r.line, r.kind from code_refs r join sources s on s.id = r.source_id where r.to_name = ? ${filter.replace(/y\./g, "r.")} and s.deleted_at is null limit 60`,
      short,
      ...(sp ?? []),
    );
    const out = [`定义（${defs.length}）：`, ...defs.map((d) => `- ${d.kind} ${d.qname} @ ${d.uri}:${d.line_start}-${d.line_end} [${d.source_id}]\n  ${truncate(d.signature, 160)}`)];
    out.push(`\n调用/引用（${refs.length}）：`, ...refs.map((r) => `- ${r.uri}:${r.line} 在 ${r.from_qname || "(模块顶层)"} 中${r.kind === "import" ? "导入" : "调用"}`));
    return out.join("\n");
  },
});

def({
  name: "list_pages",
  description: "列出某空间已有的 Wiki 页面（路径、标题、摘要、引用的原件是否已变化）。写新页面前先看有没有可更新的页面。",
  schema: z.object({ space: z.string().optional() }),
  handler: (ctx, a) => {
    const pages = listPages(ctx.app, space(ctx, a.space));
    return pages.map((p) => `- ${p.slug}「${p.title}」${p.summary ? "：" + truncate(p.summary, 100) : ""}${p.staleSources ? `（${p.staleSources} 个引用原件已变化）` : ""}`).join("\n") || "（这个空间还没有页面）";
  },
});

def({
  name: "read_page",
  description: "读取 Wiki 页面全文，以及反向链接、引用原件和是否过期。",
  schema: z.object({ page: z.string().describe("页面路径（slug），可写成 space/slug"), space: z.string().optional() }),
  handler: (ctx, a) => {
    let sp = a.space;
    let slug = a.page.replace(/^wiki:/, "");
    if (!sp && slug.includes("/") && findSpace(ctx.app, slug.split("/")[0])) [sp, slug] = [slug.split("/")[0], slug.split("/").slice(1).join("/")];
    const id = space(ctx, sp);
    const p = readPage(ctx.app, id, slug);
    const c = pageContext(ctx.app, id, slug);
    const stale = c.sources.filter((s) => s.stale || s.deleted);
    return [
      `页面 ${id}/${slug} · ${p.meta.kind ?? "page"} · 更新于 ${p.meta.updated ?? p.updatedAt.slice(0, 10)}`,
      stale.length ? `注意：${stale.length} 个引用原件在写作后已变化：${stale.map((s) => s.uri).join(", ")}` : "",
      `---\n# ${p.meta.title}\n${p.meta.summary ? "> " + p.meta.summary + "\n" : ""}\n${p.body}`,
      c.backlinks.length ? `---\n被这些页面链接：${c.backlinks.map((b) => b.slug).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
});

def({
  name: "recall",
  description: "查记忆（事实、约定、偏好、经验、人物、决定）。默认只返回当前有效的；include_history=true 时也返回被更正/撤回的旧版本，用于回答“之前怎么约定的”“什么时候改的”。",
  schema: z.object({
    query: z.string().optional(),
    subject: z.string().optional(),
    include_history: z.boolean().optional(),
    space: z.string().optional(),
  }),
  handler: async (ctx, a) => {
    const sp = spacesFor(ctx, a.space ?? "*");
    const query = a.query?.replace(/[*?%\s]+/g, " ").trim();
    let mems = query
      ? (await search(ctx.app, query, { spaces: sp, types: ["memory"], limit: 20, includeHistory: a.include_history })).map((h) => getMemory(ctx.app, h.id))
      : listMemories(ctx.app, { spaceId: sp?.length === 1 ? sp[0] : undefined, status: a.include_history ? "all" : "active", subject: a.subject, limit: 50 });
    if (a.subject) mems = mems.filter((m) => m.subject.includes(a.subject!));
    if (!mems.length) return "没有相关记忆。";
    return mems
      .map((m) => {
        const chain = a.include_history && (m.supersedes || m.supersededBy) ? memoryHistory(ctx.app, m.id) : [];
        return `- ${m.id} [${m.kind}${m.status !== "active" ? "，" + m.status : ""}] ${m.subject ? m.subject + "：" : ""}${m.content}\n  有效：${m.validFrom?.slice(0, 10) ?? "?"} → ${m.validTo?.slice(0, 10) ?? "至今"}；来源：${m.sourceRefs.join(", ") || "无"}${
          chain.length > 1 ? "\n  版本链：" + chain.map((c) => `${c.id}(${c.status}) ${truncate(c.content, 60)}`).join(" → ") : ""
        }`;
      })
      .join("\n");
  },
});

def({
  name: "list_items",
  description: "查看事项（待办、等待回复、提醒、关注、待决定）及其最近进展。",
  schema: z.object({
    status: z.enum(["active", "open", "waiting", "snoozed", "done", "cancelled", "all"]).optional(),
    kind: z.enum(["todo", "waiting", "reminder", "watch", "decision"]).optional(),
    query: z.string().optional(),
    space: z.string().optional(),
    with_timeline: z.boolean().optional(),
  }),
  handler: (ctx, a) => {
    const items = listItems(ctx.app, { status: a.status ?? "active", kind: a.kind, q: a.query, spaceId: a.space ? space(ctx, a.space) : undefined, limit: 100 });
    if (!items.length) return "没有符合条件的事项。";
    return items
      .map((i) => {
        const head = `- ${i.id} [${i.kind}/${i.status}] ${i.title}${i.dueAt ? ` 截止 ${i.dueAt}` : ""}${i.remindAt ? ` 提醒 ${i.remindAt}` : ""}${i.waitingOn ? ` 等待 ${i.waitingOn}` : ""}（空间 ${i.spaceId}）${i.detail ? "\n  " + truncate(i.detail, 200) : ""}`;
        if (!a.with_timeline) return head;
        return head + "\n" + itemEvents(ctx.app, i.id).slice(-6).map((e) => `    · ${e.at.slice(0, 16)} ${e.actor}: ${truncate(e.text, 160)}`).join("\n");
      })
      .join("\n");
  },
});

def({
  name: "list_runs",
  description: "查看后台运行（交办的编码、整理、评审等）的状态。",
  schema: z.object({ kind: z.string().optional(), status: z.string().optional(), limit: z.number().int().optional() }),
  handler: (ctx, a) =>
    listRuns(ctx.app, { kind: a.kind, status: a.status, limit: a.limit ?? 20 })
      .map((r) => `- ${r.id} [${r.kind}/${r.status}] ${r.title} · ${r.createdAt.slice(0, 16)}${r.error ? " · 错误：" + truncate(r.error, 100) : ""}`)
      .join("\n") || "（无）",
});

def({
  name: "read_run",
  description: "读取一次运行的结果：总结、检查输出、评审结论、diff 摘要。",
  schema: z.object({ run_id: z.string() }),
  handler: (ctx, a) => {
    const r = getRun(ctx.app, a.run_id);
    const events = runEvents(ctx.app, r.id).filter((e) => e.type !== "thought");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    return `运行 ${r.id} [${r.kind}/${r.status}] ${r.title}\n输出：${truncate(JSON.stringify(r.output, null, 1), 3000)}\n${r.error ? "错误：" + r.error + "\n" : ""}最后的说明：\n${truncate(text.slice(-3000), 3000)}`;
  },
});

// --------------------------------------------------------------- write tools

const refs = z.array(z.string()).optional().describe("来源引用，如 src:<原件id>#L10-L20、mem:<记忆id>、msg:<消息id>");

def({
  name: "write_page",
  description:
    "创建或整体替换一篇 Wiki 页面（Markdown，会进入 Git 历史）。正文中用 [[slug]] 链接其他页面，用 [文字](src:<原件id>#L起-L止) 引用原件。修改已有页面前先 read_page。",
  write: true,
  schema: z.object({
    page: z.string().describe("页面路径，如 overview、retrieval/how-search-works；index 是空间目录页"),
    title: z.string(),
    summary: z.string().describe("一两句话：读者读完能得到什么"),
    kind: z.enum(["index", "guide", "concept", "howto", "reference", "topic", "person", "project", "log"]).optional(),
    body: z.string().describe("正文 Markdown，不要再写一级标题"),
    space: z.string().optional(),
    reason: z.string().optional().describe("这次修改的原因，写入版本历史"),
  }),
  handler: (ctx, a) => {
    const id = space(ctx, a.space);
    const existed = pageExists(ctx.app, id, a.page);
    const body = a.body.replace(/^#\s+.+\n+/, "");
    const p = writePage(ctx.app, id, a.page, { meta: { title: a.title, summary: a.summary, kind: a.kind ?? "page" }, body }, { actor: ctx.actor, message: `${ctx.actor}: ${existed ? "update" : "create"} ${id}/${a.page}${a.reason ? " — " + a.reason : ""}${ctx.runId ? ` (run ${ctx.runId})` : ""}` });
    appendLog(ctx.app, id, `${existed ? "更新" : "新建"} [[${p.slug}]]${a.reason ? "：" + a.reason : ""}`);
    if (ctx.runId) ctx.app.emit({ type: "run-event", runId: ctx.runId, seq: -1, event: { type: "change", data: { entity: "page", id: p.id }, at: new Date().toISOString() } });
    const c = pageContext(ctx.app, id, p.slug);
    return `已${existed ? "更新" : "创建"}页面 ${p.id}。引用原件 ${c.sources.length} 个${c.missingLinks.length ? `；这些链接目标还不存在：${c.missingLinks.join(", ")}` : ""}`;
  },
});

def({
  name: "remember",
  description:
    "保存一条新记忆（一句话、自足、写清主语和时间）。只记录长期有用的事实/约定/偏好/经验/人物信息/决定，不记录闲聊。已有同主题记忆要更正时用 supersede，不要重复新增。",
  write: true,
  schema: z.object({
    content: z.string(),
    kind: z.enum(["fact", "agreement", "preference", "experience", "person", "decision"]),
    subject: z.string().optional().describe("主题/对象，如“项目A 预算”“张三”"),
    source_refs: refs,
    valid_from: z.string().optional().describe("ISO 时间，事实开始生效的时间（不填为现在）"),
    space: z.string().optional(),
  }),
  handler: (ctx, a) => {
    const m = remember(ctx.app, { spaceId: space(ctx, a.space), kind: a.kind, subject: a.subject, content: a.content, sourceRefs: a.source_refs, validFrom: a.valid_from, createdBy: ctx.actor });
    return `已记住 ${m.id}`;
  },
});

def({
  name: "supersede",
  description: "用新内容更正一条现有记忆：旧记忆保留并标记为已被替代，新记忆生效。适用于纠正、改期、改预算、换负责人等。",
  write: true,
  schema: z.object({ memory_id: z.string(), content: z.string(), reason: z.string().optional(), source_refs: refs, valid_from: z.string().optional() }),
  handler: (ctx, a) => {
    inScope(ctx, getMemory(ctx.app, a.memory_id).spaceId, "记忆");
    const m = supersede(ctx.app, a.memory_id, { content: a.content, sourceRefs: a.source_refs, validFrom: a.valid_from, createdBy: ctx.actor, reason: a.reason });
    return `已更正：${a.memory_id} → ${m.id}`;
  },
});

def({
  name: "forget",
  description: "撤回一条错误或不再需要的记忆（保留撤回记录）。",
  write: true,
  schema: z.object({ memory_id: z.string(), reason: z.string() }),
  handler: (ctx, a) => {
    inScope(ctx, getMemory(ctx.app, a.memory_id).spaceId, "记忆");
    retract(ctx.app, a.memory_id, a.reason);
    return `已撤回 ${a.memory_id}`;
  },
});

def({
  name: "upsert_item",
  description:
    "创建或更新事项。不传 id 为新建。kind：todo 待办 / waiting 等待某人回复 / reminder 定时提醒 / watch 持续关注某项目或讨论 / decision 需要本人决定。时间用带时区的 ISO 格式。note 写这次变化的原因，会进入事项时间线。",
  write: true,
  schema: z.object({
    id: z.string().optional(),
    kind: z.enum(["todo", "waiting", "reminder", "watch", "decision"]).optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    status: z.enum(["open", "waiting", "snoozed", "done", "cancelled"]).optional(),
    priority: z.number().int().min(1).max(3).optional().describe("1 高 2 中 3 低"),
    due_at: z.string().nullable().optional(),
    remind_at: z.string().nullable().optional(),
    waiting_on: z.string().nullable().optional(),
    watch_query: z.string().optional().describe("watch 事项：要关注的内容描述"),
    note: z.string().optional(),
    source_refs: refs,
    space: z.string().optional(),
  }),
  handler: (ctx, a) => {
    const existing = a.id ? getItem(ctx.app, a.id) : null;
    if (existing) inScope(ctx, existing.spaceId, "事项");
    const item = upsertItem(
      ctx.app,
      a.id,
      {
        spaceId: existing ? undefined : space(ctx, a.space),
        kind: a.kind,
        title: a.title,
        detail: a.detail,
        status: a.status,
        priority: a.priority,
        dueAt: a.due_at,
        remindAt: a.remind_at,
        waitingOn: a.waiting_on,
        watch: a.watch_query ? { ...(existing?.watch ?? {}), query: a.watch_query } : undefined,
        note: a.note,
        sourceRefs: a.source_refs,
      },
      ctx.actor,
    );
    return `${existing ? "已更新" : "已创建"}事项 ${item.id}：[${item.kind}/${item.status}] ${item.title}`;
  },
});

def({
  name: "create_card",
  description: "创建一张复习卡片（间隔重复）。正面是问题/提示，背面是答案/解释；一卡一知识点。",
  write: true,
  schema: z.object({ front: z.string(), back: z.string(), source_refs: refs, space: z.string().optional() }),
  handler: (ctx, a) => {
    const r = createCard(ctx.app, { spaceId: space(ctx, a.space), front: a.front, back: a.back, sourceRefs: a.source_refs });
    return r.created ? `已创建卡片 ${r.card.id}` : `已有相同卡片 ${r.card.id}`;
  },
});

def({
  name: "notify",
  description: "通知本人（站内 + 已绑定的机器人）。只用于需要本人知道或决定的变化，不要发送“无变化”。",
  write: true,
  schema: z.object({ title: z.string(), body: z.string(), link: z.string().optional() }),
  handler: (ctx, a) => {
    notify(ctx.app, { title: a.title, body: a.body, link: a.link ?? (ctx.runId ? `#/runs/${ctx.runId}` : null) });
    return "已通知";
  },
});

def({
  name: "save_note",
  description: "把用户明确要求保存的内容存为原件（笔记），之后可检索和引用。",
  write: true,
  schema: z.object({ title: z.string().optional(), text: z.string(), space: z.string().optional() }),
  handler: (ctx, a) => {
    const r = importText(ctx.app, space(ctx, a.space), { title: a.title, text: a.text });
    return `已保存为原件 ${r.id}`;
  },
});

def({
  name: "import_url",
  description: "抓取网页或飞书文档并保存为原件。",
  write: true,
  schema: z.object({ url: z.string().url(), space: z.string().optional() }),
  handler: async (ctx, a) => {
    const r = await importUrl(ctx.app, space(ctx, a.space), a.url);
    return `已保存原件 ${r.id}（${r.status}）`;
  },
});

def({
  name: "delegate_code",
  description:
    "交办编码任务：在指定代码仓库空间的独立 Git worktree 中由编码 Agent 实现，运行检查，再由评审 Agent 审查。返回运行 id，可用 read_run 查看进度。仅在用户明确要求实现/修改代码时使用。",
  write: true,
  schema: z.object({
    repo_space: z.string().describe("代码仓库空间 id"),
    task: z.string().describe("完整的任务描述：目标、背景、验收标准、相关讨论"),
    check_command: z.string().optional().describe("验证命令，如 npm test"),
  }),
  handler: (ctx, a) => {
    const id = space(ctx, a.repo_space);
    const s = findSpace(ctx.app, id)!;
    if (!s.rootPath) throw new HttpError(400, `空间 ${id} 没有关联代码目录`);
    const r = createRun(ctx.app, { kind: "code", spaceId: id, title: truncate(a.task.split("\n")[0], 80), input: { task: a.task, checkCommand: a.check_command }, parentId: ctx.runId });
    return `已交办，运行 ${r.id}。完成后会通知。`;
  },
});

def({
  name: "list_lark_chats",
  description: "列出本人飞书最近活跃的会话，以及哪些已被订阅采集（只读）。用于帮本人挑选要关注的群。",
  schema: z.object({}),
  handler: async (ctx) => {
    const { listLarkChats, getSubscriptions } = await import("../channels/lark-personal.ts");
    const subs = new Map(getSubscriptions(ctx.app).map((s) => [s.chatId, s]));
    const chats = await listLarkChats();
    return chats.map((c) => `- ${c.chatId} ${c.name}（${c.mode === "p2p" ? "单聊" : "群聊"}）${subs.has(c.chatId) ? ` 已订阅 → 空间 ${subs.get(c.chatId)!.spaceId}` : ""}`).join("\n") || "（没有会话）";
  },
});

def({
  name: "set_lark_subscription",
  description: "订阅或取消订阅一个飞书会话的只读采集（新消息会保存为聊天原件并整理）。只在本人要求关注/取消关注某个群时使用。",
  write: true,
  schema: z.object({ chat_id: z.string(), name: z.string(), subscribe: z.boolean(), space: z.string().optional() }),
  handler: async (ctx, a) => {
    const { getSubscriptions, setSubscriptions } = await import("../channels/lark-personal.ts");
    const rest = getSubscriptions(ctx.app).filter((s) => s.chatId !== a.chat_id);
    setSubscriptions(ctx.app, a.subscribe ? [...rest, { chatId: a.chat_id, name: a.name, spaceId: space(ctx, a.space) }] : rest);
    return a.subscribe ? `已订阅「${a.name}」，采集到空间 ${space(ctx, a.space)}（需要在定时任务中开启飞书采集）` : `已取消订阅「${a.name}」`;
  },
});

def({
  name: "submit_plan",
  description: "提交 Wiki 目录计划（只在规划任务中使用）。每页写清读者问题和调查入口，宿主随后按计划逐页安排写作。",
  write: true,
  schema: z.object({
    pages: z
      .array(
        z.object({
          slug: z.string(),
          title: z.string(),
          kind: z.enum(["guide", "concept", "howto", "reference", "topic"]),
          question: z.string().describe("这页要回答的读者问题"),
          outline: z.string().describe("计划的讲解路线：用哪个真实例子、按什么顺序讲"),
          entry_points: z.array(z.string()).describe("调查入口：文件路径、符号或文档"),
          section: z.string().optional().describe("目录中的分组名"),
        }),
      )
      .min(1),
  }),
  handler: (ctx, a) => {
    if (!ctx.runId) throw new HttpError(400, "只能在规划运行中提交");
    setRunOutput(ctx.app, ctx.runId, { plan: a.pages });
    return `已收到 ${a.pages.length} 页的计划`;
  },
});

// ------------------------------------------------------------------ registry

export function toolList(filter?: Set<string> | null) {
  return tools.filter((t) => !filter || filter.has(t.name));
}

export function toolSchemas(filter?: Set<string> | null) {
  return toolList(filter).map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) as Record<string, unknown> }));
}

export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool || (ctx.tools && !ctx.tools.has(name))) return { text: `工具 ${name} 不可用`, isError: true };
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return { text: `参数错误：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
  try {
    const text = await tool.handler(ctx, parsed.data);
    if (ctx.runId && tool.write) ctx.app.emit({ type: "run-event", runId: ctx.runId, seq: -1, event: { type: "tool-write", data: { name, args: parsed.data }, at: new Date().toISOString() } });
    return { text, isError: false };
  } catch (error) {
    return { text: (error as Error).message, isError: true };
  }
}

// --------------------------------------------------------------- tool tokens

const tokens = new Map<string, Omit<ToolContext, "app">>();
export function issueToolToken(ctx: Omit<ToolContext, "app">) {
  const token = "ot_" + randomBytes(18).toString("base64url");
  tokens.set(token, ctx);
  return token;
}
export function revokeToolToken(token: string) {
  tokens.delete(token);
}
export function toolContextForToken(app: App, token: string): ToolContext | null {
  const ctx = tokens.get(token);
  if (ctx) return { app, ...ctx };
  if (app.internalToken && token === app.internalToken) return { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "user" };
  return null;
}
