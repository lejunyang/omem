import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { fakeEmbedder, testApp } from "./helpers.ts";
import { search } from "../src/search/search.ts";
import { remember } from "../src/memory/store.ts";
import { passiveRecall } from "../src/memory/passive.ts";
import { rerankStatus } from "../src/search/rerank.ts";
import { embedPending, embedPendingMemories, setEmbedderForTests } from "../src/search/embeddings.ts";

it("云端按两种协议重排、按外部分数过门槛，超时和坏响应保持原顺序", async () => {
  const app = testApp();
  let mode = "results", calls = 0;
  const service = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    expect(req.url).toBe("/rerank");
    expect(body).toMatchObject({ model: "rank", top_n: 2 });
    expect(body.documents.every((s: string) => s.length <= 256)).toBe(true);
    calls++;
    if (mode === "timeout") return;
    const rows = (body.documents as string[]).map((s, index) => ({ index, [mode === "data" ? "score" : "relevance_score"]: s.includes("计划") ? -1 : -5 })).reverse();
    res.end(JSON.stringify({ [mode]: rows }));
  });
  await new Promise<void>(r => service.listen(0, "127.0.0.1", r));
  try {
    const a = remember(app, { kind: "fact", spaceId: "personal", content: "项目资料每周更新。" }).id;
    const b = remember(app, { kind: "fact", spaceId: "personal", content: "项目资料包括计划。" }).id;
    const opts = { types: ["memory" as const] };
    const before = (await search(app, "项目资料", opts)).map(h => h.id);
    Object.assign(app.config.rerank, { enabled: true, provider: "api", maxTokens: 128, pluginPassiveThreshold: -2,
      api: { url: "http://127.0.0.1:" + (service.address() as AddressInfo).port, model: "rank", timeoutMs: 500, apiKeyEnv: "TEST_RANK_KEY" } });
    for (mode of ["results", "data"]) expect((await search(app, "项目资料", opts)).map(h => h.id)).toEqual([b, a]);
    app.config.embeddings.provider = "local";
    setEmbedderForTests(fakeEmbedder());
    await embedPending(app);
    await embedPendingMemories(app);
    expect((await passiveRecall(app, { text: "项目资料", spaces: ["personal"], userId: "owner", threshold: 0 })).map(h => h.memory.id)).toEqual([b]);
    for (mode of ["bad", "timeout"]) {
      expect((await search(app, "项目资料", opts)).map(h => h.id)).toEqual(before);
      expect(rerankStatus(app).lastError).toBeTruthy();
    }
    expect(calls).toBe(5);
  } finally {
    setEmbedderForTests(null);
    service.closeAllConnections();
    await new Promise<void>(r => service.close(() => r()));
    app.db.close();
  }
});
