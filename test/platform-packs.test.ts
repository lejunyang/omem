import { afterAll, describe, expect, it } from "vitest";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { featuresOf } from "../src/auth/features.ts";
import { setAppConfig } from "../src/auth/apps.ts";
import { beginLogin } from "../src/auth/login.ts";
import { setAuthFetchForTests } from "../src/auth/providers.ts";
import { storeConnection } from "../src/auth/vault.ts";
import { all, one } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { listWatches, syncWatches } from "../src/plugins/platforms.ts";
import { loadPlugins } from "../src/plugins/registry.ts";
import { adf } from "../plugins/atlassian/server.ts";
import { mailBody } from "../plugins/google/server.ts";
import { htmlToMarkdown } from "../src/sources/html.ts";
import { testApp } from "./helpers.ts";

/**
 * Platform packs (docs/v2/connectors.md): a platform's own features and scopes, readers that turn its
 * things into Markdown sources, and watches kept in sync from where they stopped.
 */
type Call = { url: string; method: string; body: string; headers: Headers };
const calls: Call[] = [];
let routes: [RegExp, (c: Call) => unknown][] = [];
setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
  const c = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "", headers: new Headers(init?.headers) };
  calls.push(c);
  const hit = routes.find(([re]) => re.test(c.url));
  if (!hit) return new Response(`no route ${c.url}`, { status: 404 });
  const v = hit[1](c);
  return v instanceof Response ? v : new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
}) as typeof fetch);

