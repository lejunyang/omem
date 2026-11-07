import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * GitHub (docs/v2/connectors.md): an issue or pull request with its discussion, a file at a branch,
 * and a repository watched by the issues and pull requests updated since the last time.
 */
type User = { login: string };
type Issue = { number: number; title: string; body: string | null; state: string; html_url: string; user: User; labels: { name: string }[]; assignees?: User[]; created_at: string; updated_at: string; closed_at: string | null; pull_request?: unknown };
type Comment = { user: User; body: string; created_at: string };

async function call<T>(c: PluginConnection, path: string): Promise<{ body: T; next: boolean }> {
  const r = await c.fetch(path, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  const t = await r.text();
  if (!r.ok) throw new Error(`GitHub ${path.split("?")[0]}：HTTP ${r.status} ${t.slice(0, 200)}`);
  return { body: JSON.parse(t) as T, next: /rel="next"/.test(r.headers.get("link") ?? "") };
}

/** owner/repo#12 from that or a link (github.com/owner/repo/issues/12, /pull/12). */
export function issueRef(id: string) {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/.exec(id) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(id.trim());
  if (!m) throw new Error(`issue 的 id 写成 owner/repo#编号：${id}`);
  return { owner: m[1], repo: m[2], n: Number(m[3]) };
}
const repoRef = (id: string) => {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(id.trim());
  if (!m) throw new Error(`仓库写成 owner/repo：${id}`);
  return { owner: m[1], repo: m[2] };
};
const day = (s: string) => s.slice(0, 16).replace("T", " ");

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-github",
    features: [
      { id: "public", label: "读公开仓库", description: "读公开仓库的 issue、PR 和文件", scopes: ["read:user"] },
      { id: "private", label: "读私有仓库", description: "也读你能看到的私有仓库（GitHub 的 repo 权限包含写，omem 只读）", scopes: ["repo"] },
    ],
    syncMinutes: 30,
    guide: "issue 写 owner/repo#编号（PR 也是）；repo 写 owner/repo，盯着它会同步改过的 issue 和 PR；file 写 owner/repo/路径，要某个分支加 @分支。",
    readers: [
      {
        kind: "issue",
        label: "issue 或 PR",
        id: "owner/repo#编号，或它的链接",
        async read(c, id): Promise<PlatformDoc> {
          const { owner, repo, n } = issueRef(id);
          const { body: i } = await call<Issue>(c, `/repos/${owner}/${repo}/issues/${n}`);
          const comments: Comment[] = [];
          for (let page = 1; page <= 5; page++) {
            const r = await call<Comment[]>(c, `/repos/${owner}/${repo}/issues/${n}/comments?per_page=100&page=${page}`);
            comments.push(...r.body);
            if (!r.next) break;
          }
          const head = [
            `- ${i.pull_request ? "PR" : "issue"}，${i.state === "open" ? "未关闭" : `已关闭${i.closed_at ? `（${day(i.closed_at)}）` : ""}`}`,
            `- 作者 ${i.user.login} · ${day(i.created_at)}`,
            i.assignees?.length ? `- 负责人：${i.assignees.map((a) => a.login).join("、")}` : "",
            i.labels.length ? `- 标签：${i.labels.map((l) => l.name).join("、")}` : "",
          ].filter(Boolean);
          const talk = comments.map((x) => `### ${x.user.login} · ${day(x.created_at)}\n\n${x.body.trim()}`);
          return { id: `${owner}/${repo}#${n}`, title: `${owner}/${repo}#${n} ${i.title}`, text: [head.join("\n"), i.body?.trim() || "（没有描述）", talk.length ? `## 讨论\n\n${talk.join("\n\n")}` : ""].filter(Boolean).join("\n\n"), url: i.html_url, updatedAt: i.updated_at };
        },
      },
      {
        kind: "repo",
        label: "仓库的 issue 和 PR",
        id: "owner/repo",
        async changes(c, id, cursor) {
          const { owner, repo } = repoRef(id);
          // The first time, the last 30 days; after that, what was updated since.
          const since = cursor ?? new Date(Date.now() - 30 * 86400_000).toISOString();
          const list: Issue[] = [];
          for (let page = 1; page <= 5; page++) {
            const r = await call<Issue[]>(c, `/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&page=${page}&since=${encodeURIComponent(since)}`);
            list.push(...r.body);
            if (!r.next) break;
          }
          const fresh = list.filter((i) => !cursor || i.updated_at > cursor);
          return { items: fresh.map((i) => ({ kind: "issue", id: `${owner}/${repo}#${i.number}`, cursor: i.updated_at })), cursor: fresh.at(-1)?.updated_at ?? cursor };
        },
      },
      {
        kind: "file",
        label: "文件",
        id: "owner/repo/路径，可加 @分支",
        async read(c, id): Promise<PlatformDoc | null> {
          const m = /^([\w.-]+)\/([\w.-]+)\/(.+?)(?:@([\w./-]+))?$/.exec(id.trim());
          if (!m) throw new Error(`文件写成 owner/repo/路径[@分支]：${id}`);
          const [, owner, repo, path, ref] = m;
          const { body: f } = await call<{ type: string; content?: string; encoding?: string; size: number; html_url: string; sha: string }>(c, `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
          if (f.type !== "file" || f.encoding !== "base64" || !f.content) return null;
          const buf = Buffer.from(f.content, "base64");
          // Binary files (a NUL in the first bytes) have no text to keep.
          if (buf.subarray(0, 8000).includes(0)) return null;
          return { title: `${owner}/${repo}/${path}${ref ? `@${ref}` : ""}`, text: buf.toString("utf8"), url: f.html_url };
        },
      },
    ],
  });
}
