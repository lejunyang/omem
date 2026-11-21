import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { upsertSource } from "../src/sources/store.ts";
import { embedPending, resetEmbedder, EMBEDDING_TEST_TEXT } from "../src/search/embeddings.ts";
import { RERANK_TEST_QUERY, RERANK_TEST_DOCUMENTS, setRerankerForTests } from "../src/search/rerank.ts";
import { configSchema } from "../src/core/config.ts";
import { all } from "../src/core/db.ts";

import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { manifestSchema } from "../src/plugins/registry.ts";

const close: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); resetEmbedder(); vi.restoreAllMocks(); });

async function fixture() {
  const app = testApp();
  close.push(() => app.db.close());
  resetEmbedder();
  upsertSource(app, { spaceId: "personal", kind: "note", uri: "private", title: "库内材料", text: "库内材料不应在检测请求里。" });
  const calls: { path: string; body: Record<string, unknown>; auth: string | undefined }[] = [];
  let fail = "", variant = false;
  const service = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ path: req.url!, body, auth: req.headers.authorization });
    if (fail === "status") { res.statusCode = 400; return res.end("拒绝 example-private-key"); }
    if (fail === "json") return res.end("invalid example-private-key");
    if (req.url === "/embeddings") res.end(JSON.stringify({ data: (body.input as string[]).map((_, index) => ({ index, embedding: [3, 4] })) }));
    else res.end(JSON.stringify({ [variant ? "data" : "results"]: [1, 3, 0, 2].map(index => ({ index, [variant ? "score" : "relevance_score"]: index * 0.1 })) }));
  });
  await new Promise<void>(r => service.listen(0, "127.0.0.1", r));
  close.push(() => new Promise<void>(r => { service.close(() => r()); service.closeAllConnections(); }));
  const url = "http://127.0.0.1:" + (service.address() as AddressInfo).port;
  app.config.ai.providers = [{ id: "remote", name: "云端", kind: "openai-compatible", backends: [], baseUrl: url }];
  setKey(app.home, "remote", "example-private-key");
  const server = await startServer(app, { port: 0, quiet: true });
  close.push(() => server.close());
  return { app, server, calls, url, failure(s: string) { fail = s; }, variant() { variant = true; } };
}

it("两种检测使用未保存配置和密钥库，只发固定文本并返回维度、顺序、耗时", async () => {
  const { app, server, calls, variant } = await fixture();
  const cfg = { provider: "api", keyRef: "remote", model: "embed", dimensions: 2 };
  const probe = () => server.inject({ method: "POST", url: "/api/search/embeddings/test", payload: cfg });
  expect((await probe()).json()).toMatchObject({ ok: true, dimensions: 2, elapsedMs: expect.any(Number), error: null });
  expect(app.config.embeddings.provider).toBe("none");
  const rr = () => server.inject({ method: "POST", url: "/api/search/rerank/test", payload: { provider: "api", api: { keyRef: "remote", model: "rank" } } });
  for (let i = 0; i < 2; i++) {
    expect((await rr()).json()).toMatchObject({ ok: true, results: [{ index: 3, score: 0.30000000000000004 }, { index: 2, score: 0.2 }, { index: 1, score: 0.1 }, { index: 0, score: 0 }] });
    variant();
  }
  expect(calls[0].body.input).toEqual([EMBEDDING_TEST_TEXT]);
  expect(calls.slice(1).every(c => c.body.query === RERANK_TEST_QUERY && JSON.stringify(c.body.documents) === JSON.stringify(RERANK_TEST_DOCUMENTS))).toBe(true);
  expect(calls.every(c => c.auth === "Bearer example-private-key")).toBe(true);
  expect(JSON.stringify(calls.map(c => c.body))).not.toContain("库内材料");
  expect(all(app.db, "select id from chunks where embedding is not null")).toHaveLength(0);
});

