import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { commitLibrary } from "../src/core/git.ts";
import { spaceDir } from "../src/core/spaces.ts";
import { upsertSource } from "../src/sources/store.ts";
import { buildNav, folderOverview, listPages, movePages, organizeNeeds, pageContext, readPage, restoreAliases, rewriteLinks, serializePage, staleDetail, syncWiki, writePage } from "../src/wiki/store.ts";
import { ancestors, defaultOpen, flattenNav } from "../web/src/lib/wikiTree.ts";
import { testApp } from "./helpers.ts";

const page = (app: ReturnType<typeof testApp>, slug: string, title: string, body = "正文", extra: Record<string, unknown> = {}) =>
  writePage(app, "personal", slug, { meta: { title, summary: `${title}的摘要`, kind: "guide", ...extra }, body }, { commit: false });

describe("wiki folder tree", () => {
  it("builds nested folders from page paths, with counts, stale marks and folder index titles", () => {
    const nav = buildNav([
      { slug: "index", title: "首页", staleSources: 0 },
      { slug: "overview", title: "概览", staleSources: 0 },
      { slug: "flows/ingest", title: "导入", staleSources: 1 },
      { slug: "flows/search/rank", title: "排序", staleSources: 0 },
      { slug: "flows/index", title: "端到端流程", staleSources: 0 },
      { slug: "howto/add-channel", title: "加渠道", staleSources: 0 },
    ]);
    expect(nav.map((n) => n.title)).toEqual(["概览", "端到端流程", "howto"]);
    const flows = nav[1];
    expect(flows).toMatchObject({ folder: "flows", slug: "flows/index", count: 2, stale: 1 });
    expect(flows.children.map((c) => c.title)).toEqual(["导入", "search"]);
    expect(flows.children[1]).toMatchObject({ folder: "flows/search", count: 1 });
    expect(nav[2]).toMatchObject({ folder: "howto", count: 1, stale: 0 });
    expect(nav[2].slug).toBeUndefined();
  });

  it("describes the layout for agents and says what needs sorting", () => {
    const pages = [
      ...Array.from({ length: 7 }, (_, i) => ({ slug: `loose-${i}` })),
      ...Array.from({ length: 45 }, (_, i) => ({ slug: `cases/c${i}` })),
      { slug: "cases/index" },
      { slug: "flows/a/b" },
      { slug: "index" },
    ];
    const text = folderOverview(pages);
    expect(text).toContain("顶层 7 页");
    expect(text).toContain("cases/ 共 45 页");
    expect(text).toContain("  flows/a/ 共 1 页");
    const needs = organizeNeeds(pages);
    expect(needs.loose).toHaveLength(7);
    expect(needs.crowded).toEqual([{ folder: "cases", count: 45 }]);
    expect(organizeNeeds(pages.slice(0, 3)).loose).toEqual([]);
  });
});

