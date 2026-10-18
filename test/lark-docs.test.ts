import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { csvToTable, importLarkDocument, missingDocs, refreshLarkDocs, retryMissingDocs } from "../src/channels/lark-docs.ts";
import { all, one } from "../src/core/db.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ORIGIN = "https://example.feishu.cn";

/** A fake lark-cli: docs by token, media downloads written into the cwd it was given. */
function fakeCli(docs: Record<string, { title: string; content: string; revision?: number } | "denied">) {
  const calls: string[][] = [];
  setLarkCliForTests(async (args, cwd) => {
    calls.push(args);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    if (args[0] === "docs" && args[1] === "+fetch") {
      const token = flag("--doc").split("/").pop()!;
      if (args.includes("--scope")) return { ok: true, data: { document: { content: `<fragment>同步块正文 ![](${ORIGIN}/file/IMGSYNC)</fragment>`, revision_id: 1 } } };
      const d = docs[token];
      if (!d) throw new Error("not found");
      if (d === "denied") throw new Error("permission denied: no access to this document");
      return { ok: true, data: { document: { document_id: `doc_${token}`, revision_id: d.revision ?? 1, content: `<title>${d.title}</title>\n${d.content}` } } };
    }
    if (args[0] === "docs" && (args[1] === "+media-download" || args[1] === "+media-preview")) {
      // Tokens starting with NODL can be previewed but not downloaded; NONE can do neither.
      if (flag("--token").startsWith("NONE") || (args[1] === "+media-download" && flag("--token").startsWith("NODL"))) throw new Error("飞书 CLI：api_error 403 forbidden");
      writeFileSync(join(cwd!, flag("--output")), Buffer.concat([PNG, Buffer.from(flag("--token"))]));
      return { ok: true, data: {} };
    }
    if (args[0] === "sheets" && args[1] === "+csv-get") return { ok: true, data: { csv: '名称,数量\n苹果,3\n"梨,大",5\n' } };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return calls;
}

afterEach(() => setLarkCliForTests(null));

describe("feishu docs as originals", () => {
  it("keeps media local, reads sheets and synced blocks, and imports linked docs", async () => {
    const app = testApp();
    const calls = fakeCli({
      Main: {
        title: "项目 A 方案",
        content: [
          `![架构图](${ORIGIN}/file/IMG1)`,
          `<img name="1.jpg" alt="截图：报销流程" mime="image/jpeg" src="IMG2"/>`,
          `<whiteboard token="WB1"></whiteboard>`,
          `<figure><source name="演示.mp4" mime="video/mp4" size="1024" token="VID1"/></figure>`,
          `<figure><source name="讲解.mp4" mime="video/mp4" size="62914560" token="VID3"/></figure>`,
          `<figure><source name="长录屏.mov" mime="video/quicktime" size="115365413" token="VID2"/></figure>`,
          `<sheet sheet-id="s1" token="SHT1"></sheet>`,
          `<bitable table-id="tbl1" token="BT1"></bitable>`,
          `<synced_reference src-block-id="blk1" src-token="SYNC1"></synced_reference>`,
          `详见 <cite doc-id="Linked1" file-type="wiki" title="《差旅报销制度》" type="doc"></cite>，以及 ${ORIGIN}/docx/Linked2?from=x 和 <cite doc-id="Secret" file-type="docx" title="内部文档" type="doc"></cite>`,
          `负责人 <cite type="user" user-id="ou_1" user-name="小王"></cite>`,
        ].join("\n\n"),
      },
      Linked1: { title: "差旅报销制度", content: `正文，回到 ${ORIGIN}/docx/Main` },
      Linked2: { title: "附录", content: `![](${ORIGIN}/file/IMG3) 另见 ${ORIGIN}/wiki/Deep 和 ${ORIGIN}/docx/Secret2` },
      Deep: { title: "第二层", content: `再往下 ${ORIGIN}/wiki/Deeper` },
      Secret2: "denied",
      Deeper: { title: "第三层", content: "不读" },
      Secret: "denied",
    });
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/docx/Main?from=chat`);
    expect(r.status).toBe("created");
    const src = one<{ text: string; uri: string; meta: string }>(app.db, "select text, uri, meta from sources where id = ?", r.id)!;
    expect(src.uri).toBe(`${ORIGIN}/docx/Main`);
    const files = [...src.text.matchAll(/omem-file:([\w.]+)/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect(existsSync(join(app.filesDir, f))).toBe(true);
    expect(src.text).toMatch(/!\[架构图\]\(omem-file:[a-f0-9]{16}\.png\)/);
    // DocxXML images, whiteboards and videos become HTML: they often sit inside tables.
    expect(src.text).toMatch(/<img src="omem-file:[a-f0-9]{16}\.png" alt="截图：报销流程" \/>/);
    expect(src.text).toMatch(/<img src="omem-file:[\w.]+" alt="画板" \/>/);
    expect(src.text).toMatch(/<video src="omem-file:[\w.]+" controls preload="metadata" title="演示.mp4"><\/video>/);
    // 60 MB is under the default 100 MB limit; 110 MB is not.
    expect(src.text).toContain('title="讲解.mp4"');
    expect(src.text).toContain(`<a href="${ORIGIN}/docx/Main">视频：长录屏.mov（110 MB，未下载，在飞书中查看）</a>`);
    expect(src.text).toContain("| 梨,大 | 5 |");
    expect(src.text).toContain(`<a href="${ORIGIN}/base/BT1?table=tbl1">多维表格</a>`);
    expect(src.text).toContain("同步块正文");
    expect(src.text).toContain("@小王");
    expect(src.text).not.toMatch(/feishu\.cn\/file\//);
    expect(src.text).not.toMatch(/<(whiteboard|source|sheet|cite)\b|<img(?! src="omem-file:)/);

    // Linked docs: imported, linked locally; the one without permission stays a Feishu link and is recorded.
    // Two levels by default: Main → Linked1, Linked2 → Deep; Deeper is not read.
    expect(r.related).toHaveLength(3);
    expect(one(app.db, "select id from sources where uri = ?", `${ORIGIN}/wiki/Deeper`)).toBeUndefined();
    const deep = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", `${ORIGIN}/wiki/Deep`)!;
    expect(deep.text).toContain(`${ORIGIN}/wiki/Deeper`);
    const linked1 = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", `${ORIGIN}/wiki/Linked1`)!;
    const linked2 = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", `${ORIGIN}/docx/Linked2`)!;
    expect(src.text).toContain(`<a href="src:${linked1.id}">《差旅报销制度》</a>`);
    expect(src.text).toContain(`(src:${linked2.id})`);
    expect(src.text).toContain(`<a href="${ORIGIN}/docx/Secret">内部文档</a>`);
    // A link back to the doc being imported is filled in once it is saved.
    expect(linked1.text).toContain(`(src:${r.id})`);
    expect(linked2.text).toContain("omem-file:");
    expect(linked2.text).toContain(`(src:${deep.id})`);
    expect(r.missing.map((m) => m.url)).toEqual([`${ORIGIN}/docx/Secret`, `${ORIGIN}/docx/Secret2`]);
    expect(missingDocs(app)).toMatchObject([{ url: `${ORIGIN}/docx/Secret2`, parents: [linked2.id] }, { url: `${ORIGIN}/docx/Secret`, parents: [r.id] }]);
    expect(all(app.db, "select title from notifications").map((n: any) => n.title)).toEqual(["《项目 A 方案》链接的飞书文档中有 2 篇读不到"]);

    // Seven media in all (including the synced block's and a linked doc's); Main is read once despite the link back.
    expect(calls.filter((c) => c[1] === "+media-download")).toHaveLength(7);
    expect(calls.filter((c) => c[1] === "+fetch" && c[3].endsWith("/Main"))).toHaveLength(1);
    // Read again: cached media are not downloaded again, linked docs read today are not read again.
    const second = fakeCli({ Main: { title: "项目 A 方案", content: `![架构图](${ORIGIN}/file/IMG1) <cite doc-id="Linked1" file-type="wiki" title="制度" type="doc"></cite>`, revision: 2 } });
    const again = await importLarkDocument(app, "personal", `${ORIGIN}/docx/Main`);
    expect(again).toMatchObject({ id: r.id, status: "updated", related: [] });
    expect(second.map((c) => c[1])).toEqual(["+fetch"]);
  });

  it("retries docs without permission and only rewrites the link in the parent", async () => {
    const app = testApp();
    fakeCli({ Main: { title: "周报", content: `见 <cite doc-id="Secret" file-type="docx" title="内部文档" type="doc"></cite>` }, Secret: "denied" });
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/docx/Main`);
    expect(r.missing).toHaveLength(1);
    // Throttled to every 6 hours unless forced.
    expect((await retryMissingDocs(app)).tried).toBe(0);
    fakeCli({ Secret: { title: "内部文档", content: "现在能读了" } });
    const retried = await retryMissingDocs(app, { force: true });
    expect(retried.imported).toHaveLength(1);
    const secret = retried.imported[0].id;
    const parent = one<{ text: string; meta: string }>(app.db, "select text, meta from sources where id = ?", r.id)!;
    expect(parent.text).toBe(`见 <a href="src:${secret}">内部文档</a>`);
    expect(JSON.parse(parent.meta).missing).toEqual({});
    expect(missingDocs(app)).toEqual([]);
  });

  it("refreshes old copies without handing unchanged content to ingest", async () => {
    const app = testApp();
    upsertSource(app, { spaceId: "personal", kind: "doc", uri: `${ORIGIN}/wiki/Old`, title: "旧文档", text: `![](${ORIGIN}/file/IMG9)`, meta: { url: `${ORIGIN}/wiki/Old`, via: "lark-cli" } });
    fakeCli({ Old: { title: "旧文档", content: `![](${ORIGIN}/file/IMG9)\n\n${ORIGIN}/docx/New` }, New: { title: "新链接的文档", content: "新内容" } });
    const r = await refreshLarkDocs(app);
    expect(r).toMatchObject({ total: 1, done: 1, failed: 0 });
    const old = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", `${ORIGIN}/wiki/Old`)!;
    expect(old.text).toContain("omem-file:");
    const added = one<{ id: string }>(app.db, "select id from sources where uri = ?", `${ORIGIN}/docx/New`)!;
    // Only the newly linked doc is new material; the old one only had its media made local.
    expect(r.changed).toEqual([{ spaceId: "personal", ids: [added.id] }]);
  });

  it("turns DocxXML layout blocks into HTML whose Markdown still renders", async () => {
    const app = testApp();
    fakeCli({
      Main: {
        title: "周报",
        content: [
          `<grid>\n<column width-ratio="0.500000">\n![图示 uiMaps\\[i\\] 映射](${ORIGIN}/file/IMGA)\n</column>\n<column width-ratio="0.500000">\n**右栏**\n</column>\n</grid>`,
          `<callout emoji="💡"><p>提示</p></callout>`,
          `<table><tr><td><img alt="表里的图" src="IMGB"/></td><td><cite doc-id="Sub" file-type="docx" title="子文档" type="doc"></cite></td></tr></table>`,
          `<button action="OpenLink" src="https://example.com/x">观看回放</button>`,
          `<bookmark name="工单" href="https://example.com/t?a=1&amp;b=2"></bookmark>`,
          `<checkbox done="true">已完成</checkbox> <checkbox done="false">未完成</checkbox>`,
          `<sub-page-list wiki-token="W"><sub-page doc-id="Page1" file-type="docx" title="子页面"/></sub-page-list>`,
          `<chat_card name="项目群" chat-id="oc_x"></chat_card>`,
        ].join("\n\n"),
      },
      Sub: { title: "子文档", content: "x" },
      Page1: { title: "子页面", content: "y" },
    });
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/docx/Main`);
    const text = one<{ text: string }>(app.db, "select text from sources where id = ?", r.id)!.text;
    expect(text).toMatch(/<div class="doc-grid">\n\n+<div class="doc-col" style="flex-grow: 50">\n\n!\[图示 uiMaps\\\[i\\\] 映射\]\(omem-file:/);
    expect(text).toContain('<blockquote class="doc-callout">\n\n💡 <p>提示</p>');
    expect(text).toMatch(/<td><img src="omem-file:[\w.]+" alt="表里的图" \/><\/td><td><a href="src:s\w+">子文档<\/a><\/td>/);
    expect(text).toContain('<a href="https://example.com/x">观看回放</a>');
    expect(text).toContain('<a href="https://example.com/t?a=1&amp;b=2">工单</a>');
    expect(text).toContain("☑ 已完成 ☐ 未完成");
    expect(text).toMatch(/- <a href="src:s\w+">子页面<\/a>/);
    expect(text).toContain("［群：项目群］");
    expect(text).not.toMatch(/<(grid|column|callout|button|bookmark|checkbox|sub-page|chat_card)\b/);
    expect(r.related).toHaveLength(2);
  });

  it("falls back to the preview when media cannot be downloaded", async () => {
    const app = testApp();
    const calls = fakeCli({ Main: { title: "周报", content: `![可预览](${ORIGIN}/file/NODL1)\n\n![都不行](${ORIGIN}/file/NONE1)` } });
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/docx/Main`);
    const src = one<{ text: string; meta: string }>(app.db, "select text, meta from sources where id = ?", r.id)!;
    expect(src.text).toMatch(/!\[可预览\]\(omem-file:/);
    expect(src.text).toContain(`![都不行](${ORIGIN}/file/NONE1)`);
    expect(JSON.parse(src.meta).media.NONE1).toBe("");
    expect(calls.filter((c) => c[1] === "+media-preview").map((c) => c[3])).toEqual(["NODL1", "NONE1"]);
  });

  it("takes the media size limit and link depth from the config", async () => {
    const app = testApp();
    app.config.lark.capture = { ...app.config.lark.capture, docMediaMaxMB: 1, docLinkDepth: 0 };
    fakeCli({ Main: { title: "周报", content: `<source name="a.mp4" mime="video/mp4" size="2097152" token="V"/> ${ORIGIN}/docx/Other` }, Other: { title: "另一篇", content: "x" } });
    const r = await importLarkDocument(app, "personal", `${ORIGIN}/docx/Main`);
    const text = one<{ text: string }>(app.db, "select text from sources where id = ?", r.id)!.text;
    expect(text).toContain("（2.0 MB，未下载，在飞书中查看）");
    expect(r.related).toEqual([]);
    expect(text).toContain(`${ORIGIN}/docx/Other`);
  });

  it("turns CSV into a Markdown table", () => {
    expect(csvToTable('a,b\n1,"x|y"\n2\n')).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |\n| 2 |  |");
    expect(csvToTable("h\n1\n2\n3", 2)).toContain("另有 1 行未展开");
  });
});
