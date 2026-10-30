import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { importLarkDocument } from "../src/channels/lark-docs.ts";
import {
  discoverKnowledgeBases, getKb, kbAction, listKnowledgeBases, notifyProposals, proposeMapping, readKnowledgeDaily, readsSince, setKbThrottleForTests, splitBudget, walkSample,
} from "../src/channels/lark-knowledge.ts";
import { getCrawl, listCrawls } from "../src/channels/lark-wiki.ts";
import { all, one, run } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { runPeerCommand } from "../src/core/peer-exec.ts";
import { createSpace, findSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

const ORIGIN = "https://tenant.larkoffice.com";
const LIBRARY = "7100000000000000009";

type Node = { title: string; space: string; parent?: string; type?: string };
type Kb = { id: string; name: string; description?: string; type?: string };

/**
 * A fake lark-cli with several knowledge bases: the listing (`+space-list`, paged or not), the
 * personal library, nodes by token (top-level ones have no parent), and docs fetched by node token.
 */
function fakeLark(state: { kbs: Kb[]; nodes: Record<string, Node>; more?: boolean; noLibrary?: boolean; loggedIn?: boolean }) {
  const calls: string[][] = [];
  setLarkCliForTests(async (args) => {
    calls.push(args);
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const node = (token: string) => {
      const n = state.nodes[token];
      const kids = Object.values(state.nodes).some((x) => x.parent === token);
      return { space_id: n.space, node_token: token, parent_node_token: n.parent, obj_token: `obj_${token}`, obj_type: n.type ?? "docx", node_type: "origin", title: n.title, has_child: kids };
    };
    if (args[0] === "auth" && args[1] === "status") return state.loggedIn === false ? { ok: true, identities: {} } : { ok: true, identities: { user: { openId: "ou_me", userName: "本人", scope: "wiki:wiki:readonly" } } };
    if (args[0] === "wiki" && args[1] === "+space-list")
      return { ok: true, data: { spaces: state.kbs.map((k) => ({ space_id: k.id, name: k.name, description: k.description ?? "", space_type: k.type ?? "team", visibility: "private" })), has_more: !!state.more } };
    if (args[0] === "wiki" && args[1] === "spaces" && args[2] === "get") {
      const id = JSON.parse(flag("--params")!).space_id;
      if (id === "my_library") {
        if (state.noLibrary) return { ok: false, error: { code: 99991400, message: "temporary failure" } };
        return { ok: true, data: { space: { space_id: LIBRARY, name: "我的文档库", space_type: "my_library" } } };
      }
      return { ok: true, data: { space: { space_id: id, name: state.kbs.find((k) => k.id === id)?.name ?? "知识库" } } };
    }
    if (args[0] === "wiki" && args[1] === "+node-list") {
      const space = flag("--space-id")!;
      const parent = flag("--parent-node-token");
      const list = Object.keys(state.nodes).filter((t) => state.nodes[t].space === space && (parent ? state.nodes[t].parent === parent : !state.nodes[t].parent));
      // Pages of --page-size, the token is the offset.
      const size = Number(flag("--page-size") ?? 50);
      const from = Number(flag("--page-token") ?? 0);
      const more = from + size < list.length;
      return { ok: true, data: { nodes: list.slice(from, from + size).map(node), has_more: more, ...(more ? { page_token: String(from + size) } : {}) } };
    }
    if (args[0] === "wiki" && args[1] === "+node-get") {
      const token = flag("--node-token")!.split("/").pop()!;
      if (!state.nodes[token]) return { ok: false, error: { code: 131014, message: "131014 not mounted in wiki" } };
      return { ok: true, data: node(token) };
    }
    if (args[0] === "docs" && args[1] === "+fetch") {
      const token = flag("--doc")!.split("/").pop()!;
      const n = state.nodes[token];
      if (!n) throw new Error("not found");
      return { ok: true, data: { document: { document_id: `obj_${token}`, revision_id: 1, content: `<title>${n.title}</title>\n${n.title} 的正文，讲的是退款流程。` } } };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return calls;
}

const docs = (prefix: string, space: string, n: number, extra: Record<string, Node> = {}) => ({
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, { title: `${prefix} 文档 ${i}`, space }])),
  ...extra,
});

beforeEach(() => setKbThrottleForTests(0));
afterEach(() => {
  setLarkCliForTests(null);
  resetLarkAuthForTests();
});

const scout = (app: ReturnType<typeof testApp>, kbIds: string[], spaces: string[] | null = null): ToolContext => {
  const r = createRun(app, { kind: "kb-scout", spaceId: "personal", title: "test", input: { kbIds } });
  return { app, runId: r.id, spaceId: "personal", spaces, tools: null, actor: "agent", role: "kb-scout" };
};

describe("feishu knowledge bases: discovery", () => {
  it("keeps every knowledge base and the personal library, samples new ones, marks vanished ones gone and queues the scout", async () => {
    const app = testApp();
    const state = {
      kbs: [{ id: "kb-a", name: "退款组手册", description: "退款相关的流程与规范" }, { id: "kb-b", name: "行政通知" }],
      nodes: { ...docs("a", "kb-a", 2), b0: { title: "放假安排", space: "kb-b" } },
    };
    fakeLark(state);
    const first = await discoverKnowledgeBases(app);
    expect(first).toMatchObject({ found: 3, added: 3, gone: 0, walked: 3 });
    const a = getKb(app, "kb-a")!;
    expect(a).toMatchObject({ name: "退款组手册", description: "退款相关的流程与规范", spaceType: "team", visibility: "private", status: "new" });
    expect(a.sample?.roots.map((r) => r.title)).toEqual(["a 文档 0", "a 文档 1"]);
    expect(getKb(app, LIBRARY)).toMatchObject({ name: "我的文档库", spaceType: "my_library" });
    // The scout gets the unsorted ones.
    const runs = listRuns(app, { kind: "kb-scout" });
    expect(runs).toHaveLength(1);
    expect(runs[0].input.kbIds).toEqual(expect.arrayContaining(["kb-a", "kb-b", LIBRARY]));

    // B is no longer listed: gone, not deleted. An incomplete listing marks nothing.
    state.kbs = state.kbs.slice(0, 1);
    const partial = await discoverKnowledgeBases(app);
    expect(partial.gone).toBe(1);
    expect(getKb(app, "kb-b")!.goneAt).toBeTruthy();
    expect(listKnowledgeBases(app).map((k) => k.id).sort()).toEqual([LIBRARY, "kb-a"].sort());
    expect(listKnowledgeBases(app, { status: "gone" }).map((k) => k.id)).toEqual(["kb-b"]);
    state.kbs.push({ id: "kb-b", name: "行政通知" });
    await discoverKnowledgeBases(app);
    expect(getKb(app, "kb-b")!.goneAt).toBeNull();
    Object.assign(state, { kbs: [], more: true });
    const truncated = await discoverKnowledgeBases(app);
    expect(truncated.gone).toBe(0);
    expect(truncated.errors.join()).toMatch(/has_more/);
    // The library failing to load does not make it gone.
    Object.assign(state, { kbs: [{ id: "kb-a", name: "退款组手册" }, { id: "kb-b", name: "行政通知" }], more: false, noLibrary: true });
    await discoverKnowledgeBases(app);
    expect(getKb(app, LIBRARY)!.goneAt).toBeNull();
  });

  it("takes a capped shallow look: top-level titles, the children of the first few only", async () => {
    const app = testApp();
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < 60; i++) {
      nodes[`r${i}`] = { title: `目录 ${i}`, space: "kb-big" };
      for (let j = 0; j < 20; j++) nodes[`r${i}c${j}`] = { title: `页面 ${i}-${j}`, space: "kb-big", parent: `r${i}` };
    }
    const calls = fakeLark({ kbs: [{ id: "kb-big", name: "大知识库" }], nodes });
    const sample = await walkSample(app, "kb-big");
    expect(sample.roots).toHaveLength(50);
    expect(sample.more).toBe(true);
    expect(sample.roots[0].children).toHaveLength(10);
    expect(sample.roots[0].more).toBe(true);
    expect(sample.roots[5]).toMatchObject({ children: [], more: true });
    expect(calls.filter((c) => c[1] === "+node-list")).toHaveLength(6);
    // The pages read are part of the tree (greyed until captured): one page of top-level nodes, the children of five.
    expect(one<{ n: number }>(app.db, "select count(*) n from wiki_nodes where wiki_space_id = 'kb-big'")!.n).toBe(50 + 5 * 20);
  });

  it("does nothing on schedule while lark-cli has no login", async () => {
    const app = testApp();
    const calls = fakeLark({ kbs: [{ id: "kb-a", name: "A" }], nodes: {}, loggedIn: false });
    expect((await discoverKnowledgeBases(app, { scheduled: true })).skipped).toMatch(/没有本人登录/);
    expect(calls.some((c) => c[1] === "+space-list")).toBe(false);
  });
});