describe("moving pages", () => {
  it("rewrites wiki links in the three forms and leaves other spaces alone", () => {
    const map = new Map([["a", "x/a"]]);
    const body = "见 [[a]]、[[a|别名]]、[[a#节]]、[[other:a]]、[[b]]、[x](wiki:a#s)、[[personal:a]]";
    expect(rewriteLinks(body, "personal", { space: "personal", map })).toBe("见 [[x/a]]、[[x/a|别名]]、[[x/a#节]]、[[other:a]]、[[b]]、[x](wiki:x/a#s)、[[personal:x/a]]");
    expect(rewriteLinks("[[a]]", "other", { space: "personal", map })).toBe("[[a]]");
  });

  it("moves a page and a folder: old paths still open, links follow, cited-state is kept", () => {
    const app = testApp();
    const src = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "d.md", title: "d", text: "第一版\n" });
    page(app, "alpha", "甲", `引用[原文](src:${src.id}#L1-L1)，链到 [[beta]] 和 [[gamma]]。`);
    page(app, "beta", "乙", "链到 [[alpha]]");
    page(app, "gamma", "丙", "无");
    page(app, "cases/c1", "案一", "无");
    upsertSource(app, { spaceId: "personal", kind: "doc", uri: "d.md", title: "d", text: "第二版\n" });
    expect(listPages(app, "personal").find((p) => p.slug === "alpha")!.staleSources).toBe(1);

    const r = movePages(app, "personal", [{ from: "alpha", to: "guides/alpha" }, { from: "cases/", to: "kb/cases/" }], { actor: "test" });
    expect(r.moved).toEqual([{ from: "alpha", to: "guides/alpha" }, { from: "cases/c1", to: "kb/cases/c1" }]);
    expect(existsSync(join(spaceDir(app, "personal"), "wiki", "alpha.md"))).toBe(false);
    expect(existsSync(join(spaceDir(app, "personal"), "wiki", "cases"))).toBe(false);

    // The page itself: new path, alias for the old, still stale (moving is not a re-check).
    const moved = readPage(app, "personal", "guides/alpha");
    expect(moved.meta.aliases).toEqual(["alpha"]);
    expect(moved.body).toContain("[[beta]]");
    expect(listPages(app, "personal").find((p) => p.slug === "guides/alpha")!.staleSources).toBe(1);
    // The old path opens the page at its new path.
    expect(readPage(app, "personal", "alpha").slug).toBe("guides/alpha");
    expect(readPage(app, "personal", "cases/c1").slug).toBe("kb/cases/c1");
    expect(pageContext(app, "personal", "alpha").backlinks.map((b) => b.slug)).toEqual(["beta"]);
    // Pages that linked to it now link to the new path, without being counted as re-checked.
    expect(readPage(app, "personal", "beta").body.trim()).toBe("链到 [[guides/alpha]]");
    expect(pageContext(app, "personal", "beta").missingLinks).toEqual([]);
    expect(pageContext(app, "personal", "guides/alpha").missingLinks).toEqual([]);

    // Moving it again keeps both old paths; a rebuild from the files finds the same aliases.
    movePages(app, "personal", [{ from: "guides/alpha", to: "alpha2" }]);
    expect(readPage(app, "personal", "alpha2").meta.aliases?.sort()).toEqual(["alpha", "guides/alpha"]);
    expect(readPage(app, "personal", "alpha").slug).toBe("alpha2");
    app.db.exec("delete from page_aliases");
    app.db.exec("update pages set hash = ''");
    syncWiki(app, "personal");
    expect(readPage(app, "personal", "guides/alpha").slug).toBe("alpha2");
    expect(readPage(app, "personal", "beta").body.trim()).toBe("链到 [[alpha2]]");
    expect(pageContext(app, "personal", "alpha2").backlinks.map((b) => b.slug)).toEqual(["beta"]);
  });

  it("keeps old paths when a moved page is rewritten, and restores the ones earlier rewrites lost", () => {
    const app = testApp();
    page(app, "a", "甲");
    movePages(app, "personal", [{ from: "a", to: "dir/a" }]);
    // A writer sends title, summary and kind only; the old path stays.
    writePage(app, "personal", "dir/a", { meta: { title: "甲二", summary: "摘要", kind: "case" }, body: "新正文" });
    expect(readPage(app, "personal", "dir/a").meta.aliases).toEqual(["a"]);
    expect(readPage(app, "personal", "a").slug).toBe("dir/a");

    // Before that, a rewrite dropped them: emulate it, committed like any page write.
    page(app, "b", "乙");
    page(app, "e", "戊");
    movePages(app, "personal", [{ from: "b", to: "dir/b" }, { from: "e", to: "dir/e" }]);
    for (const slug of ["dir/b", "dir/e"]) writeFileSync(join(spaceDir(app, "personal"), "wiki", `${slug}.md`), serializePage({ title: slug }, "重写过的正文"));
    app.db.exec("update pages set hash = ''");
    syncWiki(app, "personal");
    commitLibrary(app.libraryDir, "test: rewrite without aliases");
    expect(() => readPage(app, "personal", "b")).toThrow(/不存在/);
    // A page now lives at one of the lost paths; the other page moves on.
    page(app, "e", "新的戊");
    movePages(app, "personal", [{ from: "dir/b", to: "dir2/b" }]);

    const dry = restoreAliases(app, "personal", { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, pages: 1, aliases: 1, sample: [{ page: "dir2/b", aliases: ["b"] }] });
    expect(() => readPage(app, "personal", "b")).toThrow(/不存在/);
    restoreAliases(app, "personal");
    expect(readPage(app, "personal", "b").slug).toBe("dir2/b");
    expect(readPage(app, "personal", "dir2/b").meta.aliases?.sort()).toEqual(["b", "dir/b"]);
    expect(readPage(app, "personal", "e").meta.title).toBe("新的戊");
    // Running it again finds nothing more.
    expect(restoreAliases(app, "personal").pages).toBe(0);
  });

  it("refuses moves that would collide or break the tree", () => {
    const app = testApp();
    page(app, "a", "甲");
    page(app, "b", "乙");
    page(app, "dir/x", "丙");
    expect(() => movePages(app, "personal", [{ from: "a", to: "b" }])).toThrow(/目标已有页面/);
    expect(() => movePages(app, "personal", [{ from: "a", to: "dir" }])).toThrow(/是一个目录/);
    expect(() => movePages(app, "personal", [{ from: "a", to: "b/c" }])).toThrow(/是一个页面/);
    expect(() => movePages(app, "personal", [{ from: "a", to: "../x" }])).toThrow(/不合法/);
    expect(() => movePages(app, "personal", [{ from: "a", to: "index" }])).toThrow(/首页/);
    expect(() => movePages(app, "personal", [{ from: "nope", to: "z" }])).toThrow(/不存在/);
    expect(() => movePages(app, "personal", [{ from: "a", to: "z/" }])).toThrow(/以 \/ 结尾/);
    expect(() => movePages(app, "personal", [{ from: "a", to: "z" }, { from: "b", to: "z" }])).toThrow(/同一个位置/);
    // A swap is fine: targets may be other moves' sources.
    movePages(app, "personal", [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
    expect(readPage(app, "personal", "a").meta.title).toBe("乙");
    expect(readPage(app, "personal", "b").meta.title).toBe("甲");
  });

  it("move_page and confirm_page tools work for the page writer and keep within the space", async () => {
    const app = testApp();
    const src = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "e.md", title: "e", text: "v1\n" });
    page(app, "p", "页", `[引用](src:${src.id}#L1-L1)`);
    upsertSource(app, { spaceId: "personal", kind: "doc", uri: "e.md", title: "e", text: "v2\n" });
    expect(staleDetail(app, "personal").map((s) => s.slug)).toEqual(["p"]);
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" };
    const out = await callTool(ctx, "move_page", { moves: [{ from: "p", to: "docs/p" }], reason: "归类" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("docs/p");
    expect((await callTool(ctx, "move_page", { moves: [{ from: "docs/p", to: "index" }] })).isError).toBe(true);
    expect((await callTool({ ...ctx, spaces: ["other"] }, "move_page", { moves: [{ from: "docs/p", to: "p" }] })).isError).toBe(true);
    expect(staleDetail(app, "personal")[0].slug).toBe("docs/p");
    expect((await callTool(ctx, "confirm_page", { page: "p" })).text).toContain("docs/p");
    expect(staleDetail(app, "personal")).toEqual([]);
    const listed = await callTool(ctx, "list_pages", { folder: "docs" });
    expect(listed.text).toContain("docs/p");
  });
});

