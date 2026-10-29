import { afterEach, describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { resetLarkAuthForTests } from "../src/channels/lark-auth.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { importLarkDocument } from "../src/channels/lark-docs.ts";
import { clearWikiLocationCache } from "../src/channels/lark-wiki.ts";
import { all, one, run } from "../src/core/db.ts";
import { prepareShare, readShare } from "../src/core/shares.ts";
import { search } from "../src/search/search.ts";
import { addSourceNote, setAttention, sourceNotes } from "../src/sources/attention.ts";
import { aliasTarget, findDuplicateDocs, mergeDuplicateDocs } from "../src/sources/duplicates.ts";
import { getSource, readSource, upsertSource } from "../src/sources/store.ts";
import { remember } from "../src/memory/store.ts";
import { testApp } from "./helpers.ts";

const ORIGIN = "https://tenant.larkoffice.com";
const BODY = "# 退款规则\n退款按已发货行计算。\n审批：组长审批即可。\n# 附录\n无";

afterEach(() => {
  setLarkCliForTests(null);
  resetLarkAuthForTests();
});

/** A /docx/ copy and a /wiki/ copy of the same document (same document id), as older captures left them. */
function pair(app: ReturnType<typeof testApp>, space = "personal") {
  const docx = upsertSource(app, { spaceId: space, kind: "doc", uri: `${ORIGIN}/docx/dxA`, title: "退款方案", text: BODY, meta: { via: "lark-cli", url: `${ORIGIN}/docx/dxA`, token: "dxA", documentId: "dxA" } }).id;
  const wiki = upsertSource(app, { spaceId: space, kind: "doc", uri: `${ORIGIN}/wiki/wnA`, title: "退款方案", text: `${BODY}\n\n---\n\n**知识库子页面**`, meta: { via: "lark-cli", url: `${ORIGIN}/wiki/wnA`, token: "wnA", documentId: "dxA", wikiNodeToken: "wnA", wikiSpaceId: "kb" } }).id;
  return { docx, wiki };
}

describe("the same document captured by its docx link and as a knowledge-base page", () => {
  it("merges into the wiki copy: notes, level and references move; the old id stays an alias everywhere", async () => {
    const app = testApp();
    const { docx, wiki } = pair(app);
    addSourceNote(app, { sourceId: docx, lineStart: 3, lineEnd: 3, kind: "outdated", note: "现在要财务复核", by: "owner" });
    setAttention(app, [docx], "focus", "owner");
    const mem = remember(app, { spaceId: "personal", kind: "fact", content: "退款按已发货行计算", sourceRefs: [`src:${docx}#L2`] });
    expect(findDuplicateDocs(app).map((p) => [p.docx.id, p.wiki.id])).toEqual([[docx, wiki]]);

    // Dry run by default: nothing changes.
    expect(mergeDuplicateDocs(app)).toMatchObject({ dryRun: true, pairs: 1 });
    expect(getSource(app, docx).id).toBe(docx);

    const r = mergeDuplicateDocs(app, { dryRun: false });
    expect(r).toMatchObject({ merged: 1 });
    expect(aliasTarget(app, docx)).toBe(wiki);
    expect(sourceNotes(app, wiki)).toEqual([expect.objectContaining({ kind: "outdated", lineStart: 3, lineEnd: 3 })]);
    expect(getSource(app, wiki).attention).toBe("focus");
    // Old ids resolve: getSource / readSource, read_source, citations in memories, share snapshots.
    expect(getSource(app, docx).id).toBe(wiki);
    expect(readSource(app, docx, 2, 2).text).toBe("退款按已发货行计算。");
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent" };
    expect((await callTool(ctx, "read_source", { source: `src:${docx}#L2` })).text).toContain(`原件 ${wiki}`);
    expect(one<{ source_refs: string }>(app.db, "select source_refs from memories where id = ?", mem.id)!.source_refs).toContain(docx);
    app.config.webUrl = "https://omem.example.com";
    const share = prepareShare(app, { refs: [{ ref: `src:${docx}#L2-L3`, label: "退款方案" }] });
    share!.save();
    expect(readShare(app, share!.url.split("/").pop()!)?.items[0]).toMatchObject({ kind: "source", lines: expect.arrayContaining(["退款按已发货行计算。"]) });
    // Search finds only the wiki copy; merging again finds nothing; the docx row is a tombstone with its text.
    expect([...new Set((await search(app, "退款 已发货", { spaces: ["personal"], types: ["chunk"] })).map((h) => h.sourceId))]).toEqual([wiki]);
    expect(mergeDuplicateDocs(app, { dryRun: false })).toMatchObject({ pairs: 0, merged: 0 });
    expect(one(app.db, "select deleted_at is not null gone, length(text) > 0 kept from sources where id = ?", docx)).toEqual({ gone: 1, kept: 1 });
    expect(JSON.parse(one<{ detail: string }>(app.db, "select detail from source_aliases where alias_id = ?", docx)!.detail)).toMatchObject({ notes: [expect.objectContaining({ from: [3, 3], to: [3, 3] })] });
  });

  it("resolves a docx link to the knowledge-base copy at capture, so no new pair appears", async () => {
    const app = testApp();
    clearWikiLocationCache(app);
    setLarkCliForTests(async (args) => {
      const flag = (name: string) => args[args.indexOf(name) + 1];
      if (args[0] === "docs" && args[1] === "+fetch") return { ok: true, data: { document: { document_id: "dxB", revision_id: 1, content: `<title>发布方案</title>\n发布流程` } } };
      if (args[0] === "wiki" && args[1] === "+node-get") {
        const t = flag("--node-token").split("/").pop();
        if (t !== "wnB" && t !== "dxB") return { ok: false, error: { code: 131014, message: "131014 not in wiki" } };
        return { ok: true, data: { space_id: "kb", node_token: "wnB", obj_token: "dxB", obj_type: "docx", node_type: "origin", title: "发布方案", has_child: false } };
      }
      if (args[0] === "wiki" && args[1] === "spaces") return { ok: true, data: { space: { space_id: "kb", name: "项目 A 知识库" } } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    // A docx link of a doc that turns out to be in a knowledge base is stored as the wiki page.
    const first = await importLarkDocument(app, "personal", `${ORIGIN}/docx/dxB`, { depth: 0 });
    expect(getSource(app, first.id).uri).toBe(`${ORIGIN}/wiki/wnB`);
    // The wiki link and the docx link again: the same source.
    expect((await importLarkDocument(app, "personal", `${ORIGIN}/wiki/wnB`, { depth: 0 })).id).toBe(first.id);
    expect((await importLarkDocument(app, "personal", `${ORIGIN}/docx/dxB`, { depth: 0 })).id).toBe(first.id);
    expect(all(app.db, "select id from sources where kind = 'doc'")).toHaveLength(1);
  });

  it("shows one of several identical documents in search and says how many others have the same content", async () => {
    const app = testApp();
    const text = "# 值班手册\n报警先看大盘，再看最近的发布。";
    const ids = ["a.md", "b.md", "c.md"].map((uri) => upsertSource(app, { spaceId: "personal", kind: "doc", uri, title: uri, text }).id);
    const hits = (await search(app, "报警 大盘 发布", { spaces: ["personal"] })).filter((h) => h.type === "chunk");
    expect(hits).toHaveLength(1);
    expect(hits[0].sameAs?.map((s) => s.sourceId).sort()).toEqual(ids.filter((id) => id !== hits[0].sourceId).sort());
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent" };
    expect((await callTool(ctx, "search", { query: "报警 大盘 发布" })).text).toContain("另有 2 份相同内容");
    run(app.db, "select 1");
  });
});
