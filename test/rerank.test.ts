import { afterEach, describe, expect, it } from "vitest";
import { passiveRecall } from "../src/memory/passive.ts";
import { remember } from "../src/memory/store.ts";
import { embedPending, embedPendingMemories, setEmbedderForTests } from "../src/search/embeddings.ts";
import { rerankScores, rerankStatus, setRerankerForTests } from "../src/search/rerank.ts";
import { search } from "../src/search/search.ts";
import { upsertSource } from "../src/sources/store.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

afterEach(() => setRerankerForTests(null));

function library() {
  const app = testApp();
  for (const [uri, text] of [
    ["a.md", "# 报销\n报销流程：报销单提交后由部门经理审批。"],
    ["b.md", "# 差旅\n报销标准：一线城市住宿每晚 600 元，报销时附发票。"],
    ["c.md", "# 周报\n报销相关的问题统一在周报里汇总。"],
  ]) upsertSource(app, { spaceId: "personal", kind: "doc", uri, title: uri, text });
  return app;
}

describe("rerank", () => {
  it("reorders the head of the fused list by the reranker and keeps the order when off or failing", async () => {
    const app = library();
    const fused = (await search(app, "报销", { types: ["chunk"] })).map((h) => h.uri);
    expect(fused).toHaveLength(3);

    app.config.rerank.enabled = true;
    setRerankerForTests((_q, passages) => passages.map((p) => (p.includes("600 元") ? 0.9 : p.includes("审批") ? 0.5 : 0.1)));
    const hits = await search(app, "报销", { types: ["chunk"] });
    expect(hits.map((h) => h.uri)).toEqual(["b.md", "a.md", "c.md"]);
    expect(hits[0].rerank).toBe(0.9);
    // The reranker reads the whole chunk with its heading, not the snippet.
    let seen: string[] = [];
    setRerankerForTests((_q, passages) => ((seen = passages), passages.map(() => 0.5)));
    await search(app, "报销", { types: ["chunk"] });
    expect(seen.some((p) => p.startsWith("差旅\n") && p.includes("附发票"))).toBe(true);

    expect((await search(app, "报销", { types: ["chunk"], rerank: false })).map((h) => h.uri)).toEqual(fused);
    setRerankerForTests(() => {
      throw new Error("boom");
    });
    const kept = await search(app, "报销", { types: ["chunk"] });
    expect(kept.map((h) => h.uri)).toEqual(fused);
    expect(kept[0].rerank).toBeUndefined();
  });

  it("returns more than the limit only internally: the first `top` are reranked, then cut", async () => {
    const app = library();
    app.config.rerank = { ...app.config.rerank, enabled: true, top: 5 };
    setRerankerForTests((_q, passages) => passages.map((p) => (p.includes("周报") ? 0.99 : 0.2)));
    const hits = await search(app, "报销", { types: ["chunk"], limit: 1 });
    expect(hits.map((h) => h.uri)).toEqual(["c.md"]);
  });

  it("is off by default and reports its state", async () => {
    const app = library();
    expect(await rerankScores(app, "报销", ["a"])).toBeNull();
    expect(rerankStatus(app)).toMatchObject({ enabled: false });
  });

  it("gates passive recall on the reranker's relevance, falling back to the cosine gate", async () => {
    const app = testApp();
    app.config.embeddings.provider = "local";
    setEmbedderForTests(fakeEmbedder());
    const deploy = remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 每周二下午发布，发布前要先跑回归测试。" }).id;
    const near = remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 每周二下午开周会。" }).id;
    await embedPending(app);
    while (await embedPendingMemories(app)) {}
    const ask = { text: "项目 A 周二发布前要做什么？", spaces: ["personal"], userId: "owner", threshold: 0.5 };
    const cosine = (await passiveRecall(app, ask)).map((h) => h.memory.id);
    expect(cosine).toContain(deploy);

    app.config.rerank = { ...app.config.rerank, enabled: true, passiveThreshold: 0.5 };
    setRerankerForTests((_q, passages) => passages.map((p) => (p.includes("回归测试") ? 0.8 : 0.1)));
    const hits = await passiveRecall(app, ask);
    expect(hits.map((h) => h.memory.id)).toEqual([deploy]);
    expect(hits[0].score).toBe(0.8);
    expect(hits.map((h) => h.memory.id)).not.toContain(near);

    setRerankerForTests(() => {
      throw new Error("boom");
    });
    expect((await passiveRecall(app, ask)).map((h) => h.memory.id)).toEqual(cosine);
  });
});
