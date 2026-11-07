import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * Notion (docs/v2/connectors.md): a page as Markdown, its blocks read level by level (headings, lists,
 * to-dos, toggles, quotes, code, tables; child pages as links). A database or the whole workspace the
 * connection was given is watched by the pages edited since the last time.
 */
type Rich = { plain_text: string; href?: string | null }[];
type Block = { id: string; type: string; has_children: boolean; [k: string]: any };
type Page = { id: string; url: string; last_edited_time: string; properties: Record<string, { type: string; title?: Rich }> };

async function call<T>(c: PluginConnection, path: string, body?: unknown): Promise<T> {
  const r = await c.fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Notion ${path.split("?")[0]}：HTTP ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t) as T;
}

const rich = (r: Rich | undefined) => (r ?? []).map((t) => (t.href && t.plain_text.trim() && t.href !== t.plain_text ? `[${t.plain_text}](${t.href})` : t.plain_text)).join("");
export const pageTitle = (p: Page) => rich(Object.values(p.properties ?? {}).find((v) => v.type === "title")?.title) || "（无标题）";
/** A page id from an id or a link (the 32 hex characters at the end). */
export const pageId = (id: string) => /([0-9a-f]{32})(?:[?#].*)?$/i.exec(id.replace(/-/g, ""))?.[1] ?? id.trim();

const MAX_BLOCKS = 3000;

/** The blocks under a page or block as Markdown lines, `depth` levels deep. */
export async function blocksMarkdown(c: PluginConnection, id: string, indent = "", depth = 0, seen = { n: 0 }): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  let number = 0;
  do {
    const r = await call<{ results: Block[]; has_more: boolean; next_cursor: string | null }>(c, `/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of r.results) {
      if (++seen.n > MAX_BLOCKS) return [...out, `${indent}（内容太长，后面的没有读）`];
      const v = b[b.type] ?? {};
      const text = rich(v.rich_text);
      number = b.type === "numbered_list_item" ? number + 1 : 0;
      const line: Record<string, string | null> = {
        paragraph: text,
        heading_1: `# ${text}`,
        heading_2: `## ${text}`,
        heading_3: `### ${text}`,
        bulleted_list_item: `- ${text}`,
        numbered_list_item: `${number}. ${text}`,
        to_do: `- [${v.checked ? "x" : " "}] ${text}`,
        toggle: `- ${text}`,
        quote: `> ${text}`,
        callout: `> ${v.icon?.emoji ?? ""} ${text}`.trim(),
        code: `\`\`\`${v.language ?? ""}\n${text}\n\`\`\``,
        divider: "---",
        equation: `$$${v.expression ?? ""}$$`,
        child_page: `- 子页面：${v.title ?? ""}（notion page ${b.id.replace(/-/g, "")}）`,
        child_database: `- 数据库：${v.title ?? ""}（notion database ${b.id.replace(/-/g, "")}）`,
        bookmark: v.url ? `[${rich(v.caption) || v.url}](${v.url})` : null,
        link_preview: v.url ?? null,
        image: `（图片${rich(v.caption) ? `：${rich(v.caption)}` : ""}）`,
        file: `（附件${v.name ? `：${v.name}` : ""}）`,
        pdf: "（PDF 附件）",
        video: "（视频）",
        table: null,
        table_row: null,
      };
      if (b.type === "table") {
        const rows = (await call<{ results: Block[] }>(c, `/v1/blocks/${b.id}/children?page_size=100`)).results.map((row) => (row.table_row?.cells ?? []).map((cell: Rich) => rich(cell).replace(/\|/g, "\\|")));
        if (rows.length) {
          const w = Math.max(...rows.map((r) => r.length));
          const fmt = (r: string[]) => `${indent}| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
          out.push(fmt(rows[0]), fmt(Array(w).fill("---")), ...rows.slice(1).map(fmt), "");
        }
        continue;
      }
      const l = line[b.type];
      if (l === undefined) {
        if (text) out.push(`${indent}${text}`);
      } else if (l !== null) out.push(...l.split("\n").map((x) => `${indent}${x}`));
      const nested = b.has_children && b.type !== "child_page" && b.type !== "child_database";
      if (nested && depth < 5) out.push(...(await blocksMarkdown(c, b.id, `${indent}  `, depth + 1, seen)));
      if (!/list_item|to_do|toggle/.test(b.type)) out.push("");
    }
    cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

/** Pages edited after the cursor, oldest first. */
function edited(pages: Page[], cursor: string | null) {
  const list = pages.filter((p) => !cursor || p.last_edited_time > cursor).sort((a, b) => a.last_edited_time.localeCompare(b.last_edited_time));
  return { items: list.map((p) => ({ kind: "page", id: p.id.replace(/-/g, ""), cursor: p.last_edited_time })), cursor: list.at(-1)?.last_edited_time ?? cursor };
}

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-notion",
    syncMinutes: 60,
    guide: "Notion 只给授权时选中的页面（及其子页面）。page、database 的 id 是链接末尾的 32 位字符（直接给链接也行）；workspace 的 id 写 all，指授权给 omem 的全部页面。",
    readers: [
      {
        kind: "page",
        label: "页面",
        id: "页面 id 或链接",
        async read(c, id): Promise<PlatformDoc> {
          const pid = pageId(id);
          const page = await call<Page>(c, `/v1/pages/${pid}`);
          const props = Object.entries(page.properties ?? {})
            .filter(([, v]) => v.type !== "title")
            .map(([k, v]) => {
              const x = (v as any)[v.type];
              const val = Array.isArray(x) ? (x[0]?.plain_text !== undefined ? rich(x) : x.map((i: any) => i.name ?? i.plain_text ?? "").join("、")) : (x?.name ?? x?.start ?? (typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : ""));
              return val ? `- ${k}：${val}` : "";
            })
            .filter(Boolean);
          const body = (await blocksMarkdown(c, pid)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
          return { id: pid, title: pageTitle(page), text: [props.join("\n"), body].filter(Boolean).join("\n\n") || "（空页面）", url: page.url, updatedAt: page.last_edited_time };
        },
      },
      {
        kind: "database",
        label: "数据库",
        id: "数据库 id 或链接",
        async changes(c, id, cursor) {
          const pages: Page[] = [];
          let start: string | undefined;
          do {
            const r = await call<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(c, `/v1/databases/${pageId(id)}/query`, {
              page_size: 100,
              sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
              ...(cursor ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: cursor } } } : {}),
              ...(start ? { start_cursor: start } : {}),
            });
            pages.push(...r.results);
            start = r.has_more && pages.length < 500 ? (r.next_cursor ?? undefined) : undefined;
          } while (start);
          return edited(pages, cursor);
        },
      },
      {
        kind: "workspace",
        label: "授权的全部页面",
        id: "all",
        async changes(c, _id, cursor) {
          const pages: Page[] = [];
          let start: string | undefined;
          do {
            const r = await call<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(c, "/v1/search", { page_size: 100, filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, ...(start ? { start_cursor: start } : {}) });
            pages.push(...r.results);
            // Newest first: stop once past what was seen.
            const older = cursor && r.results.some((p) => p.last_edited_time <= cursor);
            start = r.has_more && !older && pages.length < 500 ? (r.next_cursor ?? undefined) : undefined;
          } while (start);
          return edited(pages, cursor);
        },
      },
    ],
  });
}