describe("feishu knowledge bases: proposals and decisions", () => {
  it("lets only the scout propose, for the knowledge bases of its run and the spaces it may write", async () => {
    const app = testApp();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    createSpace(app, { id: "taken", name: "别的空间" });
    fakeLark({ kbs: [{ id: "kb-a", name: "退款组手册" }, { id: "kb-b", name: "行政通知" }], nodes: docs("a", "kb-a", 1) });
    await discoverKnowledgeBases(app);
    const ctx = scout(app, ["kb-a"]);
    const map = { kb: "kb-a", action: "map", space: "project-a", priority: "high", level: "focus", reason: "方向里写了退款" };
    expect((await callTool({ ...ctx, role: "assistant" }, "propose_knowledge_mapping", map)).isError).toBe(true);
    expect((await callTool(ctx, "propose_knowledge_mapping", { ...map, kb: "kb-b" })).text).toMatch(/不在本次任务/);
    expect((await callTool(ctx, "propose_knowledge_mapping", { ...map, space: "nowhere" })).isError).toBe(true);
    expect((await callTool({ ...ctx, spaces: ["personal"] }, "propose_knowledge_mapping", map)).isError).toBe(true);
    const create = { kb: "kb-a", action: "create", new_space: { id: "taken", name: "退款", kind: "topic", description: "退款业务" }, reason: "新领域" };
    expect((await callTool(ctx, "propose_knowledge_mapping", create)).text).toMatch(/已经是「别的空间」/);
    expect((await callTool({ ...ctx, spaces: ["personal", "project-a"] }, "propose_knowledge_mapping", { ...create, new_space: { ...create.new_space, id: "refund" } })).text).toMatch(/不能新建空间/);
    expect((await callTool(ctx, "propose_knowledge_mapping", { ...create, new_space: { ...create.new_space, id: "Bad Id" } })).isError).toBe(true);
    const ok = await callTool(ctx, "propose_knowledge_mapping", map);
    expect(ok.isError).toBe(false);
    expect(getKb(app, "kb-a")).toMatchObject({ status: "proposed", proposal: { action: "map", space: "project-a", priority: "high", level: "focus", by: "kb-scout", runId: ctx.runId } });
    // Nothing applied without the owner.
    expect(getKb(app, "kb-a")!.targetSpace).toBeNull();
    expect(listCrawls(app)).toHaveLength(0);
    const later = await callTool(scout(app, ["kb-b"]), "propose_knowledge_mapping", { kb: "kb-b", action: "later", reason: "看不出内容" });
    expect(later.text).toMatch(/先放着/);
    expect(getKb(app, "kb-b")!.status).toBe("later");
  });

  it("accepting a new-space proposal creates the space, a paused crawl from the top-level nodes and the initial level", async () => {
    const app = testApp();
    fakeLark({ kbs: [{ id: "kb-a", name: "退款组手册" }], nodes: docs("a", "kb-a", 3) });
    await discoverKnowledgeBases(app);
    await proposeMapping(app, "kb-a", { action: "create", newSpace: { id: "refund", name: "退款业务", kind: "topic", description: "退款流程、规则与排查" }, priority: "normal", level: "reference", reason: "和方向一致" }, { by: "kb-scout", runId: null });
    expect(findSpace(app, "refund")).toBeNull();
    const r = await kbAction(app, "kb-a", { action: "accept" });
    expect(findSpace(app, "refund")).toMatchObject({ name: "退款业务", kind: "topic", description: "退款流程、规则与排查" });
    const kb = getKb(app, "kb-a")!;
    expect(kb).toMatchObject({ status: "mapped", targetSpace: "refund", level: "reference", decidedBy: "owner" });
    const crawl = getCrawl(app, kb.crawlId!);
    expect(crawl).toMatchObject({ status: "paused", spaceId: "refund", wikiSpaceId: "kb-a", skipCaptured: true });
    expect(crawl.queue.map((e) => e.title)).toEqual(["a 文档 0", "a 文档 1", "a 文档 2"]);
    expect("crawl" in r && r.crawl && !("queue" in r.crawl)).toBe(true);
    expect(one(app.db, "select level, by, status from source_node_levels where space_id = 'refund' and node_key = 'wiki:kb-a'")).toEqual({ level: "reference", by: "owner", status: "confirmed" });
    // Changing the target: the old crawl stops, a new one starts in the new space.
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    await kbAction(app, "kb-a", { action: "map", space: "project-a" });
    expect(getCrawl(app, crawl.id).status).toBe("stopped");
    expect(getCrawl(app, getKb(app, "kb-a")!.crawlId!).spaceId).toBe("project-a");
    // Ignore and reset.
    await kbAction(app, "kb-a", { action: "ignore" });
    expect(getKb(app, "kb-a")).toMatchObject({ status: "ignored", crawlId: null });
    await expect(proposeMapping(app, "kb-a", { action: "map", space: "personal", priority: "normal", level: "normal", reason: "x" }, { by: "kb-scout", runId: null })).rejects.toThrow(/本人已经定过/);
    await kbAction(app, "kb-a", { action: "reset" });
    expect(getKb(app, "kb-a")).toMatchObject({ status: "new", proposal: null });
    await expect(kbAction(app, "kb-a", { action: "map" })).rejects.toThrow(/space/);
    await expect(kbAction(app, "kb-a", { action: "map", space: "nowhere" })).rejects.toThrow(/没有空间/);
  });

  it("with autoApply, a proposal takes effect at once and one notification lists what was done", async () => {
    const app = testApp();
    app.config.lark.knowledge.autoApply = true;
    fakeLark({ kbs: [{ id: "kb-a", name: "退款组手册" }, { id: "kb-c", name: "退款排查案例" }], nodes: { ...docs("a", "kb-a", 1), ...docs("c", "kb-c", 1) } });
    await discoverKnowledgeBases(app);
    const ctx = scout(app, ["kb-a", "kb-c"]);
    const fresh = { id: "refund", name: "退款业务", kind: "topic", description: "退款流程" };
    expect((await callTool(ctx, "propose_knowledge_mapping", { kb: "kb-a", action: "create", new_space: fresh, reason: "退款" })).text).toMatch(/已应用.*refund/);
    // A second knowledge base of the same domain goes to the same new space.
    expect((await callTool(ctx, "propose_knowledge_mapping", { kb: "kb-c", action: "create", new_space: fresh, reason: "同一领域" })).isError).toBe(false);
    expect([getKb(app, "kb-a")!.targetSpace, getKb(app, "kb-c")!.targetSpace]).toEqual(["refund", "refund"]);
    expect(getKb(app, "kb-a")).toMatchObject({ status: "mapped", decidedBy: "agent" });
    notifyProposals(app, [getKb(app, "kb-a")!, getKb(app, "kb-c")!], ctx.runId);
    const n = listNotifications(app, 5)[0];
    expect(n).toMatchObject({ title: "飞书知识库：按建议处理了 2 个", link: "#/sources/kb" });
    expect(n.body).toMatch(/退款组手册/);
  });
});

