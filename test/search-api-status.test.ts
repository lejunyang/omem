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
import { configSchema, loadConfig, saveConfig } from "../src/core/config.ts";
import { remember } from "../src/memory/store.ts";
import { createSpace } from "../src/core/spaces.ts";
import { all, run } from "../src/core/db.ts";

import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { manifestSchema } from "../src/plugins/registry.ts";

const close: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); resetEmbedder(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
  expect(queries.mock.calls.filter(([sql]) => /count\(\*\).*from (chunks|memories) indexed by/i.test(sql))).toHaveLength(4);
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

it("向量状态统计已有分块和有效记忆，停用仍显示，计数走部分索引",async () => {
  const {app,server}=await fixture();
  const memory=remember(app,{spaceId:"personal",kind:"fact",content:"项目 A 的验收规则",createdBy:"user"});
  createSpace(app,{id:"wt-demo",name:"工作区"});
  upsertSource(app,{spaceId:"wt-demo",kind:"note",uri:"worktree",title:"工作区",text:"工作区材料"});
  const vector=Buffer.from(new Float32Array([1,2]).buffer);
  run(app.db,"update chunks set embedding=?",vector);run(app.db,"update memories set embedding=? where id=?",vector,memory.id);
  const plans: string[]=[];
  const prepare=app.db.prepare.bind(app.db);
  vi.spyOn(app.db,"prepare").mockImplementation(sql => {
    if(/count\(\*\).*from (chunks|memories)/i.test(sql)) plans.push(...prepare("explain query plan " + sql).all().map(r=>String(r.detail)));
    return prepare(sql);
  });
  const state=(await server.inject("/api/search/providers")).json().embeddings;
  expect(state).toMatchObject({state:"off",embedded:{chunks:1,memories:1,total:2},pending:0});
  expect(plans.filter(p=>/^SCAN (chunks|memories)\b/.test(p) && !p.includes("INDEX"))).toEqual([]);
  for(const index of ["chunks_vector_space","memories_embedded"]) expect(plans.some(p=>p.includes(index))).toBe(true);
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

it("检测与保存可清除服务商、地址和维度，保存前预览重建", async () => {
  const { app, server, calls, url } = await fixture();
  app.config.embeddings = configSchema.shape.embeddings.parse({ provider: "api", model: "embed", keyRef: "remote", url: "https://example.org/old", dimensions: 2 });
  saveConfig(app.config, app.home);
  const clear = { url: null, dimensions: null };
  const probe = (payload: object) => server.inject({ method: "POST", url: "/api/search/embeddings/test", payload });
  const save = (embeddings: object, token = "") => server.inject({ method: "PUT", url: "/api/settings?confirmEmbedding=" + token, payload: { embeddings } });
  expect((await probe(clear)).json().ok).toBe(true);
  expect(calls.at(-1)).toMatchObject({ path: "/embeddings", auth: "Bearer example-private-key" });
  expect(calls.at(-1)!.body).not.toHaveProperty("dimensions");
  const preview = await save(clear);
  expect(preview.statusCode).toBe(409);
  expect(app.config.embeddings.dimensions).toBe(2);
  expect((await save(clear, preview.json().token)).statusCode).toBe(200);
  expect(loadConfig(app.home).embeddings.url).toBeUndefined();
  expect(app.config.embeddings.dimensions).toBeUndefined();

  vi.stubEnv("TEST_VECTOR_ENV_KEY", "example-env-key");
  const realFetch = globalThis.fetch;
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation((address, init) => {
    expect(address).toBe("https://api.openai.com/v1/embeddings");
    return realFetch(url + "/embeddings", init);
  });
  const useEnv = { keyRef: null, apiKeyEnv: "TEST_VECTOR_ENV_KEY" };
  expect((await probe(useEnv)).json().ok).toBe(true);
  expect(app.config.embeddings.keyRef).toBe("remote");
  const defaults = await save(useEnv);
  expect(defaults.statusCode).toBe(409);
  expect((await save(useEnv, defaults.json().token)).statusCode).toBe(200);
  expect(loadConfig(app.home).embeddings.keyRef).toBeUndefined();
  expect((await probe({})).json().ok).toBe(true);
  expect(outbound).toHaveBeenCalledTimes(2);
  expect(calls.slice(-2).map(c => c.auth)).toEqual(["Bearer example-env-key", "Bearer example-env-key"]);
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
