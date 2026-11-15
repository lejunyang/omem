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

export function pullRequestMatch(url: string) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}#${Number(m[3])}` : null;
}

/**
 * Merge a pull request as the person who connected GitHub (the button on the item page, or an agent
 * under the tool's approval rung). GitHub says no when checks or reviews the branch requires are
 * missing, or the branch conflicts: that answer is passed on as it is.
 */
export async function mergePullRequest(c: PluginConnection, pr: string, method: "merge" | "squash" | "rebase" = "merge") {
  const { owner, repo, n } = issueRef(pr);
  if (c.scopes.length && !c.scopes.some((s) => s === "repo" || s === "public_repo")) throw new Error("合并要 GitHub 的 repo 权限：在账号页给 GitHub 打开“合并 PR”再试");
  const r = await c.fetch(`/repos/${owner}/${repo}/pulls/${n}/merge`, {
    method: "PUT",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
    body: JSON.stringify({ merge_method: method }),
  });
  const t = await r.text();
  let body: { merged?: boolean; sha?: string; message?: string } = {};
  try { body = JSON.parse(t); } catch { /* Not JSON: the status says enough. */ }
  if (!r.ok || body.merged === false) {
    const why = r.status === 405 ? "现在不能合并（检查没过、缺评审，或分支要求没满足）" : r.status === 409 ? "和目标分支有冲突，或头提交已经变了" : r.status === 403 || r.status === 404 ? "没有权限，或连接没有 repo 权限" : `HTTP ${r.status}`;
    throw new Error(`GitHub 没有合并 ${owner}/${repo}#${n}：${why}${body.message ? `（${body.message.slice(0, 200)}）` : ""}`);
  }
  return `已合并 ${owner}/${repo}#${n}${body.sha ? `，合并提交 ${body.sha.slice(0, 7)}` : ""}`;
}

export default function register(api: PluginApi) {
  api.tool({
    name: "github_merge_pull_request",
    description: "合并 GitHub 上的一个 PR，以连接 GitHub 的这个人的身份。pr 写 owner/repo#编号或它的链接；method 默认 merge，可选 squash、rebase。只在本人要求，或流程走到合并、检查已通过时用；GitHub 拒绝时原样告诉本人，不要换方式重试。",
    schema: api.z.object({ pr: api.z.string().min(1), method: api.z.enum(["merge", "squash", "rebase"]).optional() }),
    write: true,
    async handler(ctx, a) {
      const c = await ctx.connection("connect-github");
      if (!c) throw new Error("请先在账号页连接 GitHub");
      return mergePullRequest(c, a.pr, a.method);
    },
  });
  api.object({
    kind: "pull-request", label: "合并请求", match: pullRequestMatch,
    statuses: { open: "进行中", merged: "已合并", closed: "已关闭" }, final: ["merged", "closed"], poll: { minutes: 5 },
    actions: [{ id: "merge", label: "合并", tool: "github_merge_pull_request", arg: "pr", statuses: ["open"], confirm: "GitHub 按仓库的分支要求判断能不能合；检查没过或缺评审时会拒绝。" }],
    async read(ctx, key) {
      const c = await ctx.connection("connect-github");
      if (!c) throw new Error("请先连接 GitHub");
      const { owner, repo, n } = issueRef(key);
      const base = `/repos/${owner}/${repo}`;
      const { body: pr } = await call<{ title: string; state: string; merged_at: string | null; html_url: string; base: { ref: string }; head: { sha: string } }>(c, `${base}/pulls/${n}`);
      const fields = [{ label: "目标分支", value: pr.base.ref }];
      const checks: string[] = [];
      try {
        const { body: status } = await call<{ state: string; total_count: number }>(c, `${base}/commits/${pr.head.sha}/status`);
        if (status.total_count > 0) checks.push(status.state);
      } catch { /* Commit status is optional for connections with fewer scopes. */ }
      try {
        const { body: checksBody } = await call<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(c, `${base}/commits/${pr.head.sha}/check-runs?per_page=100`);
        if (checksBody.total_count > checksBody.check_runs.length) checks.push("pending");
        for (const check of checksBody.check_runs) checks.push(check.status === "completed" ? check.conclusion ?? "pending" : "pending");
      } catch { /* Check runs are optional as well. */ }
      if (checks.length) fields.push({ label: "检查", value: checks.some((s) => ["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"].includes(s)) ? "未通过" : checks.some((s) => !["success", "neutral", "skipped"].includes(s)) ? "进行中" : "通过" });
      try {
        const latest = new Map<string, string>();
        let complete = false;
        for (let page = 1; page <= 5; page++) {
          const { body: reviews, next } = await call<{ user: User | null; state: string }[]>(c, `${base}/pulls/${n}/reviews?per_page=100&page=${page}`);
          for (const r of reviews) if (r.user && r.state !== "PENDING") latest.set(r.user.login, r.state);
          if (!next) { complete = true; break; }
        }
        const states = [...latest.values()];
        fields.push({ label: "评审状态", value: !complete ? "评审较多，请查看原页" : states.includes("CHANGES_REQUESTED") ? "要求修改" : states.includes("APPROVED") ? "已批准" : states.length ? "已评论" : "尚无评审" });
      } catch { fields.push({ label: "评审状态", value: "无法读取" }); }
      return { title: pr.title, status: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open", link: pr.html_url, fields };
    },
  });
  api.platform({
    provider: "connect-github",
    features: [
      { id: "public", label: "读公开仓库", description: "读公开仓库的 issue、PR 和文件", scopes: ["read:user"] },
      { id: "private", label: "读私有仓库", description: "也读你能看到的私有仓库（GitHub 的 repo 权限包含写；omem 只在你点“合并”或批准时写）", scopes: ["repo"] },
      { id: "merge", label: "合并 PR", description: "在事项页的合并请求上点“合并”，或批准助手合并（用 GitHub 的 repo 权限）", scopes: ["repo"] },
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