it("状态显示积压和错误，HTTP 和坏 JSON 摘要、日志、配置都隐藏密钥", async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, "warn");
  f.app.config.embeddings = configSchema.shape.embeddings.parse({ provider: "api", keyRef: "remote", model: "embed" });
  f.failure("status");
  expect(await embedPending(f.app)).toBe(0);
  const queries = vi.spyOn(f.app.db, "prepare");
  const state = (await f.server.inject("/api/search/providers")).json();
  expect(queries.mock.calls.filter(([sql]) => /count\(\*\).*from (chunks|memories) indexed by/i.test(sql))).toHaveLength(2);
  expect(state.embeddings).toMatchObject({ provider: "api", kind: "api", pending: 1, state: "paused" });
  expect(state.embeddings.lastError).toContain("[已隐藏]");
  expect(JSON.stringify(state)).not.toContain("example-private-key");
  for (const mode of ["status", "json"]) {
    f.failure(mode);
    const res = await f.server.inject({ method: "POST", url: "/api/search/embeddings/test", payload: { provider: "api", keyRef: "remote", model: "embed" } });
    expect(res.json().ok).toBe(false);
    expect(res.body).not.toContain("example-private-key");
  }
  expect((await f.server.inject("/api/settings")).body).not.toContain("example-private-key");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("example-private-key");
});

it("本地和插件重排可直接检测，无需填写云端模型", async () => {
  const { app, server } = await fixture();
  expect(app.config.rerank.api).toBeUndefined();
  const local = vi.fn(() => [1, 2, 3, 4]);
  setRerankerForTests(local);
  close.push(() => setRerankerForTests(null));
  const undo: (() => void)[] = [];
  close.push(() => undo.reverse().forEach(stop => stop()));
  const api = registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", permissions: { reranker: true } }), undo);
  const plugin = vi.fn(async () => [4, 3, 2, 1]);
  api.reranker({ id: "rank", label: "示例", score: plugin });
  for (const [provider, first] of [["local", 3], ["plugin:demo:rank", 0]] as const) {
    const result = await server.inject({ method: "POST", url: "/api/search/rerank/test", payload: { provider } });
    expect(result.json()).toMatchObject({ ok: true });
    expect(result.json().results[0].index).toBe(first);
  }
  expect(local).toHaveBeenCalledTimes(1);
  expect(plugin).toHaveBeenCalledTimes(1);
});

it("未传检测配置时使用已保存配置，仍只发固定样例", async () => {
  const { app, server, calls } = await fixture();
  app.config.embeddings = configSchema.shape.embeddings.parse({ provider: "api", keyRef: "remote", model: "embed" });
  app.config.rerank = configSchema.shape.rerank.parse({ provider: "api", api: { keyRef: "remote", model: "rank" } });
  for (const key of ["embeddings", "rerank"]) {
    const response = await server.inject({ method: "POST", url: "/api/search/" + key + "/test" });
    expect(response.json().ok).toBe(true);
  }
  expect(calls[0].body.input).toEqual([EMBEDDING_TEST_TEXT]);
  expect(calls[1].body.documents).toEqual(RERANK_TEST_DOCUMENTS);
});

it("有知识设置编辑权的成员仍改不了向量和重排，也调用不了检测", async () => {
  const f = await fixture();
  createUser(f.app, { id: "editor", name: "编辑", role: "admin" });
  f.app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('editor','settings.knowledge.edit','global','','allow','0','owner')").run();
  const headers = { authorization: "Bearer " + createApiToken(f.app, "editor") };
  for (const key of ["embeddings", "rerank"]) {
    expect((await f.server.inject({ method: "PUT", url: "/api/settings", headers, payload: { [key]: { provider: "api" } } })).statusCode).toBe(403);
    expect((await f.server.inject({ method: "POST", url: "/api/search/" + key + "/test", headers, payload: {} })).statusCode).toBe(403);
  }
  expect(f.calls).toHaveLength(0);
});
