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
    if (args[0] === "docs" && args[1] === "+media-download") {
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
          `<figure><source name="长录屏.mov" mime="video/quicktime" size="115365413" token="VID2"/></figure>`,
          `<sheet sheet-id="s1" token="SHT1"></sheet>`,
          `<bitable table-id="tbl1" token="BT1"></bitable>`,
          `<synced_reference src-block-id="blk1" src-token="SYNC1"></synced_reference>`,
          `详见 <cite doc-id="Linked1" file-type="wiki" title="《差旅报销制度》" type="doc"></cite>，以及 ${ORIGIN}/docx/Linked2?from=x 和 <cite doc-id="Secret" file-type="docx" title="内部文档" type="doc"></cite>`,
          `负责人 <cite type="user" user-id="ou_1" user-name="小王"></cite>`,
        ].join("\n\n"),
      },
      Linked1: { title: "差旅报销制度", content: `正文，回到 ${ORIGIN}/docx/Main` },
      Linked2: { title: "附录", content: `![](${ORIGIN}/file/IMG3)` },
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
    expect(src.text).toContain("![截图：报销流程](omem-file:");
    expect(src.text).toContain("![画板](omem-file:");
    expect(src.text).toContain("![视频：演示.mp4](omem-file:");
    expect(src.text).toMatch(/\[视频：长录屏\.mov（110 MB，未下载，在飞书中查看）\]\(https:\/\/example\.feishu\.cn\/docx\/Main\)/);
    expect(src.text).toContain("| 梨,大 | 5 |");
    expect(src.text).toContain(`[多维表格](${ORIGIN}/base/BT1?table=tbl1)`);
    expect(src.text).toContain("同步块正文");
    expect(src.text).toContain("@小王");
    expect(src.text).not.toMatch(/feishu\.cn\/file\//);
    expect(src.text).not.toMatch(/<(img|whiteboard|source|sheet|cite)\b/);

    // Linked docs: imported, linked locally; the one without permission stays a Feishu link and is recorded.
    expect(r.related).toHaveLength(2);
    const linked1 = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", `${ORIGIN}/wiki/Linked1`)!;
    const linked2 = one<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", `${ORIGIN}/docx/Linked2`)!;
    expect(src.text).toContain(`[《差旅报销制度》](src:${linked1.id})`);
    expect(src.text).toContain(`(src:${linked2.id})`);
    expect(src.text).toContain(`[内部文档](${ORIGIN}/docx/Secret)`);
    // A linked doc's own links point at local copies but are not followed further.
    expect(linked1.text).toContain(`(src:${r.id})`);
    expect(linked2.text).toContain("omem-file:");
    expect(r.missing.map((m) => m.title)).toEqual(["内部文档"]);
    expect(missingDocs(app)).toMatchObject([{ url: `${ORIGIN}/docx/Secret`, parents: [r.id] }]);
    expect(all(app.db, "select title from notifications").map((n: any) => n.title)).toEqual([expect.stringContaining("1 篇链接的飞书文档读不到")]);

    // Six media in all (including the synced block's and the linked doc's).
    expect(calls.filter((c) => c[1] === "+media-download")).toHaveLength(6);
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
    expect(parent.text).toBe(`见 [内部文档](src:${secret})`);
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

  it("turns CSV into a Markdown table", () => {
    expect(csvToTable('a,b\n1,"x|y"\n2\n')).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |\n| 2 |  |");
    expect(csvToTable("h\n1\n2\n3", 2)).toContain("另有 1 行未展开");
  });
});