describe("navigation rows", () => {
  const nav = buildNav([
    { slug: "overview", title: "概览", staleSources: 0 },
    { slug: "flows/ingest", title: "导入", staleSources: 0 },
    { slug: "flows/search/rank", title: "排序", staleSources: 1 },
    { slug: "flows/search/recall", title: "召回", staleSources: 0 },
    { slug: "howto/add-channel", title: "加渠道", staleSources: 0 },
  ]);
  it("lists only what the open folders show", () => {
    const rows = flattenNav(nav as never, new Set(["flows"]));
    expect(rows.map((r) => `${r.depth}:${r.isFolder ? "d" : "p"}:${r.node.title}`)).toEqual(["0:p:概览", "0:d:flows", "1:p:导入", "1:d:search", "0:d:howto"]);
    expect(rows.find((r) => r.node.title === "flows")!.open).toBe(true);
    expect(flattenNav(nav as never, new Set()).map((r) => r.node.title)).toEqual(["概览", "flows", "howto"]);
  });
  it("opens the way to the current page and, in a small wiki, the top-level folders; filtering shows matches under their folders", () => {
    expect(ancestors("flows/search/rank")).toEqual(["flows", "flows/search"]);
    expect([...defaultOpen(nav as never, "flows/search/rank", 100)].sort()).toEqual(["flows", "flows/search"]);
    expect([...defaultOpen(nav as never, "overview", 5)].sort()).toEqual(["flows", "howto"]);
    const hit = flattenNav(nav as never, new Set(), "排序");
    expect(hit.map((r) => r.node.title)).toEqual(["flows", "search", "排序"]);
    // A folder that matches by name keeps all its pages.
    expect(flattenNav(nav as never, new Set(), "howto").map((r) => r.node.title)).toEqual(["howto", "加渠道"]);
    expect(flattenNav(nav as never, new Set(), "没有这个")).toEqual([]);
  });
});
