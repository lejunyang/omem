import { afterEach, describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { importLarkDocument, startRefresh } from "../src/channels/lark-docs.ts";
import { clearWikiLocationCache, wikiChildren } from "../src/channels/lark-wiki.ts";
import { all, FILL_WIKI_NODES, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { search } from "../src/search/search.ts";
import { applyNodeLevels, levelCounts, levelOf, reviewNodeLevel, setAttention, setNodeLevel } from "../src/sources/attention.ts";
import { catalog, catalogChanged, chainOf, sourcesUnder, treeChildren } from "../src/sources/catalog.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const ORIGIN = "https://tenant.larkoffice.com";
const KB = "7000000000000000002";
type Node = { title: string; parent?: string; children?: string[]; type?: string };

/** A knowledge base: 根目录 → 退款 → 退款方案（has a child nobody captured）; docs read by node token. */
const NODES: Record<string, Node> = {
  wroot: { title: "根目录", children: ["wrefund"] },
  wrefund: { title: "退款", parent: "wroot", children: ["wplan", "wsheet"] },
  wplan: { title: "退款方案", parent: "wrefund", children: ["wchild"] },
  wchild: { title: "退款方案附录", parent: "wplan" },
  wsheet: { title: "退款台账", parent: "wrefund", type: "sheet" },
};

function fakeLark(nodes: Record<string, Node>, docs: Record<string, string> = {}) {
  const calls: string[][] = [];
  setLarkCliForTests(async (args) => {
    calls.push(args);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const node = (token: string) => {
      const n = nodes[token];
      return { space_id: KB, node_token: token, parent_node_token: n.parent, obj_token: `obj_${token}`, obj_type: n.type ?? "docx", node_type: "origin", title: n.title, has_child: !!n.children?.length };
    };
    if (args[0] === "docs" && args[1] === "+fetch") {
      const token = flag("--doc").split("/").pop()!;
      const title = nodes[token]?.title ?? docs[token];
      if (!title) throw new Error("not found");
      return { ok: true, data: { document: { document_id: nodes[token] ? `obj_${token}` : token, revision_id: 1, content: `<title>${title}</title>\n${title} 的正文\n退款按已发货行计算` } } };
    }
    if (args[0] === "wiki" && args[1] === "+node-get") {
      const token = flag("--node-token").split("/").pop()!;
      const byObj = Object.keys(nodes).find((k) => `obj_${k}` === token);
      if (!nodes[token] && !byObj) return { ok: false, error: { code: 131014, message: "131014 not mounted in wiki" } };
      return { ok: true, data: node(byObj ?? token) };
    }
    if (args[0] === "wiki" && args[1] === "+node-list") return { ok: true, data: { nodes: (nodes[flag("--parent-node-token")]?.children ?? []).map(node), has_more: false } };
    if (args[0] === "wiki" && args[1] === "spaces") return { ok: true, data: { space: { space_id: KB, name: "项目 A 知识库" } } };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return calls;
}

afterEach(() => {
  setLarkCliForTests(null);
  resetLarkAuthForTests();
});

describe("the catalog of a space", () => {
  it("places every kind of original in a tree and keeps knowledge-base nodes with their ancestors", async () => {
    const app = testApp();
    createSpace(app, { id: "proj", name: "项目 A", kind: "project" });
    clearWikiLocationCache(app);
    fakeLark(NODES, { dxlinked: "接口说明", dxdirect: "周会纪要" });
    app.config.lark.capture.docWikiChildren = 0;
    const plan = await importLarkDocument(app, "proj", `${ORIGIN}/wiki/wplan`, { depth: 0 });
    // A drive doc linked from the plan, and one given directly.
    const linked = upsertSource(app, { spaceId: "proj", kind: "doc", uri: `${ORIGIN}/docx/dxlinked`, title: "接口说明", text: "接口", meta: { via: "lark-cli", url: `${ORIGIN}/docx/dxlinked`, parentUrl: `${ORIGIN}/wiki/wplan` } }).id;
    const direct = upsertSource(app, { spaceId: "proj", kind: "doc", uri: `${ORIGIN}/docx/dxdirect`, title: "周会纪要", text: "周会", meta: { via: "lark-cli", url: `${ORIGIN}/docx/dxdirect` } }).id;
    const chatNow = appendToSource(app, { spaceId: "proj", kind: "chat", uri: "lark:oc_demo", title: "oc_demo", lines: ["[10-29] 小王：退款上线了"], meta: { chatId: "oc_demo", chatMode: "group" } }).id;
    const chatOld = upsertSource(app, { spaceId: "proj", kind: "chat", uri: "lark:oc_demo@2026-09", title: "退款群（2026-09 历史）", text: "[09-01] 小王：开始", meta: { chatId: "oc_demo", chatKind: "group", month: "2026-09", history: true } }).id;
    const dm = upsertSource(app, { spaceId: "proj", kind: "chat", uri: "lark:oc_dm", title: "与 小王 的私聊", text: "你好", meta: { chatId: "oc_dm", chatMode: "p2p" } }).id;
    const image = upsertSource(app, { spaceId: "proj", kind: "image", uri: "lark:oc_demo/img_1.png", title: "img_1.png", text: "截图" }).id;
    const web = upsertSource(app, { spaceId: "proj", kind: "web", uri: "https://example.com/blog/refund", title: "退款最佳实践", text: "网页", meta: { url: "https://example.com/blog/refund" } }).id;
    const meeting = upsertSource(app, { spaceId: "proj", kind: "meeting", uri: "lark:minutes:m1", title: "妙记：周会", text: "会议", meta: { date: "2026-10-12" } }).id;
    const note = upsertSource(app, { spaceId: "proj", kind: "note", uri: "note/n1", title: "想法", text: "笔记" }).id;

    // The plan's node and every ancestor are kept, with the knowledge base's name.
    expect(all(app.db, "select token, parent_token, title, source_id from wiki_nodes order by token")).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: "wplan", parent_token: "wrefund", source_id: plan.id }),
      expect.objectContaining({ token: "wrefund", parent_token: "wroot", title: "退款", source_id: null }),
      expect.objectContaining({ token: "wroot", parent_token: null, title: "根目录" }),
    ]));
    expect(one(app.db, "select name from wiki_spaces where id = ?", KB)).toEqual({ name: "项目 A 知识库" });

    const cat = catalog(app, "proj");
    expect(chainOf(cat, plan.id)).toEqual([`wiki:${KB}`, "wn:wroot", "wn:wrefund", "wn:wplan"]);
    expect(chainOf(cat, linked)).toEqual(["lark-drive", `from:${plan.id}`, `src:${linked}`]);
    expect(chainOf(cat, direct)).toEqual(["lark-drive", "lark-drive:direct", `src:${direct}`]);
    expect(chainOf(cat, chatOld)).toEqual(["chat:group", "chat:oc_demo", `src:${chatOld}`]);
    expect(chainOf(cat, chatNow).slice(0, 2)).toEqual(["chat:group", "chat:oc_demo"]);
    expect(chainOf(cat, dm)[0]).toBe("chat:p2p");
    expect(chainOf(cat, image)).toEqual(["chat:group", "chat:oc_demo", "chat:oc_demo:images", `src:${image}`]);
    expect(chainOf(cat, web)).toEqual(["site:example.com", "site:example.com/blog", `src:${web}`]);
    expect(chainOf(cat, meeting)).toEqual(["kind:meeting", "kind:meeting:2026", "kind:meeting:2026-10", `src:${meeting}`]);
    expect(chainOf(cat, note)[0]).toBe("kind:note");
    // The chat is named after its best title, not the raw id.
    expect(cat.nodes.get("chat:oc_demo")?.title).toBe("退款群");

    // One level at a time, with counts; children seen when listing a node and nobody captured are greyed out with a link to capture them.
    await wikiChildren(app, { spaceId: KB, nodeToken: "wplan" }, 50);
    const top = treeChildren(app, "proj", "");
    expect(top.nodes.map((n) => n.key)).toEqual([`wiki:${KB}`, "lark-drive", "chat:group", "chat:p2p", "site:example.com", "kind:meeting", "kind:note"]);
    expect(top.nodes.find((n) => n.key === "chat:group")?.count).toBe(3);
    const under = treeChildren(app, "proj", "wn:wplan");
    expect(under.path.map((p) => p.title)).toEqual(["项目 A 知识库", "根目录", "退款", "退款方案"]);
    expect(under.nodes).toEqual([expect.objectContaining({ key: "wn:wchild", uncaptured: true, url: `${ORIGIN}/wiki/wchild`, count: 0 })]);
    expect(treeChildren(app, "proj", "wn:wrefund").nodes.map((n) => n.key)).toEqual(["wn:wplan"]);
    await wikiChildren(app, { spaceId: KB, nodeToken: "wrefund" }, 50);
    expect(treeChildren(app, "proj", "wn:wrefund").nodes.map((n) => [n.key, !!n.uncaptured]).sort()).toEqual([["wn:wplan", false], ["wn:wsheet", true]]);
    // Filters act on the counts and hide what is left empty.
    const chats = treeChildren(app, "proj", "", { kind: "chat" });
    expect(chats.nodes.map((n) => [n.key, n.count])).toEqual([["chat:group", 2], ["chat:p2p", 1]]);
    expect(treeChildren(app, "proj", "", { q: "退款最佳" }).nodes.map((n) => n.key)).toEqual(["site:example.com"]);
  });

  it("sets levels on folders: inherited by the subtree and later arrivals, under the owner's and the docs' own choices", async () => {
    const app = testApp();
    createSpace(app, { id: "proj", name: "项目 A", kind: "project" });
    const chat = (i: number) => upsertSource(app, { spaceId: "proj", kind: "chat", uri: `lark:oc_noise@2026-0${i}`, title: `通知群（2026-0${i} 历史）`, text: `机器人通知 退款单 ${i}`, meta: { chatId: "oc_noise", chatKind: "group", month: `2026-0${i}` } }).id;
    const a = chat(1), b = chat(2);
    const keep = upsertSource(app, { spaceId: "proj", kind: "chat", uri: "lark:oc_team", title: "退款项目群", text: "退款单 讨论", meta: { chatId: "oc_team", chatMode: "group" } }).id;
    setAttention(app, [b], "focus", "agent");

    // An agent's folder level does not override another agent's level on one doc.
    expect(setNodeLevel(app, "proj", "chat:oc_noise", "ignore", "agent", { reason: "通知刷屏" })).toMatchObject({ changed: true, sources: 2 });
    expect(levelOf(app, a, true)).toMatchObject({ level: "ignore", inherited: true });
    expect(levelOf(app, b, true)).toMatchObject({ level: "focus", inherited: false });
    // The owner's folder level wins over an agent's doc level, and an agent cannot change it.
    setNodeLevel(app, "proj", "chat:oc_noise", "ignore", "owner");
    expect(levelOf(app, b, true)).toMatchObject({ level: "ignore", by: "owner", inherited: true });
    expect(setNodeLevel(app, "proj", "chat:oc_noise", "focus", "agent").kept).toBe(true);
    // A level the owner gave the doc itself beats the owner's folder level.
    setAttention(app, [b], "reference", "owner");
    expect(levelOf(app, b, true)).toMatchObject({ level: "reference", inherited: false });
    // Search and counts use the effective level; later archives of the chat inherit it.
    expect((await search(app, "退款单", { spaces: ["proj"] })).map((h) => h.sourceId)).not.toContain(a);
    const c = chat(3);
    catalogChanged(app, "proj");
    applyNodeLevels(app, "proj");
    expect(levelOf(app, c, true).level).toBe("ignore");
    expect(levelCounts(app, null, "proj")).toEqual({ focus: 0, normal: 1, reference: 1, ignore: 2 });
    expect(sourcesUnder(catalog(app, "proj"), "chat:oc_noise").sort()).toEqual([a, b, c].sort());
    expect(levelOf(app, keep, true).level).toBe("normal");

    // A rejected folder level is gone and the agent cannot set it again.
    setNodeLevel(app, "proj", "chat:oc_team", "reference", "agent", { reason: "旧项目" });
    reviewNodeLevel(app, "proj", "chat:oc_team", "reject");
    expect(levelOf(app, keep, true).level).toBe("normal");
    expect(setNodeLevel(app, "proj", "chat:oc_team", "reference", "agent")).toMatchObject({ kept: true, rejected: true });
  });

  it("gives agents the tree: list_sources by node, set_source_attention on a folder", async () => {
    const app = testApp();
    createSpace(app, { id: "proj", name: "项目 A", kind: "project" });
    for (const i of [1, 2]) upsertSource(app, { spaceId: "proj", kind: "chat", uri: `lark:oc_x@2026-0${i}`, title: `值班群（2026-0${i} 历史）`, text: "值班", meta: { chatId: "oc_x", chatKind: "group", month: `2026-0${i}` } });
    const ctx: ToolContext = { app, runId: null, spaceId: "proj", spaces: ["proj"], tools: null, actor: "agent" };
    const top = await callTool(ctx, "list_sources", {});
    expect(top.text).toContain("chat:group「群聊」2 份");
    const deep = await callTool(ctx, "list_sources", { under: "chat:group", depth: 2 });
    expect(deep.text).toContain("chat:oc_x「值班群」");
    expect(deep.text).toMatch(/src:\S+「2026-02」原件/);
    const set = await callTool(ctx, "set_source_attention", { level: "reference", reason: "历史值班记录", under: "chat:oc_x", space: "proj" });
    expect(set.text).toContain("下面 2 份");
    expect((await callTool(ctx, "list_sources", { under: "chat:group" })).text).toContain("〔仅检索〕");
    expect((await callTool(ctx, "list_sources", { under: "nope" })).isError).toBe(true);
  });

  it("fills the knowledge-base tree from what earlier captures kept, without the network", () => {
    const app = testApp();
    const meta = { via: "lark-cli", wikiSpaceId: "kb1", wikiSpaceName: "项目 A 知识库", wikiNodeToken: "n2", wikiParentNodeToken: "n1", wikiParentTitle: "方案", documentId: "dx2", wikiMetadataCheckedAt: "2026-10-01" };
    const wikiCopy = upsertSource(app, { spaceId: "personal", kind: "doc", uri: `${ORIGIN}/wiki/n2`, title: "退款方案", text: "a", meta: { ...meta, url: `${ORIGIN}/wiki/n2` } }).id;
    upsertSource(app, { spaceId: "personal", kind: "doc", uri: `${ORIGIN}/docx/dx2`, title: "退款方案", text: "a", meta: { ...meta, url: `${ORIGIN}/docx/dx2` } });
    run(app.db, "delete from wiki_nodes");
    run(app.db, "delete from wiki_spaces");
    app.db.exec(FILL_WIKI_NODES);
    app.db.exec(FILL_WIKI_NODES);
    expect(all(app.db, "select token, wiki_space_id, parent_token, title, source_id, checked_at from wiki_nodes order by token")).toEqual([
      { token: "n1", wiki_space_id: "kb1", parent_token: null, title: "方案", source_id: null, checked_at: null },
      { token: "n2", wiki_space_id: "kb1", parent_token: "n1", title: "退款方案", source_id: wikiCopy, checked_at: null },
    ]);
    expect(one(app.db, "select name from wiki_spaces where id = 'kb1'")).toEqual({ name: "项目 A 知识库" });
    catalogChanged(app);
    // Both copies sit at the node; the parent read from meta is its folder.
    const cat = catalog(app, "personal");
    expect(chainOf(cat, wikiCopy)).toEqual(["wiki:kb1", "wn:n1", "wn:n2"]);
    expect(treeChildren(app, "personal", "wn:n2").nodes).toHaveLength(1);
  });

  it("refreshes the knowledge-base place only of docs never checked when asked for `unchecked`", () => {
    const app = testApp();
    const doc = (uri: string, meta: Record<string, unknown>) => upsertSource(app, { spaceId: "personal", kind: "doc", uri, title: uri, text: uri, meta: { via: "lark-cli", url: uri, ...meta } }).id;
    const never = doc(`${ORIGIN}/wiki/w1`, {});
    const old = doc(`${ORIGIN}/wiki/w2`, { wikiMetadataCheckedAt: "2026-10-01", wikiNodeToken: "w2" });
    const fresh = doc(`${ORIGIN}/wiki/w3`, { wikiMetadataCheckedAt: "2026-10-01", wikiNodeToken: "w3" });
    const drive = doc(`${ORIGIN}/docx/d1`, { wikiMetadataCheckedAt: "2026-10-01" });
    run(app.db, "insert into wiki_nodes(token, wiki_space_id, title, checked_at) values('w3', 'kb', 'w3', '2026-10-30'), ('w2', 'kb', 'w2', null)");
    const s = startRefresh(app, { metadataOnly: true, unchecked: true });
    expect(s.todo.sort()).toEqual([never, old].sort());
    expect(s.todo).not.toContain(fresh);
    expect(s.todo).not.toContain(drive);
  });
});
