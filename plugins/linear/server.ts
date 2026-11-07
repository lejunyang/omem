import type { PlatformDoc, PluginApi, PluginConnection } from "../../src/plugins/types.ts";

/**
 * Linear (docs/v2/connectors.md): an issue with its comments, and a team watched by the issues
 * updated since the last time. Everything goes through Linear's GraphQL API, queries only.
 */
async function gql<T>(c: PluginConnection, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await c.fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = (await r.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!r.ok || body.errors?.length || !body.data) throw new Error(`Linear：${body.errors?.map((e) => e.message).join("；") || `HTTP ${r.status}`}`);
  return body.data;
}

type Issue = {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  priorityLabel?: string;
  state?: { name: string };
  team?: { key: string; name: string };
  assignee?: { name: string } | null;
  creator?: { name: string } | null;
  labels?: { nodes: { name: string }[] };
  comments?: { nodes: { body: string; createdAt: string; user?: { name: string } | null }[] };
};
const day = (s: string) => s.slice(0, 16).replace("T", " ");

export default function register(api: PluginApi) {
  api.platform({
    provider: "connect-linear",
    features: [{ id: "read", label: "读 issue", description: "读你能看到的 Linear issue 和评论", scopes: ["read"] }],
    syncMinutes: 30,
    guide: "issue 写 issue 号（如 ENG-123）或链接；team 写团队的 key（issue 号前面那段，如 ENG），盯着它会同步之后改过的 issue（第一次取最近 30 天）。",
    readers: [
      {
        kind: "issue",
        label: "issue",
        id: "issue 号，如 ENG-123",
        async read(c, id): Promise<PlatformDoc | null> {
          const key = /linear\.app\/[^/]+\/issue\/([A-Z0-9]+-\d+)/i.exec(id)?.[1] ?? id.trim();
          const { issue: i } = await gql<{ issue: Issue | null }>(
            c,
            `query($id: String!) { issue(id: $id) { identifier title description url createdAt updatedAt priorityLabel state { name } team { key name } assignee { name } creator { name } labels { nodes { name } } comments(first: 100) { nodes { body createdAt user { name } } } } }`,
            { id: key },
          );
          if (!i) return null;
          const head = [
            `- ${i.team?.name ?? ""} · ${i.state?.name ?? ""}${i.priorityLabel ? ` · ${i.priorityLabel}` : ""}`,
            `- 创建人 ${i.creator?.name ?? "—"} · 负责人 ${i.assignee?.name ?? "未分配"} · ${day(i.createdAt)}`,
            i.labels?.nodes.length ? `- 标签：${i.labels.nodes.map((l) => l.name).join("、")}` : "",
          ].filter(Boolean);
          const talk = [...(i.comments?.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((x) => `### ${x.user?.name ?? "某人"} · ${day(x.createdAt)}\n\n${x.body.trim()}`);
          return { id: i.identifier, title: `${i.identifier} ${i.title}`, text: [head.join("\n"), i.description?.trim() || "（没有描述）", talk.length ? `## 评论\n\n${talk.join("\n\n")}` : ""].filter(Boolean).join("\n\n"), url: i.url, updatedAt: i.updatedAt };
        },
      },
      {
        kind: "team",
        label: "团队",
        id: "团队 key，如 ENG",
        async changes(c, id, cursor) {
          const since = cursor ?? new Date(Date.now() - 30 * 86400_000).toISOString();
          const list: { identifier: string; updatedAt: string }[] = [];
          let after: string | null = null;
          do {
            const r: { issues: { nodes: { identifier: string; updatedAt: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
              c,
              `query($key: String!, $since: DateTimeOrDuration!, $after: String) { issues(first: 100, after: $after, orderBy: updatedAt, filter: { team: { key: { eq: $key } }, updatedAt: { gt: $since } }) { nodes { identifier updatedAt } pageInfo { hasNextPage endCursor } } }`,
              { key: id.trim(), since, after },
            );
            list.push(...r.issues.nodes);
            after = r.issues.pageInfo.hasNextPage && list.length < 500 ? r.issues.pageInfo.endCursor : null;
          } while (after);
          list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
          return { items: list.map((i) => ({ kind: "issue", id: i.identifier, cursor: i.updatedAt })), cursor: list.at(-1)?.updatedAt ?? cursor };
        },
      },
    ],
  });
}
