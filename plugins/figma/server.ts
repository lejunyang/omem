import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * Figma (docs/v2/connectors.md): a design file as text: its pages, the frames on each page with the
 * text in them and the components they hold, then the comments, placed on the frame they point at.
 * A project or a team is watched by the files in it that changed.
 */
type Node = { id: string; name: string; type: string; visible?: boolean; characters?: string; children?: Node[] };
type File = { name: string; lastModified: string; version?: string; document: Node };
type Comment = { id: string; message: string; created_at: string; resolved_at?: string | null; parent_id?: string; user?: { handle?: string }; client_meta?: { node_id?: string } };

async function json<T>(c: PluginConnection, path: string): Promise<T> {
  const r = await c.fetch(path, { headers: { accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) throw Object.assign(new Error(`Figma ${path.split("?")[0]}：HTTP ${r.status} ${t.slice(0, 200)}`), { status: r.status });
  return JSON.parse(t) as T;
}

/** A file key from a key or a link (figma.com/file/<key>/…, /design/<key>/…). */
export const fileKey = (id: string) => /figma\.com\/(?:file|design|board|proto)\/([\w-]+)/.exec(id)?.[1] ?? id.trim();

const FRAMES = new Set(["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "GROUP", "INSTANCE"]);

/** The file's pages and frames with their text; `where` maps every node to its frame for placing comments. */
export function outline(file: File) {
  const lines: string[] = [];
  const where = new Map<string, string>();
  const texts = (n: Node, frame: string, out: string[], components: Set<string>) => {
    if (n.visible === false) return;
    where.set(n.id, frame);
    if (n.type === "TEXT" && n.characters?.trim()) out.push(n.characters.trim().replace(/\n+/g, " / "));
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") components.add(n.name);
    for (const c of n.children ?? []) texts(c, frame, out, components);
  };
  for (const page of file.document.children ?? []) {
    if (page.visible === false) continue;
    lines.push(`## ${page.name}`, "");
    where.set(page.id, page.name);
    const loose: string[] = [];
    for (const n of page.children ?? []) {
      if (!FRAMES.has(n.type)) {
        texts(n, page.name, loose, new Set());
        continue;
      }
      const out: string[] = [];
      const components = new Set<string>();
      texts(n, n.name, out, components);
      if (!out.length && !components.size) continue;
      lines.push(`### ${n.name}`, "");
      for (const t of [...new Set(out)]) lines.push(`- ${t}`);
      if (components.size) lines.push(`- 组件：${[...components].join("、")}`);
      lines.push("");
    }
    if (loose.length) lines.push("### （画框以外的文字）", "", ...[...new Set(loose)].map((t) => `- ${t}`), "");
  }
  return { text: lines.join("\n").trim(), where };
}

export function commentsText(comments: Comment[], where: Map<string, string>) {
  const top = comments.filter((c) => !c.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const replies = (id: string) => comments.filter((c) => c.parent_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const line = (c: Comment) => `${c.user?.handle ?? "某人"} · ${c.created_at.slice(0, 16).replace("T", " ")}：${c.message.trim().replace(/\n+/g, " ")}`;
  return top
    .map((c) => {
      const at = c.client_meta?.node_id ? where.get(c.client_meta.node_id) : undefined;
      return [`- ${line(c)}${at ? `（在“${at}”）` : ""}${c.resolved_at ? "（已解决）" : ""}`, ...replies(c.id).map((r) => `  - ${line(r)}`)].join("\n");
    })
    .join("\n");
}

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-figma",
    features: [
      { id: "design", label: "读设计稿", description: "读你能看到的 Figma 文件：页面、画框里的文字和组件", scopes: ["current_user:read", "file_content:read", "file_metadata:read"] },
      { id: "comments", label: "读评论", description: "连同文件上的评论一起读", scopes: ["file_comments:read"] },
      { id: "projects", label: "读项目和团队的文件列表", description: "盯着一个项目或团队时，找出里面改过的文件", scopes: ["projects:read"] },
    ],
    syncMinutes: 120,
    guide: "file 的 id 是文件链接里 /file/ 或 /design/ 后面那段（直接给链接也行）；project、team 的 id 在 Figma 网页地址 …/team/<团队 id>/project/<项目 id> 里。",
    readers: [
      {
        kind: "file",
        label: "设计文件",
        id: "文件 key 或文件链接",
        async read(c, id): Promise<PlatformDoc> {
          const key = fileKey(id);
          const file = await json<File>(c, `/v1/files/${encodeURIComponent(key)}`);
          const { text, where } = outline(file);
          let comments = "";
          try {
            const r = await json<{ comments: Comment[] }>(c, `/v1/files/${encodeURIComponent(key)}/comments`);
            if (r.comments.length) comments = `\n\n## 评论\n\n${commentsText(r.comments, where)}`;
          } catch (e) {
            // Without the comments scope the file still reads.
            if ((e as { status?: number }).status !== 403) throw e;
          }
          return { id: key, title: file.name, text: `${text || "（文件里没有文字）"}${comments}`, url: `https://www.figma.com/design/${key}`, updatedAt: file.lastModified };
        },
      },
      {
        kind: "project",
        label: "项目",
        id: "项目 id",
        async changes(c, id, cursor) {
          const r = await json<{ files: { key: string; last_modified: string }[] }>(c, `/v1/projects/${encodeURIComponent(id)}/files`);
          return changed(r.files, cursor);
        },
      },
      {
        kind: "team",
        label: "团队",
        id: "团队 id",
        async changes(c, id, cursor) {
          const { projects } = await json<{ projects: { id: string }[] }>(c, `/v1/teams/${encodeURIComponent(id)}/projects`);
          const files: { key: string; last_modified: string }[] = [];
          for (const p of projects) files.push(...(await json<{ files: { key: string; last_modified: string }[] }>(c, `/v1/projects/${p.id}/files`)).files);
          return changed(files, cursor);
        },
      },
    ],
  });
}

/** Files modified after the cursor, oldest first, each with its own time as the place to continue. */
function changed(files: { key: string; last_modified: string }[], cursor: string | null) {
  const list = files.filter((f) => !cursor || f.last_modified > cursor).sort((a, b) => a.last_modified.localeCompare(b.last_modified));
  return { items: list.map((f) => ({ kind: "file", id: f.key, cursor: f.last_modified })), cursor: list.at(-1)?.last_modified ?? cursor };
}