describe("feishu knowledge bases: nightly reading", () => {
  it("splits the budget by priority, with fixed shares first", () => {
    const kb = (id: string, priority: "high" | "normal" | "low", dailyShare: number | null = null) => ({ id, priority, dailyShare });
    expect(Object.fromEntries(splitBudget([kb("l", "low"), kb("h", "high"), kb("n", "normal")], 30))).toEqual({ h: 15, n: 10, l: 5 });
    expect(Object.fromEntries(splitBudget([kb("h", "high"), kb("l", "low")], 6))).toEqual({ h: 5, l: 1 });
    expect(Object.fromEntries(splitBudget([kb("a", "normal"), kb("b", "normal"), kb("c", "normal")], 2))).toEqual({ a: 1, b: 1, c: 0 });
    expect(Object.fromEntries(splitBudget([kb("f", "low", 8), kb("h", "high"), kb("n", "normal")], 10))).toEqual({ f: 8, h: 2, n: 0 });
    expect(Object.fromEntries(splitBudget([kb("f", "normal", 50)], 10))).toEqual({ f: 10 });
  });

  it("reads each knowledge base's share, passes over pages the space has, gives a finished one's share to the others and hands them to understanding", async () => {
    const app = testApp();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    createSpace(app, { id: "refund", name: "退款业务", kind: "topic" });
    const nodes = { ...docs("a", "kb-a", 8, { s0: { title: "表格", space: "kb-a", type: "sheet" } }), ...docs("b", "kb-b", 1) };
    const calls = fakeLark({ kbs: [{ id: "kb-a", name: "项目 A 手册" }, { id: "kb-b", name: "退款小库" }], nodes });
    await discoverKnowledgeBases(app);
    // One page of A is already in the space (read from a chat link): not read again.
    await importLarkDocument(app, "project-a", `${ORIGIN}/wiki/a0`, { depth: 0 });
    await kbAction(app, "kb-a", { action: "map", space: "project-a", priority: "normal" });
    await kbAction(app, "kb-b", { action: "map", space: "refund", priority: "normal" });
    const fetches = () => calls.filter((c) => c[1] === "+fetch").length;
    const before = fetches();
    const r = await readKnowledgeDaily(app, { limit: 6 });
    // 3 + 3; B has one page, its other two go to A.
    expect(r.read).toBe(6);
    expect(fetches() - before).toBe(6);
    const a = r.results.filter((x) => x.kb === "kb-a");
    expect(a.reduce((n, x) => n + x.read, 0)).toBe(5);
    expect(a[0]).toMatchObject({ known: 1, share: 3 });
    expect(r.results.find((x) => x.kb === "kb-b")).toMatchObject({ read: 1, done: true });
    expect(all(app.db, "select id from sources where space_id = 'project-a' and kind = 'doc'")).toHaveLength(6);
    expect(listKnowledgeBases(app).find((k) => k.id === "kb-a")!.progress).toMatchObject({ read: 5, known: 1 });
    // Understanding: the usual ingest runs, one per space.
    const ingest = listRuns(app, { kind: "ingest" });
    expect(ingest.map((x) => x.spaceId).sort()).toEqual(["project-a", "refund"]);
    expect(String(ingest[0].input.note)).toMatch(/^飞书知识库/);
    expect(readsSince(app, "2000-01-01")).toBe("从飞书知识库读了 6 篇（项目 A 5 篇、退款业务 1 篇）");
    // While yesterday's material waits to be understood, the space is skipped.
    const next = await readKnowledgeDaily(app, { limit: 6 });
    expect(next.read).toBe(0);
    expect(next.results.find((x) => x.kb === "kb-a")!.skippedBecause).toMatch(/还没整理完/);
    // Once understood, the rest is read; a paused knowledge base is left alone.
    run(app.db, "update runs set status = 'done' where kind = 'ingest'");
    await kbAction(app, "kb-b", { action: "pause" });
    const third = await readKnowledgeDaily(app, { limit: 6 });
    expect(third.results.every((x) => x.kb === "kb-a")).toBe(true);
    expect(third.read).toBe(2);
    expect(listKnowledgeBases(app).find((k) => k.id === "kb-a")!.progress.crawl).toMatchObject({ status: "done", queued: 0 });
  });

  it("gives every page of a knowledge base its initial level, and only-searchable pages are not digested", async () => {
    const app = testApp();
    createSpace(app, { id: "archive", name: "历史资料", kind: "topic" });
    fakeLark({ kbs: [{ id: "kb-h", name: "历史周报" }], nodes: docs("h", "kb-h", 3) });
    await discoverKnowledgeBases(app);
    await kbAction(app, "kb-h", { action: "map", space: "archive", level: "reference" });
    await readKnowledgeDaily(app, { limit: 3 });
    const rows = all<{ node_level: string; node_level_by: string }>(app.db, "select node_level, node_level_by from sources where space_id = 'archive'");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.node_level === "reference" && r.node_level_by === "owner")).toBe(true);
    expect(listRuns(app, { kind: "ingest" })).toHaveLength(0);
  });
});

