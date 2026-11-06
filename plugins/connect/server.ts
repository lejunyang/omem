import { z } from "zod";
import type { PluginApi, PluginContext } from "../../src/plugins/types.ts";
import { CHINA } from "./china.ts";
import { connector, type Def } from "./engine.ts";
import { IDENTITIES } from "./identities.ts";
import { nangoDefs } from "./nango.ts";

/**
 * Connecting other platforms (docs/v2/connectors.md). Two kinds of connector come out of the same
 * descriptions: identities (the platform says who someone is, so it can log in or be bound) and
 * capabilities (a token or key to read with). Agents read through a connection with connect_request
 * and keep what matters as sources with connect_save; the token never reaches them.
 */
const POST_READS: Record<string, RegExp> = {
  notion: /^\/v1\/(search|databases\/[^/]+\/query|data_sources\/[^/]+\/query)$/,
  dropbox: /^\/2\/(files\/(list_folder(\/continue)?|get_metadata|search_v2(\/continue)?)|users\/get_current_account|sharing\/list_[a-z_]+)$/,
};
/** A POST that only reads: a GraphQL query (not a mutation), or a search / query endpoint. */
function readOnlyPost(d: Def, path: string, body: unknown) {
  const p = path.split("?")[0];
  if ((d.readPost ?? POST_READS[d.id])?.test(p)) return true;
  const last = p.split("/").filter(Boolean).pop() ?? "";
  const q = body && typeof body === "object" ? (body as { query?: unknown }).query : undefined;
  if (/graphql/i.test(last) || (typeof q === "string" && /^\s*(query\b|\{)/.test(q))) return typeof q === "string" && !/^\s*mutation\b/.test(q) && !/\bmutation\s*[({]/.test(q);
  return /search|query|listrecords/i.test(last);
}

/**
 * Read-only scopes asked for by default where a platform needs some to read anything (the owner can
 * add more in the platform's settings). Write scopes are never asked for: the tools only read.
 */
const READ_SCOPES: Record<string, string[]> = {
  "google-drive": ["https://www.googleapis.com/auth/drive.readonly"],
  "google-docs": ["https://www.googleapis.com/auth/documents.readonly", "https://www.googleapis.com/auth/drive.readonly"],
  "google-sheet": ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  "google-mail": ["https://www.googleapis.com/auth/gmail.readonly"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.readonly"],
  gitlab: ["read_api"],
  jira: ["read:jira-work", "read:jira-user", "offline_access"],
  confluence: ["read:confluence-content.all", "read:confluence-space.summary", "search:confluence", "offline_access"],
  linear: ["read"],
  dropbox: ["account_info.read", "files.metadata.read", "files.content.read"],
  slack: ["channels:read", "channels:history", "groups:read", "groups:history", "im:history", "mpim:history", "users:read"],
};
/** Where a platform's catalog entry needs a correction for reading as the person. */
const OVERRIDES: Record<string, Partial<Def>> = {
  // Slack's user token (reading as the person) comes from user_scope; `scope` would give a bot token.
  slack: { authNames: { scope: "user_scope" } },
};

export default function register(api: PluginApi) {
  const { defs: catalog, skipped } = nangoDefs();
  const own = new Set(CHINA.map((d) => d.id));
  const defs = new Map<string, Def>();
  for (const d of [...CHINA, ...catalog.filter((d) => !own.has(d.id))]) {
    const extra = READ_SCOPES[d.id] ?? [];
    defs.set(d.id, { ...d, ...OVERRIDES[d.id], defaultScopes: [...new Set([...(d.defaultScopes ?? []), ...extra])], who: d.who ?? IDENTITIES[d.id] });
  }
  for (const d of defs.values()) api.connector(connector(api, d, { identity: !!d.who }));
  if (!catalog.length) console.warn("[omem] 连接平台：读不到 @nangohq/providers，只有内置的国内平台");
  else if (skipped) console.log(`[omem] 连接平台：${defs.size} 个平台可连接（目录里另有 ${skipped} 个用了这里不支持的写法）`);

  const platform = (name: string) => {
    const id = name.replace(new RegExp(`^${api.id}-`), "");
    const d = defs.get(id);
    if (!d) throw new Error(`没有平台 ${name}：用 connect_list 看已经连接的平台`);
    return d;
  };
  const connected = async (ctx: PluginContext, d: Def) => {
    const c = await ctx.connection(`${api.id}-${d.id}`);
    if (!c) throw new Error(`本人还没有连接${d.label}：请本人在 omem 的账号页“已连接的应用”里连接（主人要先在 设置 → 成员 → 平台应用 打开它）`);
    return c;
  };

  api.tool({
    name: "connect_list",
    description: "列出本人已经连接的平台（Notion、GitHub、Google Drive、钉钉……）：每个平台的 id、账号、接口地址和接口文档。读平台内容前先用它确认连了哪些。",
    schema: z.object({ query: z.string().max(60).optional().describe("按名字筛选，如 notion、日历") }),
    handler: async (ctx, a) => {
      const q = a.query?.toLowerCase();
      const lines: string[] = [];
      for (const d of defs.values()) {
        if (q && !d.id.includes(q) && !d.label.toLowerCase().includes(q) && !d.group.includes(q)) continue;
        const c = await ctx.connection(`${api.id}-${d.id}`);
        if (c) lines.push(`- ${d.id}（${d.label}，${d.group}）账号 ${c.account || "—"}；接口 ${c.base ?? "未设置"}${d.docs ? `；文档 ${d.docs}` : ""}`);
      }
      return lines.length ? lines.join("\n") : `本人还没有连接${q ? `和“${a.query}”有关的` : "任何"}平台。连接在 omem 的账号页“已连接的应用”里做。`;
    },
  });

  api.tool({
    name: "connect_request",
    description:
      "以本人的身份读一个已连接平台的接口：路径相对该平台的接口地址（connect_list 里的），宿主带上本人的令牌。只能读：GET；POST 只用于搜索、查询和 GraphQL query（不能 mutation）。翻页按平台文档带游标或页码，响应头里的 link 会一并返回。",
    schema: z.object({
      provider: z.string().describe("平台 id，如 notion、github、google-drive"),
      path: z.string().min(1).max(2000).describe("接口路径，如 /v1/search、/repos/acme/app/issues"),
      method: z.enum(["GET", "POST", "HEAD"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("查询参数"),
      body: z.unknown().optional().describe("POST 的 JSON 请求体"),
      max_chars: z.number().int().min(500).max(60000).default(20000).describe("最多返回多少字符"),
    }),
    handler: async (ctx, a) => {
      const d = platform(a.provider);
      if (a.method === "POST" && !readOnlyPost(d, a.path, a.body)) throw new Error(`${d.label}的 ${a.path} 可能会改动内容：这里只能读（GET，或搜索、查询、GraphQL query 的 POST）`);
      const c = await connected(ctx, d);
      const path = a.path.startsWith("/") || /^https?:\/\//.test(a.path) ? a.path : `/${a.path}`;
      const url = new URL(/^https?:\/\//.test(path) ? path : `${(c.base ?? "").replace(/\/+$/, "")}${path}`);
      for (const [k, v] of Object.entries(a.query ?? {})) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
      if (a.body !== undefined) headers["content-type"] = "application/json";
      const res = await c.fetch(url.toString(), { method: a.method, headers, body: a.method === "POST" && a.body !== undefined ? JSON.stringify(a.body) : undefined });
      const type = res.headers.get("content-type") ?? "";
      const meta = [`HTTP ${res.status}`, type && `content-type: ${type}`, res.headers.get("link") && `link: ${res.headers.get("link")}`, res.headers.get("location") && `location: ${res.headers.get("location")}`].filter(Boolean).join("\n");
      if (a.method === "HEAD") return meta;
      if (type && !/json|text|xml|html|javascript|csv|markdown|yaml/i.test(type)) {
        const size = res.headers.get("content-length");
        await res.body?.cancel();
        return `${meta}\n（二进制内容${size ? ` ${size} 字节` : ""}，不能直接读；找这个平台导出文本或 Markdown 的接口）`;
      }
      let text = await res.text();
      if (/json/i.test(type) || /^[[{]/.test(text.trim())) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 1);
        } catch {}
      }
      const cut = text.length > a.max_chars;
      return `${meta}\n\n${cut ? text.slice(0, a.max_chars) : text}${cut ? `\n\n（已截断：共 ${text.length} 字符，只返回前 ${a.max_chars}；缩小范围或翻页）` : ""}`;
    },
  });

  api.tool({
    name: "connect_save",
    description:
      "把从已连接平台读到的一项内容（一篇文档、一个 issue、一段对话、一封邮件）存成原件。id 写平台上不会变的编号（如 Notion 页面 id、issue 的 owner/repo#12），同一个 id 再存是更新同一份原件。正文写整理好的纯文本或 Markdown，保留原文，不要改写成摘要。",
    schema: z.object({
      provider: z.string().describe("平台 id"),
      id: z.string().min(1).max(400).describe("这项内容在平台上的编号"),
      title: z.string().min(1).max(300),
      text: z.string().min(1).max(2_000_000).describe("正文"),
      kind: z.enum(["doc", "chat", "note"]).default("doc").describe("doc：文档、工单、邮件；chat：聊天记录"),
      url: z.string().max(2000).optional().describe("在平台上打开它的链接"),
      updated_at: z.string().max(40).optional().describe("平台上的最后修改时间，下次采集时用来判断有没有变"),
      space: z.string().optional().describe("存进哪个空间，默认当前空间"),
    }),
    write: true,
    handler: async (ctx, a) => {
      const d = platform(a.provider);
      if (!ctx.saveSource) throw new Error("这里不能保存原件");
      const r = ctx.saveSource({ space: a.space, kind: a.kind, uri: `${d.id}:${a.id}`, title: a.title, text: a.text, meta: { provider: d.id, url: a.url, platformUpdatedAt: a.updated_at } });
      return `${r.created ? "已新建" : r.changed ? "已更新" : "没有变化"}：${a.title}（原件 ${r.id}，空间 ${r.space}）`;
    },
  });
}
