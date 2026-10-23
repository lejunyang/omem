import { afterEach, describe, expect, it } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { importLarkDocument, startRefresh, continueRefresh } from "../src/channels/lark-docs.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { continueCrawl, crawlLoop, getCrawl, startCrawl, wikiLocation, clearWikiLocationCache } from "../src/channels/lark-wiki.ts";
import { all, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { matchesArchive, saveArchiveRule } from "../src/sources/archive.ts";
import { getSource, sourceText } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const ORIGIN = "https://tenant.larkoffice.com";
const PERSONAL = "7000000000000000001";
const TEAM = "7000000000000000002";

type Node = { title: string; children?: string[]; space?: string; type?: string; parent?: string };

/**
 * A fake lark-cli with a knowledge base: wiki nodes by token (their children listed by node-list),
 * docs fetched by the same token, the personal library, and doc writes recorded.
 */
function fakeWiki(nodes: Record<string, Node>, opts: { denyList?: boolean; nodeError?: string } = {}) {
  const calls: string[][] = [];
  setLarkCliForTests(async (args) => {
    calls.push(args);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const node = (token: string) => {
      const n = nodes[token];
      return { space_id: n.space ?? TEAM, node_token: token, parent_node_token: n.parent, obj_token: `obj_${token}`, obj_type: n.type ?? "docx", node_type: "origin", title: n.title, has_child: !!n.children?.length };
    };
    if (args[0] === "docs" && args[1] === "+fetch") {
      const token = flag("--doc").split("/").pop()!;
      if (!nodes[token]) throw new Error("not found");
      return { ok: true, data: { document: { document_id: `obj_${token}`, revision_id: 1, content: `<title>${nodes[token].title}</title>\n${nodes[token].title} 的正文` } } };
    }
    if (args[0] === "wiki" && args[1] === "+node-get") {
      if (opts.nodeError) throw new Error(opts.nodeError);
      const token = flag("--node-token").split("/").pop()!;
      if (!nodes[token]) return { ok: false, error: { code: 131014, message: "131014 not mounted in wiki" } };
      return { ok: true, data: node(token) };
    }
    if (args[0] === "wiki" && args[1] === "+node-list") {
      if (opts.denyList) return { ok: false, error: { type: "authorization", subtype: "missing_scope", message: "missing scope", missing_scopes: ["wiki:node:retrieve"] } };
      const parent = flag("--parent-node-token");
      return { ok: true, data: { nodes: (nodes[parent]?.children ?? []).map(node), has_more: false } };
    }
    if (args[0] === "wiki" && args[1] === "spaces" && args[2] === "get") {
      const id = JSON.parse(flag("--params")).space_id;
      return { ok: true, data: { space: id === "my_library" ? { space_id: PERSONAL, name: "我的文档库" } : { space_id: id, name: "项目 A 知识库" } } };
    }
    if (args[0] === "auth" && args[1] === "login" && args.includes("--no-wait")) return { ok: true, data: { verification_url: "https://tenant.larkoffice.com/auth?code=X", device_code: "dc1", expires_in: 600 } };
    if (args[0] === "auth" && args[1] === "login") return new Promise(() => {});
    if (args[0] === "auth" && args[1] === "status") return { ok: true, identities: { user: { openId: "ou_me", userName: "本人", scope: "wiki:node:read docx:document" } } };
    if (args[0] === "docs" && args[1] === "+create") return { ok: true, data: { document: { document_id: "docx_new", url: `${ORIGIN}/docx/docx_new` } } };
    if (args[0] === "docs" && args[1] === "+update") return { ok: true, data: { document: { revision_id: 2 } } };
    if (args[0] === "wiki" && args[1] === "+move") return { ok: true, data: { node_token: flag("--node-token") } };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return calls;
}

afterEach(() => {
  setLarkCliForTests(null);
  setLarkClient(null);
  resetLarkAuthForTests();
});

const TREE: Record<string, Node> = {
  Root: { title: "项目 A 手册", children: ["A", "B"] },
  A: { title: "上手", children: ["A1"] },
  B: { title: "表格", type: "sheet" },
  A1: { title: "环境搭建", children: ["A2"] },
  A2: { title: "常见问题" },
};

const titles = (app: ReturnType<typeof testApp>) => all<{ title: string }>(app.db, "select title from sources where kind = 'doc' order by title").map((r) => r.title);

describe("feishu knowledge bases", () => {
  it("captures wiki metadata at zero depth for wiki and docx links, with title and body matching", async () => {
    const app = testApp();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    const calls = fakeWiki({ Root: { title: "项目 A" }, A: { title: "项目 A 手册", parent: "Root" }, B: { title: "项目 A 日程", parent: "Root" } });
    const conditions = { all: [
      { field: "kind", op: "equals", value: "doc" },
      { field: "title", op: "contains", value: "项目 A" },
      { field: "text", op: "contains", value: "的正文" },
      { field: "meta.wikiSpaceName", op: "equals", value: "项目 A 知识库" },
      { field: "meta.wikiPath", op: "contains", value: "项目 A" },
    ] } as const;
    const rule = saveArchiveRule(app, { name: "项目 A 文档", target: "project-a", enabled: true, conditions });
    for (const path of ["wiki/A", "docx/B"]) {
      const r = await importLarkDocument(app, "personal", `${ORIGIN}/${path}`, { depth: 0, archive: true });
      const s = getSource(app, r.id);
      expect(s.spaceId).toBe("project-a");
      expect(s.meta).toMatchObject({ wikiSpaceId: TEAM, wikiNodeToken: path.split("/")[1], wikiParentNodeToken: "Root", wikiPath: "项目 A", wikiParentTitle: "项目 A" });
      expect(matchesArchive(rule.conditions, { ...s, text: sourceText(app, s.id) })).toBe(true);
      expect(matchesArchive(rule.conditions, { ...s, title: "项目 B", text: sourceText(app, s.id) })).toBe(false);
      expect(matchesArchive(rule.conditions, { ...s, text: "不含关键字" })).toBe(false);
    }
    expect(calls.filter(c => c[1] === "+node-list")).toHaveLength(0);
  });

  it("refreshes unchanged documents' node metadata and routing, retaining verified metadata on failure", async () => {
    const app = testApp();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    const url = `${ORIGIN}/docx/A`;
    fakeWiki({ A: { title: "手册" } }, { nodeError: "131014 not mounted in wiki" });
    const first = await importLarkDocument(app, "personal", url, { depth: 0, archive: true });
    const hash = getSource(app, first.id).hash;
    expect(getSource(app, first.id).meta.wikiNodeToken).toBeUndefined();
    saveArchiveRule(app, { name: "项目 A 知识库", target: "project-a", enabled: true, conditions: { field: "meta.wikiPath", op: "contains", value: "项目 A" } });
    fakeWiki({ Root: { title: "项目 A" }, A: { title: "手册", parent: "Root" } });
    const second = await importLarkDocument(app, "personal", url, { depth: 0, archive: true });
    expect(second).toMatchObject({ id: first.id, status: "unchanged" });
    expect(getSource(app, first.id)).toMatchObject({ spaceId: "project-a", hash, meta: { wikiSpaceId: TEAM, wikiParentNodeToken: "Root" } });
    fakeWiki({ A: { title: "手册" } }, { nodeError: "temporary node lookup failure" });
    await importLarkDocument(app, "personal", url, { depth: 0, archive: true });
    expect(getSource(app, first.id)).toMatchObject({ hash, meta: { wikiSpaceId: TEAM, wikiParentNodeToken: "Root" } });
    expect(getSource(app, first.id).meta.wikiPath).toBeUndefined();
    fakeWiki({ A: { title: "手册" } }, { nodeError: "131014 not mounted in wiki" });
    await importLarkDocument(app, "personal", url, { depth: 0, archive: true });
    expect(getSource(app, first.id).meta.wikiNodeToken).toBeUndefined();
  });

  it("resolves ancestor names and refreshes only metadata after a parent rename, without touching evidence", async () => {
    const app = testApp();
    const nodes = { Top: { title: "业务方向" }, Root: { title: "项目 A", parent: "Top" }, A: { title: "周会记录", parent: "Root" } };
    fakeWiki(nodes);
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/wiki/A`, { depth: 0 });
    const before = getSource(app, r.id);
    const chunks = all(app.db, "select id,line_start,line_end,text from chunks where source_id=?", r.id);
    expect(before.meta).toMatchObject({ wikiPath: "业务方向 / 项目 A", wikiParentTitle: "项目 A", wikiSpaceName: "项目 A 知识库" });
    expect(matchesArchive({ field: "meta.wikiPath", op: "contains", value: "项目 A" }, { ...before, text: sourceText(app, r.id) })).toBe(true);
    const calls = fakeWiki({ ...nodes, Root: { title: "项目 B", parent: "Top" } });
    startRefresh(app, { space: "personal", metadataOnly: true });
    const state = await continueRefresh(app);
    expect(state).toMatchObject({ done: 1, failed: 0, changed: {} });
    expect(getSource(app, r.id)).toMatchObject({ id: r.id, hash: before.hash, updatedAt: before.updatedAt, meta: { wikiPath: "业务方向 / 项目 B", wikiParentTitle: "项目 B" } });
    expect(all(app.db, "select id,line_start,line_end,text from chunks where source_id=?", r.id)).toEqual(chunks);
    expect(calls.some(c => c[0] === "docs")).toBe(false);
  });

  it("does not match missing, cyclic or unreadable ancestor paths, including exclusions", async () => {
    const app = testApp();
    fakeWiki({ A: { title: "手册", parent: "Root" }, Root: { title: "项目 A", parent: "A" } });
    const cycle = await wikiLocation(app, "A");
    expect(cycle.path).toBeUndefined();
    expect(cycle.errors).not.toHaveLength(0);
    clearWikiLocationCache(app);
    fakeWiki({ A: { title: "手册", parent: "Missing" } });
    const missing = await wikiLocation(app, "A");
    expect(missing.path).toBeUndefined();
    const input = { spaceId: "personal", kind: "doc" as const, uri: "example", title: "周会", text: "正文", meta: {} };
    expect(matchesArchive({ not: { field: "meta.wikiPath", op: "contains", value: "项目 A" } }, input)).toBe(false);
    expect(matchesArchive({ any: [{ field: "title", op: "equals", value: "周会" }, { field: "meta.wikiPath", op: "contains", value: "项目 A" }] }, input)).toBe(true);
  });

  it("reads a wiki page's child pages as links, levels counted from the page first given", async () => {
    const app = testApp();
    fakeWiki(TREE);
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/wiki/Root`);
    // Two levels below the root: 上手 and 环境搭建; 常见问题 is a third level; the sheet stays a link.
    expect(titles(app)).toEqual(["上手", "环境搭建", "项目 A 手册"].sort());
    const root = one<{ text: string }>(app.db, "select text from sources where id = ?", r.id)!.text;
    expect(root).toContain("知识库子页面");
    expect(root).toMatch(/\[上手\]\(src:/);
    // One import reads at most docMaxPerImport docs in all.
    const small = testApp();
    small.config.lark.capture.docMaxPerImport = 1;
    fakeWiki(TREE);
    await importLarkDocument(small, "personal", `${ORIGIN}/wiki/Root`);
    expect(titles(small)).toHaveLength(2);
  });

  it("crawls a knowledge base batch by batch and keeps its place", async () => {
    const app = testApp();
    fakeWiki(TREE);
    const c = await startCrawl(app, { spaceId: "personal", url: `${ORIGIN}/wiki/Root`, depth: 5, batch: 2 }, { background: false });
    await crawlLoop(app, c.id);
    expect(getCrawl(app, c.id)).toMatchObject({ status: "paused", read: 2 });
    continueCrawl(app, c.id, { background: false });
    const done = await crawlLoop(app, c.id);
    expect(done).toMatchObject({ status: "done", read: 4, skipped: 1 });
    expect(titles(app)).toEqual(["上手", "常见问题", "环境搭建", "项目 A 手册"].sort());
    // What was read went to understanding.
    expect(all(app.db, "select id from runs where kind = 'ingest'").length).toBeGreaterThan(0);
  });

  it("a missing scope pauses the crawl and sends the owner a login link", async () => {
    const app = testApp();
    fakeWiki(TREE, { denyList: true });
    const c = await startCrawl(app, { spaceId: "personal", url: `${ORIGIN}/wiki/Root`, depth: 2 }, { background: false });
    const after = await crawlLoop(app, c.id);
    expect(after.status).toBe("paused");
    expect(after.errors.join()).toMatch(/缺少飞书权限 wiki:node:retrieve.*auth\?code=X/);
    const n = one<{ body: string }>(app.db, "select body from notifications order by at desc limit 1");
    expect(n?.body).toContain("https://tenant.larkoffice.com/auth?code=X");
  });
});

describe("feishu docs written as the owner", () => {
  const agent = (app: ReturnType<typeof testApp>) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: null }))!;

  it("creates in the personal library directly; a shared knowledge base waits for the owner's OK with the place spelled out", async () => {
    const app = testApp();
    app.config.approvals = { tools: [], waitSeconds: 0 };
    const calls = fakeWiki({ ...TREE, Mine: { title: "我的笔记", space: PERSONAL } });
    const ctx = agent(app);
    const own = await callTool(ctx, "lark_doc_create", { title: "周会纪要", content: "# 周会\n- 定了方案" });
    expect(own.text).toMatch(/个人文档库.*docx_new/);
    expect(calls.find((c) => c[1] === "+create")).toContain("my_library");
    const under = await callTool(ctx, "lark_doc_create", { title: "子页", content: "x", parent: `${ORIGIN}/wiki/Mine` });
    expect(under.text).toMatch(/个人文档库 的《我的笔记》下/);

    const shared = await callTool(ctx, "lark_doc_create", { title: "排查记录", content: "x", parent: `${ORIGIN}/wiki/A` });
    expect(shared.text).toMatch(/需要本人批准/);
    const ask = listAsks(app, { status: "pending" })[0];
    expect(ask.question).toMatch(/知识库「项目 A 知识库」 的《上手》下 新建文档《排查记录》/);
    expect(calls.filter((c) => c[1] === "+create")).toHaveLength(2);
    const done = await answerAsk(app, ask.id, { approved: true, by: "owner" });
    expect(done.result).toMatch(/已在.*新建《排查记录》/);
    expect(calls.filter((c) => c[1] === "+create")).toHaveLength(3);

    // Editing or moving something in the shared knowledge base waits too.
    expect((await callTool(ctx, "lark_doc_update", { doc: `${ORIGIN}/wiki/A`, command: "overwrite", content: "新内容" })).text).toMatch(/需要本人批准/);
    expect((await callTool(ctx, "lark_doc_move", { doc: `${ORIGIN}/wiki/Mine`, target: `${ORIGIN}/wiki/A` })).text).toMatch(/需要本人批准/);
    expect((await callTool(ctx, "lark_doc_update", { doc: `${ORIGIN}/wiki/Mine`, command: "append", content: "追加" })).text).toMatch(/已编辑/);
    // An outside agent (omem mcp) cannot write as the owner.
    expect((await callTool(toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!, "lark_doc_create", { title: "x", content: "x" })).text).toMatch(/只在 omem 自己的运行里/);
  });
});

