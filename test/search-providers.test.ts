import { afterEach, expect, it, vi } from "vitest";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { manifestSchema } from "../src/plugins/registry.ts";
import { searchProviderStatus } from "../src/search/providers.ts";
import { startServer } from "../src/server/http.ts";
import { search } from "../src/search/search.ts";
import { readProcess } from "../src/search/read-process.ts";
import { callTool } from "../src/agents/tools.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { createSpace, updateSpace } from "../src/core/spaces.ts";
import { setVisibility } from "../src/auth/visibility.ts";
import { fedSearch, serviceAccount, setShares } from "../src/core/federation.ts";
import { remember } from "../src/memory/store.ts";
import { passiveRecall } from "../src/memory/passive.ts";
import { embedPending, embedPendingMemories, setEmbedderForTests } from "../src/search/embeddings.ts";
import { rerankStatus, setRerankerForTests } from "../src/search/rerank.ts";
import { upsertSource } from "../src/sources/store.ts";
import { writePage } from "../src/wiki/store.ts";
import type { Retriever, RetrievalRef } from "../src/plugins/types.ts";
import { testApp, fakeEmbedder } from "./helpers.ts";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const stop of undo.splice(0).reverse()) stop();
  vi.restoreAllMocks();
  setRerankerForTests(null);
  setEmbedderForTests(null);
});
function setup(spaces: string[] = []) {
  const app = testApp();
  undo.push(() => app.db.close());
  const api = registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", permissions: { retriever: true, reranker: true },
    spaces: spaces.map(id => ({ id, name: id })) }), undo);
  return { app, api };
}
const route = { provider: "demo:lookup", limit: 20, timeoutMs: 400 };
it("按调用人和空间回读 id，融合重复命中，忽略受限、越界和不存在的记录", async () => {
  const { app, api } = setup(["team"]);
  createSpace(app, { id: "team", name: "项目" });
  createUser(app, { id: "reader", name: "读者" });
  addMember(app, "team", "reader");
  const doc = (spaceId: string, text: string) => upsertSource(app, { spaceId, uri: text, title: text, text, kind: "doc" }).id;
  const good = doc("team", "测试采购");
  const hidden = doc("team", "受限材料");
  const other = doc("personal", "私有资料");
  setVisibility(app, hidden, "restricted");
  const chunk = String(app.db.prepare("select id from chunks where source_id=?").get(good)!.id);
  writePage(app, "team", "intro", { meta: { title: "概览" }, body: "从这里开始" });
  const page = String(app.db.prepare("select id from pages where slug='intro'").get()!.id);
  const refs: RetrievalRef[] = [good, hidden, other, "missing"].map(id => ({ type: "source", id }));
  refs.push({ type: "chunk", id: chunk }, { type: "page", id: page });
  const opts = { userId: "reader", spaces: ["team"] };
  const before = await search(app, "采购", opts);
  const lookup = vi.fn<Retriever["search"]>(async () => refs);
  api.retriever({ id: "lookup", label: "示例", search: lookup });
  expect(await search(app, "采购", opts)).toEqual(before);
  expect(lookup).not.toHaveBeenCalled();
  app.config.search.retrievers = [{ ...route, spaces: ["team", "personal"] }];
  const hits = await search(app, "采购", opts);
  expect(hits.map(h => h.id)).toEqual([chunk, page]);
  expect(hits[0].via).toEqual(["全文", "plugin:demo:lookup"]);
  expect(hits[1].snippet).toContain("从这里开始");
  expect(lookup.mock.calls[0][0].userId).toBe("reader");
  expect(lookup.mock.calls[0][1].spaces).toEqual(["team"]);
  await search(app, "采购", { spaces: ["personal"] });
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(searchProviderStatus(app).retrievers[0]).toMatchObject({ id: route.provider, spaces: ["team"], lastMs: expect.any(Number), lastError: null });
});
it("共享设备按共享空间和种类召回，只把可外发的候选交给重排", async () => {
  const { app, api } = setup(["team"]);
  createSpace(app, { id: "team", name: "共享项目" });
  const userId = serviceAccount(app, "另一个设备");
  setShares(app, userId, [{ space: "team", kinds: ["doc"] }]);
  const source = (uri: string, kind: "doc" | "chat" = "doc", spaceId = "team") =>
    upsertSource(app, { uri, kind, spaceId, title: uri, text: uri }).id;
  const first = source("第一份材料"), second = source("第二份材料");
  const restricted = source("留在本机的材料");
  setVisibility(app, restricted, "restricted", [userId]);
  const refs = [first, second, restricted, source("会话材料", "chat"), source("个人材料", "doc", "personal")];
  const lookup = vi.fn<Retriever["search"]>(async () => refs.map(id => ({ type: "source", id })));
  api.retriever({ id: "lookup", label: "召回", search: lookup });
  const score = vi.fn<import("../src/plugins/types.ts").Reranker["score"]>(async (_ctx, req) =>
    req.candidates.map(c => Number(c.text.includes("第二份"))));
  api.reranker({ id: "rank", label: "排序", score });
  app.config.search.retrievers = [route];
  Object.assign(app.config.rerank, { enabled: true, provider: "plugin:demo:rank" });

  expect((await fedSearch(app, userId, { query: "external" })).map(h => h.id)).toEqual([second, first]);
  expect(lookup.mock.calls[0][1]).toMatchObject({ spaces: ["team"], kinds: ["chunk"] });
  expect(score.mock.calls[0][0].userId).toBe(userId);
  expect(score.mock.calls[0][1].candidates).toHaveLength(2);
  // This query reaches both shared documents and local-only results through full text alone.
  app.config.search.retrievers = [];
  expect((await fedSearch(app, userId, { query: "材料" })).map(h => h.id)).toEqual([second, first]);
  expect(score).toHaveBeenCalledTimes(2);
  const texts = score.mock.calls[1][1].candidates.map(c => c.text);
  expect(texts.sort()).toEqual([expect.stringContaining("第一份材料"), expect.stringContaining("第二份材料")]);
  setShares(app, userId, [{ space: "team", kinds: ["wiki"] }]);
  app.config.search.retrievers = [{ ...route, kinds: ["chunk"] }];
  expect(await fedSearch(app, userId, { query: "external" })).toEqual([]);
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("遵守返回上限和工作区覆盖范围，停用后恢复默认路线", async () => {
  const { app } = setup();
  createSpace(app, { id: "project", name: "项目" });
  createSpace(app, { id: "branch", name: "分支", kind: "worktree" });
  updateSpace(app, "branch", { settings: { repo: "project" } });
  const source = (spaceId: string) => upsertSource(app, { spaceId, uri: "a.md", title: "说明", text: spaceId + " 文本", kind: "doc" }).id;
  const main = source("project"), branch = source("branch");
  const unregister: (() => void)[] = [];
  registerProcessHooks(manifestSchema.parse({ id: "sample", name: "示例", permissions: { retriever: true } }), unregister)
    .retriever({ id: "lookup", label: "召回", async search() { return [main, branch].map(id => ({ type: "source", id })); } });
  undo.push(...unregister);
  app.config.search.retrievers = [{ ...route, provider: "sample:lookup", limit: 1 }];
  expect((await search(app, "unrelated")).map(h => h.sourceId)).toEqual([main]);
  const opts = { spaces: ["project"], overlays: ["branch"] };
  expect(await search(app, "unrelated", opts)).toEqual([]);
  app.config.search.retrievers[0].limit = 2;
  expect((await search(app, "unrelated", opts)).map(h => h.sourceId)).toEqual([branch]);
  for (const stop of unregister) stop();
  expect(await search(app, "unrelated", opts)).toEqual([]);
});
it("显式 recall 调用 memory 路线并保留目录和档案裁剪", async () => {
  const { app, api } = setup();
  const mem = (folder: string, agent?: string) => remember(app, { kind: "fact", content: "材料放在文件夹" + folder, spaceId: "personal", folder, agent }).id;
  const keep = mem("资料"), other = mem("进度"), privateId = mem("资料", "other");
  const lookup = vi.fn<Retriever["search"]>(async () => [other, privateId, keep].map(id => ({ type: "memory", id })));
  api.retriever({ id: "lookup", label: "记忆", search: lookup });
  app.config.search.retrievers = [route];
  const result = await callTool({ app, spaceId: "personal", spaces: ["personal"], runId: null, actor: "agent", tools: new Set(["recall"]) },
    "recall", { query: "unrelated", folder: "资料", agent: "example" });
  expect(result.text).toContain(keep);
  expect(result.text).not.toContain(other);
  expect(result.text).not.toContain(privateId);
  expect(lookup.mock.calls[0][1].kinds).toEqual(["memory"]);
});
it("全文读进程和召回同时工作，超时、异常和无效结果保留原顺序，连续失败只提醒一次", async () => {
  const { app, api } = setup();
  upsertSource(app, { spaceId: "personal", uri: "a", title: "费用", text: "费用报销", kind: "doc" });
  const before = await search(app, "费用");
  const reader = vi.spyOn(readProcess(app), "request");
  let signal: AbortSignal | undefined;
  let beganBeforeSql = false;
  const lookup = vi.fn<Retriever["search"]>(async ctx => {
    beganBeforeSql = reader.mock.calls.length === 0;
    signal = ctx.signal;
    await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
    return [];
  });
  api.retriever({ id: "lookup", label: "召回", search: lookup });
  app.config.search.retrievers = [{ ...route, timeoutMs: 50 }];
  const pending = search(app, "费用");
  expect(reader).toHaveBeenCalled();
  expect(signal?.aborted).toBe(false);
  expect(await pending).toEqual(before);
  expect(beganBeforeSql).toBe(true);
  expect(signal?.aborted).toBe(true);
  lookup.mockRejectedValueOnce(new Error("不可用"));
  expect(await search(app, "费用")).toEqual(before);
  lookup.mockResolvedValueOnce([{ type: "memory", id: "" }]);
  expect(await search(app, "费用")).toEqual(before);
  expect(searchProviderStatus(app).retrievers[0].lastError).toBeTruthy();
  expect(app.db.prepare("select count(*) n from notifications where title like '检索提供者调用失败%'").get()?.n).toBe(1);
});
it("搜索和被动记忆使用选中的重排，数量、非有限分数或超时回退本地", async () => {
  const { app, api } = setup();
  app.config.embeddings.provider = "local";
  setEmbedderForTests(fakeEmbedder());
  const a = remember(app, { kind: "fact", spaceId: "personal", content: "项目资料每周更新。" }).id;
  const b = remember(app, { kind: "fact", spaceId: "personal", content: "项目资料包括计划。" }).id;
  await embedPending(app);
  while (await embedPendingMemories(app)) {}
  const score = vi.fn<import("../src/plugins/types.ts").Reranker["score"]>(async (_ctx, req) => req.candidates.map(c => Number(c.id === b)));
  api.reranker({ id: "rank", label: "示例排序", score });
  Object.assign(app.config.rerank, { enabled: true, provider: "plugin:demo:rank", timeoutMs: 50 });
  const opts = { types: ["memory" as const] };
  expect((await search(app, "项目资料", opts)).map(h => h.id)).toEqual([b, a]);
  expect(rerankStatus(app).provider).toBe("plugin:demo:rank");
  expect((await passiveRecall(app, { text: "项目资料", spaces: ["personal"], userId: "owner", threshold: 0 })).map(h => h.memory.id)).toEqual([b]);
  setRerankerForTests((_q, passages) => passages.map(p => Number(p.includes("每周"))));
  score.mockResolvedValueOnce([1]).mockResolvedValueOnce([NaN, 1]).mockImplementationOnce(() => new Promise(() => {}));
  for (let i = 0; i < 3; i++) expect((await search(app, "项目资料", opts)).map(h => h.id)).toEqual([a, b]);
  expect(score.mock.calls.at(-1)![0].signal.aborted).toBe(true);
});

it("本地回退保持三位小数的同分顺序，插件成功时使用原分", async () => {
  const { app, api } = setup();
  for (const content of ["项目资料每周更新。", "项目资料包括计划。"])
    remember(app, { kind: "fact", spaceId: "personal", content });
  const opts = { types: ["memory" as const] };
  const score = vi.fn(async () => [0.8001, 0.8004]);
  api.reranker({ id: "rank", label: "排序", score });
  app.config.rerank.enabled = true;
  setRerankerForTests(() => [0.8001, 0.8004]);
  const local = await search(app, "项目资料", opts);
  expect(local.map(h => h.rerank)).toEqual([0.8, 0.8]);
  app.config.rerank.provider = "plugin:demo:rank";
  const server = await startServer(app, { port: 0, quiet: true });
  const settingsStatus = async () => (await server.inject({ url: "/api/settings" })).json().rerank;
  try {
    const plugin = await search(app, "项目资料", opts);
    expect(plugin.map(h => h.id)).toEqual([local[1].id, local[0].id]);
    expect(plugin.map(h => h.rerank)).toEqual([0.8004, 0.8001]);
    expect(await settingsStatus()).toMatchObject({ provider: "plugin:demo:rank", lastProvider: "plugin:demo:rank" });
    score.mockResolvedValueOnce([]);
    expect(await search(app, "项目资料", opts)).toEqual(local);
    expect(await settingsStatus()).toMatchObject({ provider: "plugin:demo:rank", lastProvider: "local" });
  } finally {
    await server.close();
  }
});

it("被动记忆按实际评分来源使用门槛，插件可使用负数、大于一和零", async () => {
  const { app, api } = setup();
  app.config.embeddings.provider = "local";
  setEmbedderForTests(fakeEmbedder());
  const a = remember(app, { kind: "fact", spaceId: "personal", content: "项目资料每周更新。" }).id;
  remember(app, { kind: "fact", spaceId: "personal", content: "项目资料包括计划。" });
  await embedPending(app);
  while (await embedPendingMemories(app)) {}
  let relevant = 0.8, unrelated = 0.74;
  const score = vi.fn<import("../src/plugins/types.ts").Reranker["score"]>(async (_ctx, req) =>
    req.candidates.map(c => c.id === a ? relevant : unrelated));
  api.reranker({ id: "rank", label: "排序", score });
  Object.assign(app.config.rerank, { enabled: true, provider: "plugin:demo:rank", passiveThreshold: 0.75 });
  const ask = { text: "项目资料", spaces: ["personal"], userId: "owner", threshold: 0 };
  const ids = async () => (await passiveRecall(app, ask)).map(h => h.memory.id);
  expect(await ids()).toEqual([a]);
  for (const [gate, high, low] of [[-2, -1, -5], [4, 5, 3], [0, 0, -0.1]]) {
    app.config.rerank.pluginPassiveThreshold = gate;
    relevant = high;
    unrelated = low;
    expect(await ids()).toEqual([a]);
  }
  score.mockResolvedValueOnce([]);
  setRerankerForTests((_q, passages) => passages.map(p => p.includes("每周") ? 0.75 : 0.7499));
  expect(await ids()).toEqual([a]);
  expect(rerankStatus(app).lastProvider).toBe("local");
});
