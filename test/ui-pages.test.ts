import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeAnswer, getAsk, listAsks } from "../src/agents/asks.ts";
import { artifactInbox } from "../src/agents/artifacts.ts";
import { PAGE_CSP, pageDocument } from "../src/agents/ui-pages.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createThread } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { askCard } from "../src/channels/lark-asks.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

function working(channel = "web") {
  const app = testApp();
  const t = createThread(app, { spaceId: "personal", channel, userId: "owner" });
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, "agent", "personal", "running", "t", JSON.stringify({ conversationId: t.id }), new Date().toISOString());
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  return { app, thread: t, runId, ctx };
}
const pageId = (text: string) => /交互页 (pg\w+)/.exec(text)![1];

const proto = `<!DOCTYPE html><html><head><title>x</title><style>.a{color:var(--ink)}</style></head><body><button id="b">选 B</button><script>document.getElementById("b").onclick=()=>omem.submit({plan:"b"},"选了 B")</script></body></html>`;

describe("interactive pages", () => {
  it("the document puts the host's policy, look and bridge first and lets nothing in from the network", () => {
    const doc = pageDocument(proto);
    expect(doc.startsWith("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc).not.toContain("<!DOCTYPE html><html><head><title>");
    expect(doc).toContain("window.omem=");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("选 B"));
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("connect-src 'none'");
    expect(PAGE_CSP).not.toMatch(/https?:|'self'/);
  });

  it("ui_page keeps versions; show and ask_user point to them; a page's answer comes back like a form's", async () => {
    const { app, thread, ctx } = working();
    expect((await callTool(ctx, "ui_page", { title: "两种设置页" })).isError).toBe(true);
    const first = await callTool(ctx, "ui_page", { title: "两种设置页", html: proto });
    const id = pageId(first.text);
    expect(first.text).toContain("第 1 版");
    expect((await callTool(ctx, "ui_page", { title: "两种设置页", html: proto.replace("选 B", "就选 B"), page_id: id })).text).toContain("第 2 版");
    expect((await callTool(ctx, "ui_page", { title: "x", html: proto, page_id: "pgnope" })).isError).toBe(true);
    expect((await callTool(ctx, "show", { components: [{ type: "page", id: "pgnope" }] })).isError).toBe(true);
    await callTool(ctx, "show", { components: [{ type: "page", id }] });
    expect((await callTool(ctx, "ask_user", { question: "选哪个？", view: [{ type: "page", id }], fields: [{ id: "a", label: "a", type: "text" }], wait_seconds: 0 })).text).toMatch(/不能放在同一个提问里/);
    await callTool(ctx, "ask_user", { question: "在页面里试一下，选一个", view: [{ type: "page", id }], wait_seconds: 0 });
    const ask = listAsks(app, { conversationId: thread.id })[0];
    expect(ask.ui?.view).toEqual([{ type: "page", id, title: "两种设置页" }]);
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const page = (await server.inject({ url: `/api/ui/pages/${id}` })).json();
      expect(page).toMatchObject({ id, version: 2, versions: [1, 2], title: "两种设置页" });
      expect(page.document).toContain("就选 B");
      expect((await server.inject({ url: `/api/ui/pages/${id}?version=1` })).json().document).toContain(">选 B<");
      expect((await server.inject({ method: "POST", url: `/api/asks/${ask.id}/draft`, payload: { draft: { plan: "a" } } })).statusCode).toBe(200);
      expect((await server.inject({ url: `/api/ui/${ask.id}` })).json().ask.draft).toEqual({ plan: "a" });
      const big = await server.inject({ method: "POST", url: `/api/asks/${ask.id}/answer`, payload: { value: { x: "y".repeat(21_000) } } });
      expect(big.statusCode).toBe(400);
      const ok = await server.inject({ method: "POST", url: `/api/asks/${ask.id}/answer`, payload: { value: { plan: "b" }, text: "选了 B" } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await server.close();
    }
    const done = getAsk(app, ask.id);
    expect(done).toMatchObject({ status: "answered", value: { plan: "b" }, answer: "选了 B" });
    expect(describeAnswer(done)).toContain("在交互页里选好了");
    expect(describeAnswer(done)).toContain('结构化的值：{"plan":"b"}');
  });

  it("a coding run hands in a page from its workspace; a Feishu card links to it", async () => {
    const { app, thread, ctx, runId } = working("lark");
    app.config.webUrl = "https://omem.example.test";
    const inbox = artifactInbox(app, runId);
    mkdirSync(join(inbox, "proto"), { recursive: true });
    writeFileSync(join(inbox, "proto", "settings.html"), proto);
    writeFileSync(join(inbox, "notes.txt"), "x");
    expect((await callTool(ctx, "ui_page", { title: "原型", path: "notes.txt" })).isError).toBe(true);
    expect((await callTool(ctx, "ui_page", { title: "原型", path: "../../../etc/passwd.html" })).isError).toBe(true);
    const r = await callTool(ctx, "ui_page", { title: "原型", path: "proto/settings.html" });
    const id = pageId(r.text);
    await callTool(ctx, "ask_user", { question: "选哪种？", view: [{ type: "page", id }], wait_seconds: 0 });
    const ask = listAsks(app, { conversationId: thread.id })[0];
    const card = JSON.stringify(askCard(app, ask));
    expect(card).not.toContain("交互页“原型”");
    expect(card).toContain(`https://omem.example.test/#/ui/${ask.id}`);
    expect(card).toContain("打开交互页");
  });
});