describe("urgent and members-only messages", () => {
  function fakeBot() {
    const sent: { kind: string; args: any }[] = [];
    setLarkClient({
      contact: { user: { batchGetId: async () => ({ code: 0, data: { user_list: [] } }) } },
      im: {
        chatMembers: { get: async () => ({ code: 0, data: { items: [], has_more: false } }) },
        message: {
          create: async (args: any) => (sent.push({ kind: "create", args }), { code: 0, data: { message_id: "om_sent" } }),
          urgentApp: async (args: any) => (sent.push({ kind: "urgent", args }), { code: 0, data: {} }),
        },
      },
      request: async (args: any) => (sent.push({ kind: "ephemeral", args }), { code: 0, data: { message_id: `om_eph_${sent.length}` } }),
    } as never);
    return sent;
  }
  const ctxWith = (app: ReturnType<typeof testApp>, powers?: { urgent: boolean; private: boolean }) =>
    toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_team"], larkPowers: powers }))!;

  it("are refused unless the rule (or the owner) allows them; allowed, they reach only the named people", async () => {
    const app = testApp();
    rememberPerson(app, { botOpenId: "ou_wang", name: "小王" });
    rememberPerson(app, { botOpenId: "ou_li", name: "小李" });
    const sent = fakeBot();
    const plain = ctxWith(app);
    expect((await callTool(plain, "lark_send", { chat_id: "oc_team", text: "线上报错", urgent: ["小王"] })).text).toMatch(/不能加急/);
    expect((await callTool(plain, "lark_send", { chat_id: "oc_team", text: "线上报错", only_to: ["小王"] })).text).toMatch(/不能发只给部分人看/);
    expect(sent).toHaveLength(0);

    const allowed = ctxWith(app, { urgent: true, private: true });
    const u = await callTool(allowed, "lark_send", { chat_id: "oc_team", text: "线上报错，麻烦看下", urgent: ["小王"] });
    expect(u.text).toMatch(/加急 小王/);
    expect(sent.map((s) => s.kind)).toEqual(["create", "urgent"]);
    expect(sent[1].args).toMatchObject({ path: { message_id: "om_sent" }, params: { user_id_type: "open_id" }, data: { user_id_list: ["ou_wang"] } });

    const p = await callTool(allowed, "lark_send", { chat_id: "oc_team", markdown: "你的工单已超时", only_to: ["小王", "小李"] });
    expect(p.text).toMatch(/只给 小王、小李 看/);
    const eph = sent.filter((s) => s.kind === "ephemeral");
    expect(eph.map((s) => s.args.data.open_id)).toEqual(["ou_wang", "ou_li"]);
    expect(eph[0].args).toMatchObject({ method: "POST", url: "/open-apis/ephemeral/v1/send", data: { chat_id: "oc_team", msg_type: "interactive" } });
    expect((await callTool(allowed, "lark_send", { chat_id: "oc_team", text: "x", urgent: ["all"] })).text).toMatch(/不能用 all/);
  });
});