describe("feishu knowledge bases: peer commands", () => {
  it("check their arguments and write only omem's own data", async () => {
    const app = testApp();
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    fakeLark({ kbs: [{ id: "kb-a", name: "项目 A 手册" }], nodes: docs("a", "kb-a", 2) });
    await discoverKnowledgeBases(app);
    const call = (name: string, args?: unknown) => runPeerCommand(app, name, args) as Promise<any>;
    await expect(call("lark-kb-map", { kb: "../x", action: "accept" })).rejects.toThrow(/kb/);
    await expect(call("lark-kb-map", { kb: "kb-a", action: "delete" })).rejects.toThrow(/action/);
    await expect(call("lark-kb-map", { kb: "kb-a", action: "map" })).rejects.toThrow(/space/);
    await expect(call("lark-kb-map", { kb: "kb-a", action: "accept" })).rejects.toThrow(/还没有建议/);
    await expect(call("lark-kb-read", { kb: "kb-a" })).rejects.toThrow(/还没有归入/);
    await expect(call("lark-kb-read", { limit: 0 })).rejects.toThrow(/limit/);
    await expect(call("lark-kb-list", { status: "whatever" })).rejects.toThrow(/status/);
    const mapped = await call("lark-kb-map", { kb: "kb-a", action: "map", space: "project-a", priority: "high", daily_share: 4 });
    expect(mapped.kb).toMatchObject({ status: "mapped", target: "project-a", priority: "high" });
    expect(mapped.crawl.queued).toBe(2);
    const list = await call("lark-kb-list", { status: "mapped" });
    expect(list.total).toBe(1);
    expect(list.kbs[0]).toMatchObject({ id: "kb-a", dailyShare: 4, progress: { read: 0 } });
    expect(list.counts.mapped).toBe(1);
    expect(list.discovery.last.found).toBe(2);
  });
});

describe("knowledge-base crawls", () => {
  it("move from the old single value to a key each, once", () => {
    const app = testApp();
    const c = { id: "wc_old", spaceId: "personal", root: `${ORIGIN}/wiki/Root`, depth: 2, maxDocs: 10, batch: 2, status: "paused", queue: [], seen: [], read: 1, failed: 0, skipped: 0, ids: [], errors: [], startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
    run(app.db, "insert into kv(key, value) values('lark_wiki_crawls', ?)", JSON.stringify([c]));
    expect(getCrawl(app, "wc_old")).toMatchObject({ status: "paused", read: 1 });
    expect(listCrawls(app).map((x) => x.id)).toEqual(["wc_old"]);
    expect(one(app.db, "select 1 from kv where key = 'lark_wiki_crawls'")).toBeUndefined();
    expect(one(app.db, "select 1 from kv where key = 'lark_wiki_crawl/wc_old'")).toBeTruthy();
  });
});
