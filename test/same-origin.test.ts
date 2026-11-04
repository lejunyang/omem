import { afterEach, expect, it } from "vitest";
import { all, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { embedPending, setEmbedderForTests } from "../src/search/embeddings.ts";
import { search } from "../src/search/search.ts";
import { originKeyOf, upsertSource } from "../src/sources/store.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

afterEach(() => setEmbedderForTests(null));

it("shows the same chat captured into two spaces once, naming the other copy", async () => {
  const app = testApp();
  createSpace(app, { id: "proj-a", name: "项目 A" });
  createSpace(app, { id: "proj-b", name: "项目 B" });
  // Two people's copies of one group: same origin, read at different times, so not the same text.
  const a = upsertSource(app, { spaceId: "proj-a", kind: "chat", uri: "lark:oc_refund", title: "退款群", text: "小王：退款审批改成两级\n小李：收到" });
  const b = upsertSource(app, { spaceId: "proj-b", kind: "chat", uri: "lark:oc_refund", title: "退款群", text: "小王：退款审批改成两级\n小李：收到\n小王：周三上线" });
  const other = upsertSource(app, { spaceId: "proj-b", kind: "note", uri: "note-1", title: "笔记", text: "退款审批的规则另记一份" });
  const hits = (await search(app, "退款审批", { spaces: ["proj-a", "proj-b"] })).filter((h) => h.type === "chunk");
  const ids = hits.map((h) => h.sourceId);
  expect(ids.filter((id) => id === a.id || id === b.id)).toHaveLength(1);
  expect(ids).toContain(other.id);
  const shown = hits.find((h) => h.sourceId === a.id || h.sourceId === b.id)!;
  expect(shown.elsewhere?.map((e) => e.sourceId)).toEqual([shown.sourceId === a.id ? b.id : a.id]);
  // A copy the reader may not see is left out first: the one they can read is shown, and the other is not named.
  const hidden = shown.sourceId;
  const seen = (await search(app, "退款审批", { spaces: ["proj-a", "proj-b"], visible: (id) => id !== hidden })).find((h) => h.sourceId === a.id || h.sourceId === b.id)!;
  expect(seen.sourceId).toBe(hidden === a.id ? b.id : a.id);
  expect(seen.elsewhere).toBeUndefined();
  // Searched in one space, nothing else to name.
  const one_ = (await search(app, "退款审批", { spaces: ["proj-a"] })).find((h) => h.sourceId === a.id)!;
  expect(one_.elsewhere).toBeUndefined();
  app.db.close();
});

it("embeds identical text once, in a batch or after", async () => {
  const app = testApp();
  app.config.embeddings.provider = "local";
  const base = fakeEmbedder();
  let embedded = 0;
  setEmbedderForTests({ id: base.id, async embed(texts) { embedded += texts.length; return base.embed(texts); } });
  createSpace(app, { id: "proj-a", name: "项目 A" });
  createSpace(app, { id: "proj-b", name: "项目 B" });
  createSpace(app, { id: "proj-c", name: "项目 C" });
  const doc = { kind: "doc" as const, uri: "https://tenant.larkoffice.com/docx/D1", title: "《差旅报销制度》", text: "出差住宿按城市分三档报销。" };
  upsertSource(app, { ...doc, spaceId: "proj-a" });
  upsertSource(app, { ...doc, spaceId: "proj-b" });
  while (await embedPending(app)) {}
  expect(embedded).toBe(1);
  // A third copy later: its vector is copied from the others.
  upsertSource(app, { ...doc, spaceId: "proj-c" });
  // Same text under another title is another input: embedded on its own.
  upsertSource(app, { ...doc, spaceId: "proj-c", uri: "note-2", kind: "note", title: "笔记" });
  while (await embedPending(app)) {}
  expect(embedded).toBe(2);
  const vecs = all<{ embedding: Uint8Array }>(app.db, "select embedding from chunks where title = ?", doc.title).map((r) => Buffer.from(r.embedding).toString("base64"));
  expect(vecs).toHaveLength(3);
  expect(new Set(vecs).size).toBe(1);
  expect(one<{ n: number }>(app.db, "select count(*) n from chunks where embedding is null")!.n).toBe(0);
  app.db.close();
});

it("keys a document that carries other files as its reader saw them by that reader", () => {
  const doc = (meta: Record<string, unknown>) => originKeyOf({ kind: "doc", uri: "https://tenant.larkoffice.com/docx/D1", meta: { documentId: "D1", ...meta } });
  expect(doc({ capturedBy: "ann" })).toBe("lark:doc:D1");
  expect(doc({ capturedBy: "ann", perReader: true })).toBe("lark:doc:D1#ann");
  expect(doc({ perReader: true })).toBe("lark:doc:D1#owner");
});