describe("platform packs", async () => {
  const app = testApp();
  afterAll(() => setAuthFetchForTests(null));
  await loadPlugins(app);
  createUser(app, { name: "小安", id: "ann" });
  const connect = (provider: string) => storeConnection(app, { userId: "ann", provider, accountId: "a", accountName: "小安", scopes: [], accessToken: `tok-${provider}`, expiresIn: 3600 });
  const ctx = () => toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal-ann", spaces: null, tools: null, actor: "agent", userId: "ann" }))!;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await callTool(ctx(), name, args);
    if (r.isError) throw new Error(r.text);
    return r.text;
  };

  it("gives a platform its own features, each asking for its scopes", () => {
    expect(featuresOf("connect-figma").map((f) => f.id)).toEqual(["design", "comments", "projects"]);
    setAppConfig(app, "connect-figma", { clientId: "fid", clientSecret: "fsec" });
    const url = new URL(beginLogin(app, { provider: "connect-figma", purpose: "connect", redirectUri: "https://omem.test/cb", userId: "ann", scopes: ["file_content:read", "file_comments:read"] }));
    // Figma separates scopes with commas.
    expect(url.searchParams.get("scope")).toContain("file_content:read,file_comments:read");
  });

  it("reads a Figma file as pages, frames, their text and the comments on them", async () => {
    connect("connect-figma");
    routes = [
      [/api\.figma\.com\/v1\/files\/K1\/comments/, () => ({ comments: [{ id: "c1", message: "按钮再大一点", created_at: "2026-11-01T10:00:00Z", user: { handle: "小王" }, client_meta: { node_id: "2:1" } }, { id: "c2", parent_id: "c1", message: "好", created_at: "2026-11-01T11:00:00Z", user: { handle: "小安" } }] })],
      [
        /api\.figma\.com\/v1\/files\/K1$/,
        () => ({
          name: "退款流程",
          lastModified: "2026-11-02T00:00:00Z",
          document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "1:0", name: "首页", type: "CANVAS", children: [{ id: "2:0", name: "申请退款", type: "FRAME", children: [{ id: "2:1", name: "按钮", type: "TEXT", characters: "提交申请" }, { id: "2:2", name: "隐藏", type: "TEXT", characters: "看不到", visible: false }, { id: "2:3", name: "主按钮", type: "COMPONENT", children: [] }] }] }] },
        }),
      ],
    ];
    const text = await tool("connect_read", { provider: "figma", kind: "file", id: "https://www.figma.com/design/K1/xxx", save: true });
    expect(text).toContain("# 退款流程");
    expect(text).toContain("## 首页");
    expect(text).toContain("### 申请退款");
    expect(text).toContain("- 提交申请");
    expect(text).not.toContain("看不到");
    expect(text).toContain("组件：主按钮");
    expect(text).toContain("小王 · 2026-11-01 10:00：按钮再大一点（在“申请退款”）");
    expect(text).toContain("  - 小安");
    expect(one<{ uri: string }>(app.db, "select uri from sources where uri = ?", "figma:file/K1")).toBeTruthy();
  });

  it("reads a Notion page as Markdown, nested lists, tables and child pages included", async () => {
    connect("connect-notion");
    const pid = "a".repeat(32);
    routes = [
      [new RegExp(`/v1/pages/${pid}$`), () => ({ id: pid, url: "https://notion.so/p", last_edited_time: "2026-11-03T00:00:00.000Z", properties: { 名称: { type: "title", title: [{ plain_text: "差旅报销制度" }] } } })],
      [
        new RegExp(`/v1/blocks/${pid}/children`),
        () => ({
          has_more: false,
          results: [
            { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "标准" }] } },
            { id: "b2", type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: [{ plain_text: "住宿" }] } },
            { id: "b3", type: "table", has_children: true, table: {} },
            { id: "b4", type: "child_page", has_children: true, child_page: { title: "附件说明" } },
          ],
        }),
      ],
      [/\/v1\/blocks\/b2\/children/, () => ({ has_more: false, results: [{ id: "b21", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [{ plain_text: "一线城市 600 元" }] } }] })],
      [/\/v1\/blocks\/b3\/children/, () => ({ results: [{ table_row: { cells: [[{ plain_text: "城市" }], [{ plain_text: "上限" }]] } }, { table_row: { cells: [[{ plain_text: "北京" }], [{ plain_text: "600" }]] } }] })],
    ];
    const text = await tool("connect_read", { provider: "notion", kind: "page", id: `https://www.notion.so/xx-${pid}` });
    expect(text).toContain("## 标准");
    expect(text).toContain("- 住宿\n  - 一线城市 600 元");
    expect(text).toContain("| 城市 | 上限 |\n| --- | --- |\n| 北京 | 600 |");
    expect(text).toContain("子页面：附件说明");
  });

  it("keeps a watched GitHub repository in sync from where it stopped", async () => {
    connect("connect-github");
    let updated = "2026-11-01T00:00:00Z";
    routes = [
      [/\/repos\/acme\/app\/issues\?/, (c) => (new URL(c.url).searchParams.get("since")! < updated ? [{ number: 7, updated_at: updated }] : [])],
      [/\/repos\/acme\/app\/issues\/7\/comments/, () => [{ user: { login: "wang" }, body: "复现了", created_at: "2026-11-01T01:00:00Z" }]],
      [/\/repos\/acme\/app\/issues\/7$/, () => ({ number: 7, title: "退款超时", body: "偶发超时", state: "open", html_url: "https://github.com/acme/app/issues/7", user: { login: "ann" }, labels: [{ name: "bug" }], created_at: "2026-10-30T00:00:00Z", updated_at: updated, closed_at: null })],
    ];
    expect(await tool("connect_watch", { provider: "github", kind: "repo", target: "acme/app", title: "主仓库" })).toMatch(/已盯着/);
    await syncWatches(app, { force: true });
    const src = () => one<{ text: string }>(app.db, "select text from sources where uri = ?", "github:issue/acme/app#7");
    expect(src()?.text).toContain("## 讨论\n\n### wang");
    const w = listWatches(app, "ann")[0];
    expect(w.lastError).toBeNull();
    expect(one<{ cursor: string }>(app.db, "select cursor from platform_watches where id = ?", w.id)?.cursor).toBe(updated);
    // Nothing new: the issue is not read again.
    const reads = calls.filter((c) => /issues\/7$/.test(c.url)).length;
    await syncWatches(app, { force: true });
    expect(calls.filter((c) => /issues\/7$/.test(c.url)).length).toBe(reads);
    expect(await tool("connect_list", { query: "github" })).toContain("正在盯着");
  });

  it("refuses to watch into a space the person cannot write", async () => {
    await expect(tool("connect_watch", { provider: "github", kind: "repo", target: "acme/app", space: "personal" })).rejects.toThrow(/无权|不能/);
    expect(all(app.db, "select * from platform_watches where space_id = 'personal'")).toHaveLength(0);
  });

  it("reads a Slack day with threads and people by name", async () => {
    connect("connect-slack");
    const ts = String(new Date("2026-11-07T10:30:00").getTime() / 1000);
    routes = [
      [/\/conversations\.info/, () => ({ ok: true, channel: { name: "refund" } })],
      [/\/users\.info/, (c) => ({ ok: true, user: { name: new URL(c.url).searchParams.get("user") === "U1" ? "wang" : "ann", profile: { display_name: new URL(c.url).searchParams.get("user") === "U1" ? "小王" : "小安" } } })],
      [/\/conversations\.history/, () => ({ ok: true, has_more: false, messages: [{ ts, user: "U1", text: "<@U2> 看下这个 <https://example.com|单子>", reply_count: 1 }] })],
      [/\/conversations\.replies/, () => ({ ok: true, messages: [{ ts, user: "U1", text: "x" }, { ts: String(Number(ts) + 60), user: "U2", text: "收到" }] })],
    ];
    const text = await tool("connect_read", { provider: "slack", kind: "day", id: "C1/2026-11-07" });
    expect(text).toContain("# #refund · 2026-11-07");
    expect(text).toContain("10:30 小王：@小安 看下这个 单子（https://example.com）");
    expect(text).toContain("  ↳ 10:31 小安：收到");
    // Slack's errors come with HTTP 200.
    routes = [[/\/conversations\./, () => ({ ok: false, error: "not_in_channel" })]];
    await expect(tool("connect_read", { provider: "slack", kind: "day", id: "C2/2026-11-07" })).rejects.toThrow(/not_in_channel/);
  });

  it("reads a Linear issue through GraphQL", async () => {
    connect("connect-linear");
    routes = [[/api\.linear\.app\/graphql/, () => ({ data: { issue: { identifier: "ENG-1", title: "退款", description: "说明", url: "https://linear.app/x/issue/ENG-1", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", state: { name: "Todo" }, team: { key: "ENG", name: "工程" }, comments: { nodes: [{ body: "好", createdAt: "2026-11-01T02:00:00Z", user: { name: "小王" } }] } } } })]];
    const text = await tool("connect_read", { provider: "linear", kind: "issue", id: "ENG-1" });
    expect(text).toContain("# ENG-1 退款");
    expect(text).toContain("### 小王");
    expect(JSON.parse(calls.at(-1)!.body).variables).toEqual({ id: "ENG-1" });
  });

  it("turns Jira's document format, mail bodies and HTML into Markdown", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "步骤" }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "打开" }, { type: "text", text: "页面", marks: [{ type: "link", attrs: { href: "https://x.test" } }] }] }] }] },
        { type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "curl x" }] },
      ],
    };
    expect(adf(doc)).toBe("## 步骤\n\n1. 打开[页面](https://x.test)\n\n```sh\ncurl x\n```");
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(mailBody({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>你好</p>") } }, { mimeType: "text/plain", body: { data: b64("你好\n") } }] }, htmlToMarkdown)).toBe("你好");
    expect(htmlToMarkdown('<h2>标题</h2><p>见 <a href="https://x.test">文档</a></p><ul><li>一</li><li>二</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe("## 标题\n\n见 [文档](https://x.test)\n\n- 一\n- 二\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
});
