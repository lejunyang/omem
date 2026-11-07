import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * Jira and Confluence Cloud (docs/v2/connectors.md), through api.atlassian.com: a site is found among
 * the ones the connection may use (the first, or the one named before a slash). A Jira issue with its
 * comments (Atlassian Document Format as Markdown), a JQL search watched by issues updated since; a
 * Confluence page with its footer comments, a space watched by pages modified since.
 */
type Site = { id: string; url: string; name: string };

async function call<T>(c: PluginConnection, path: string): Promise<T> {
  const r = await c.fetch(path, { headers: { accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Atlassian ${path.split("?")[0]}：HTTP ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t) as T;
}

/** The site an id names (`acme/ACME-12` → acme.atlassian.net), else the first the connection may use; and the rest of the id. */
async function site(c: PluginConnection, id: string): Promise<{ site: Site; rest: string }> {
  const sites = await call<Site[]>(c, "/oauth/token/accessible-resources");
  if (!sites.length) throw new Error("这个连接没有可用的 Atlassian 站点");
  const slash = id.indexOf("/");
  const named = slash > 0 ? id.slice(0, slash) : "";
  const hit = named ? sites.find((s) => s.name === named || new URL(s.url).hostname.split(".")[0] === named || s.id === named) : null;
  return hit ? { site: hit, rest: id.slice(slash + 1) } : { site: sites[0], rest: id };
}

type Adf = { type: string; text?: string; content?: Adf[]; attrs?: Record<string, any>; marks?: { type: string; attrs?: Record<string, any> }[] };
/** Atlassian Document Format as Markdown (what Jira descriptions and comments are written in). */
export function adf(node: Adf | null | undefined, indent = ""): string {
  if (!node) return "";
  const inner = (n: Adf, sep = "") => (n.content ?? []).map((x) => adf(x, indent)).join(sep);
  switch (node.type) {
    case "doc":
      return inner(node, "\n\n").trim();
    case "text": {
      const link = node.marks?.find((m) => m.type === "link")?.attrs?.href;
      const code = node.marks?.some((m) => m.type === "code");
      const t = code ? `\`${node.text}\`` : (node.text ?? "");
      return link ? `[${t}](${link})` : t;
    }
    case "paragraph":
      return inner(node);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 2))} ${inner(node)}`;
    case "bulletList":
    case "orderedList":
      return (node.content ?? []).map((li, i) => `${indent}${node.type === "orderedList" ? `${i + 1}.` : "-"} ${(li.content ?? []).map((x) => adf(x, `${indent}  `)).join(`\n${indent}  `)}`).join("\n");
    case "taskList":
      return (node.content ?? []).map((t) => `${indent}- [${t.attrs?.state === "DONE" ? "x" : " "}] ${inner(t)}`).join("\n");
    case "codeBlock":
      return `\`\`\`${node.attrs?.language ?? ""}\n${inner(node)}\n\`\`\``;
    case "blockquote":
    case "panel":
      return inner(node, "\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "hardBreak":
      return "\n";
    case "mention":
      return String(node.attrs?.text ?? "@某人");
    case "emoji":
      return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
    case "inlineCard":
    case "blockCard":
      return String(node.attrs?.url ?? "");
    case "table": {
      const rows = (node.content ?? []).map((r) => (r.content ?? []).map((cell) => inner(cell, " ").replace(/\n/g, " ").replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const w = Math.max(...rows.map((r) => r.length));
      const fmt = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return [fmt(rows[0]), fmt(Array(w).fill("---")), ...rows.slice(1).map(fmt)].join("\n");
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "（附件）";
    default:
      return inner(node, node.content?.some((x) => x.type === "paragraph") ? "\n\n" : "");
  }
}

type Issue = { key: string; fields: { summary: string; description: Adf | null; status?: { name: string }; issuetype?: { name: string }; priority?: { name: string }; assignee?: { displayName: string } | null; reporter?: { displayName: string } | null; labels?: string[]; created: string; updated: string; parent?: { key: string }; comment?: { comments: { author?: { displayName: string }; body: Adf; created: string }[] } } };
const day = (s: string) => s.slice(0, 16).replace("T", " ");
/** JQL takes minutes, in the person's time zone; the issue's own updated time carries it. */
const jqlTime = (iso: string) => iso.slice(0, 16).replace("T", " ");

type Page = { id: string; title: string; spaceId?: string; version?: { createdAt: string; number: number }; body?: { storage?: { value: string } }; _links?: { webui?: string } };

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-jira",
    features: [{ id: "read", label: "读 issue", description: "读你能看到的 Jira issue 和评论", scopes: ["read:jira-work", "read:jira-user", "offline_access"] }],
    syncMinutes: 30,
    guide: "issue 写 issue 号（如 ACME-12）；jql 写一条 JQL（如 project = ACME），盯着它会同步之后改过的 issue（第一次取最近 30 天）。有几个站点时在前面加 站点名/，如 acme/ACME-12。",
    readers: [
      {
        kind: "issue",
        label: "issue",
        id: "issue 号，如 ACME-12",
        async read(c, id): Promise<PlatformDoc> {
          const { site: s, rest } = await site(c, id.trim());
          const key = /browse\/([A-Z][A-Z0-9_]+-\d+)/.exec(rest)?.[1] ?? rest;
          const i = await call<Issue>(c, `/ex/jira/${s.id}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,assignee,reporter,labels,created,updated,parent,comment`);
          const f = i.fields;
          const head = [
            `- ${f.issuetype?.name ?? "issue"} · ${f.status?.name ?? ""}${f.priority ? ` · 优先级 ${f.priority.name}` : ""}`,
            `- 报告人 ${f.reporter?.displayName ?? "—"} · 负责人 ${f.assignee?.displayName ?? "未分配"} · 创建于 ${day(f.created)}`,
            f.parent ? `- 上级：${f.parent.key}` : "",
            f.labels?.length ? `- 标签：${f.labels.join("、")}` : "",
          ].filter(Boolean);
          const talk = (f.comment?.comments ?? []).map((x) => `### ${x.author?.displayName ?? "某人"} · ${day(x.created)}\n\n${adf(x.body)}`);
          return { id: id.includes("/") ? `${id.slice(0, id.indexOf("/"))}/${i.key}` : i.key, title: `${i.key} ${f.summary}`, text: [head.join("\n"), adf(f.description) || "（没有描述）", talk.length ? `## 评论\n\n${talk.join("\n\n")}` : ""].filter(Boolean).join("\n\n"), url: `${s.url}/browse/${i.key}`, updatedAt: f.updated };
        },
      },
      {
        kind: "jql",
        label: "JQL 搜索",
        id: "一条 JQL，如 project = ACME",
        async changes(c, id, cursor) {
          const { site: s, rest } = await site(c, id.trim());
          const prefix = id.includes("/") ? `${id.slice(0, id.indexOf("/"))}/` : "";
          const jql = `(${rest}) AND updated >= ${cursor ? `"${jqlTime(cursor)}"` : "-30d"} ORDER BY updated ASC`;
          const issues: { key: string; fields: { updated: string } }[] = [];
          let token: string | undefined;
          do {
            const r = await call<{ issues: { key: string; fields: { updated: string } }[]; nextPageToken?: string; isLast?: boolean }>(c, `/ex/jira/${s.id}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=updated&maxResults=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`);
            issues.push(...r.issues);
            token = !r.isLast && issues.length < 500 ? r.nextPageToken : undefined;
          } while (token);
          const fresh = issues.filter((i) => !cursor || i.fields.updated > cursor);
          return { items: fresh.map((i) => ({ kind: "issue", id: `${prefix}${i.key}`, cursor: i.fields.updated })), cursor: fresh.at(-1)?.fields.updated ?? cursor };
        },
      },
    ],
  });

  api.platform({
    provider: "connect-confluence",
    features: [{ id: "read", label: "读页面", description: "读你能看到的 Confluence 页面和评论", scopes: ["read:page:confluence", "read:space:confluence", "read:comment:confluence", "offline_access"] }],
    syncMinutes: 60,
    guide: "page 写页面 id（页面链接 /pages/ 后面的数字）；space 写空间 key（链接 /spaces/ 后面那段），盯着它会同步之后改过的页面。有几个站点时在前面加 站点名/。",
    readers: [
      {
        kind: "page",
        label: "页面",
        id: "页面 id 或链接",
        async read(c, id): Promise<PlatformDoc> {
          const { site: s, rest } = await site(c, id.trim());
          const pid = /\/pages\/(\d+)/.exec(rest)?.[1] ?? rest;
          const base = `/ex/confluence/${s.id}/wiki/api/v2`;
          const p = await call<Page>(c, `${base}/pages/${pid}?body-format=storage`);
          const comments = await call<{ results: { body?: { storage?: { value: string } }; version?: { createdAt: string } }[] }>(c, `${base}/pages/${pid}/footer-comments?body-format=storage&limit=100`).catch(() => ({ results: [] }));
          const talk = comments.results.map((x) => `### ${x.version ? day(x.version.createdAt) : ""}\n\n${api.text.html(x.body?.storage?.value ?? "")}`);
          return { id: id.includes("/") && !/^https?:/.test(id) ? `${id.slice(0, id.indexOf("/"))}/${pid}` : pid, title: p.title, text: [api.text.html(p.body?.storage?.value ?? "") || "（空页面）", talk.length ? `## 评论\n\n${talk.join("\n\n")}` : ""].filter(Boolean).join("\n\n"), url: p._links?.webui ? `${s.url}/wiki${p._links.webui}` : undefined, updatedAt: p.version?.createdAt };
        },
      },
      {
        kind: "space",
        label: "空间",
        id: "空间 key",
        async changes(c, id, cursor) {
          const { site: s, rest } = await site(c, id.trim());
          const base = `/ex/confluence/${s.id}/wiki/api/v2`;
          const sp = (await call<{ results: { id: string }[] }>(c, `${base}/spaces?keys=${encodeURIComponent(rest)}`)).results[0];
          if (!sp) throw new Error(`没有空间 ${rest}`);
          const pages: Page[] = [];
          let next: string | undefined = `${base}/spaces/${sp.id}/pages?sort=-modified-date&limit=100`;
          while (next) {
            const r: { results: Page[]; _links?: { next?: string } } = await call(c, next);
            pages.push(...r.results);
            const older = cursor && r.results.some((p) => (p.version?.createdAt ?? "") <= cursor);
            next = r._links?.next && !older && pages.length < 500 ? `/ex/confluence/${s.id}${r._links.next}` : undefined;
          }
          const fresh = pages.filter((p) => p.version?.createdAt && (!cursor || p.version.createdAt > cursor)).sort((a, b) => a.version!.createdAt.localeCompare(b.version!.createdAt));
          const prefix = id.includes("/") ? `${id.slice(0, id.indexOf("/"))}/` : "";
          return { items: fresh.map((p) => ({ kind: "page", id: `${prefix}${p.id}`, cursor: p.version!.createdAt })), cursor: fresh.at(-1)?.version?.createdAt ?? cursor };
        },
      },
    ],
  });
}
