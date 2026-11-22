import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { configPath, configSchema, saveConfig } from "../src/core/config.ts";
import { embedPending, embedQuery, embeddingHealth, resumeEmbedding, testEmbedding } from "../src/search/embeddings.ts";
import { storedModel, vectorCounts } from "../src/search/embedding-index.ts";
import { pack } from "../src/search/vector-codec.ts";
import { remember } from "../src/memory/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";

const close: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });

async function setup() {
  const app = testApp();
  close.push(() => app.db.close());
  const calls: { input: string[]; dimensions?: number; auth?: string }[] = [];
  let delayMs = 0, status = 200, failOnce = false, invalid = "", hang = false;
  const service = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    calls.push({ ...body, auth: req.headers.authorization });
    if (hang) return;
    if (delayMs) await delay(delayMs);
    res.statusCode = status;
    if (failOnce) { failOnce = false; status = 200; }
    const vectors = body.input.map((_: string, i: number) => ({ index: i, embedding: invalid === "dim" && !i ? [9] : [3, 4] })).reverse();
    if (invalid === "count") vectors.pop();
    res.end(res.statusCode === 200 ? JSON.stringify({ data: vectors }) : "rejected " + req.headers.authorization);
  });
  await new Promise<void>(r => service.listen(0, "127.0.0.1", r));
  close.push(() => new Promise<void>(r => { service.close(() => r()); service.closeAllConnections(); }));
  app.config.ai.providers = [{ id: "remote", name: "示例", kind: "openai-compatible", backends: [], baseUrl: "http://127.0.0.1:" + (service.address() as AddressInfo).port }];
  setKey(app.home, "remote", "example-secret");
  app.config.embeddings = configSchema.shape.embeddings.parse({ provider: "openai", keyRef: "remote", model: "m", dimensions: 2, batch: 2, timeoutMs: 1200 });
  for (let i = 0; i < 3; i++) upsertSource(app, { spaceId: "personal", kind: "note", uri: String(i), title: "材料", text: "材料" + i });
  return { app, calls, latency(ms: number) { delayMs = ms; }, failure(code: number, once = false) { status = code; failOnce = once; }, invalid(s: string) { invalid = s; }, hang() { hang = true; } };
}

it("按批从密钥库认证，兼容 openai，限流后重试并归一化", async () => {
  const { app, calls, failure } = await setup();
  expect(app.config.embeddings.provider).toBe("api");
  failure(429, true);
  expect(await embedPending(app)).toBe(2);
  expect(await embedPending(app)).toBe(1);
  expect(calls.map(c => c.input.length)).toEqual([2, 2, 1]);
  expect(calls.every(c => c.auth === "Bearer example-secret" && c.dimensions === 2)).toBe(true);
  expect(await embedQuery(app, "问题")).toEqual(new Float32Array([0.6, 0.8]));
});

it("检测、查询和写入可用满时限，稳定慢于三分之一预算的请求一次成功", async () => {
  const s = await setup();
  s.app.config.embeddings.timeoutMs = 900;
  s.latency(450);
  expect(await testEmbedding(s.app, s.app.config.embeddings)).toBe(2);
  expect(await embedQuery(s.app, "问题")).not.toBeNull();
  expect(await embedPending(s.app)).toBe(2);
  expect(s.calls).toHaveLength(3);
});

it.each([
  { code: "TimeoutError", error: new DOMException("example-secret", "TimeoutError") },
  { code: "ETIMEDOUT", error: Object.assign(new Error("example-secret"), { code: "ETIMEDOUT" }) },
  ...["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].map(code => ({
    code, error: new TypeError("fetch failed: example-secret", { cause: Object.assign(new Error("example-secret"), { code }) }),
  })),
])("传输提前报 $code 时用剩余时限重试，耗尽次数后返回脱敏错误", async ({ error }) => {
  const { app, calls } = await setup();
  const send = vi.spyOn(globalThis, "fetch");
  try {
    send.mockRejectedValueOnce(error);
    expect(await embedPending(app)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(vectorCounts(app).clear).toBe(2);

    send.mockClear().mockRejectedValue(error);
    expect(await embedQuery(app, "测试提前超时")).toBeNull();
    expect(send).toHaveBeenCalledTimes(3);
    expect(embeddingHealth(app).lastError).toContain("[已隐藏]");
    expect(embeddingHealth(app).lastError).not.toContain("example-secret");
  } finally {
    send.mockRestore();
  }
});

it.each([
  { status: 400, attempts: 1 },
  { status: 429, attempts: 3 },
  { status: 503, attempts: 3 },
])("收到 HTTP $status 后读取错误正文提前超时，按状态尝试 $attempts 次", async ({ status, attempts }) => {
  const { app, calls, failure } = await setup();
  failure(status);
  const read = vi.spyOn(Response.prototype, "text").mockRejectedValue(new DOMException("example-secret", "TimeoutError"));
  try {
    expect(await embedQuery(app, "问题")).toBeNull();
    expect(calls).toHaveLength(attempts);
    expect(embeddingHealth(app).lastError).toBe(`HTTP ${status}`);
  } finally {
    read.mockRestore();
  }
});

it("错误维度和条数整批作废，暂停后台并保留积压", async () => {
  const s = await setup();
  for (const fault of ["dim", "count"]) {
    resumeEmbedding(s.app);
    s.invalid(fault);
    expect(await embedPending(s.app)).toBe(0);
    expect(vectorCounts(s.app)).toMatchObject({ pending: 3, clear: 0 });
    expect(embeddingHealth(s.app).writeError).toBeTruthy();
    const calls = s.calls.length;
    expect(await embedPending(s.app)).toBe(0);
    expect(s.calls).toHaveLength(calls);
  }
});

it("服务错误重试三次，普通 4xx 只试一次，超时查询退回无向量", async () => {
  const s = await setup();
  s.failure(503);
  expect(await embedQuery(s.app, "问题")).toBeNull();
  expect(s.calls).toHaveLength(3);
  s.failure(400);
  expect(await embedQuery(s.app, "问题")).toBeNull();
  expect(s.calls).toHaveLength(4);
  expect(embeddingHealth(s.app).lastError).toContain("400");
  expect(JSON.stringify(embeddingHealth(s.app))).not.toContain("example-secret");
  s.app.config.embeddings.timeoutMs = 180;
  s.hang();
  expect(await embedQuery(s.app, "问题")).toBeNull();
  expect(s.calls).toHaveLength(5);
});

it("预览模型、维度和服务地址变更，只有确认后清空索引", async () => {
  const { app } = await setup();
  const server = await startServer(app, { port: 0, quiet: true });
  close.push(() => server.close());
  for (const patch of [{ model: "new" }, { dimensions: 3 }, { url: "https://example.org/v1" }, { provider: "local" }]) {
    app.config.embeddings.dimensions = 2;
    const save = (token = "") => server.inject({ method: "PUT", url: "/api/settings?confirmEmbedding=" + token, payload: { embeddings: patch } });
    expect(await embedPending(app)).toBe(2);
    const preview = await save();
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toMatchObject({ clear: 2, rebuild: 3 });
    expect(vectorCounts(app).clear).toBe(2);
    expect((await save(preview.json().token)).statusCode).toBe(200);
    expect(vectorCounts(app).clear).toBe(0);
    // Restore the fake service before independently testing the next change.
    Object.assign(app.config.embeddings, { dimensions: 2, url: undefined });
    app.db.prepare("delete from kv where key='embedding_model'").run();
  }
});

it("保存和再次确认都按磁盘合并后的地址校验权限与重建目标", async () => {
  const { app } = await setup();
  app.config.ai = configSchema.shape.ai.parse(app.config.ai);
  saveConfig(app.config, app.home);
  expect(await embedPending(app)).toBe(2);
  const original = storedModel(app);
  const path = configPath(app.home);
  const server = await startServer(app, { port: 0, quiet: true });
  close.push(() => server.close());
  const save = (token = "", headers = {}) => server.inject({ method: "PUT", url: "/api/settings?confirmEmbedding=" + token,
    headers, payload: { search: { retrievers: [{ provider: "example:notes" }] } } });
  const base = app.config.ai.providers[0].baseUrl;
  function setAddress(suffix: string) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.ai.providers[0].baseUrl = base + suffix;
    writeFileSync(path, JSON.stringify(config));
  }

  setAddress("/first");
  createUser(app, { id: "editor", name: "编辑", role: "admin" });
  app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('editor','settings.knowledge.edit','global','','allow','0','owner')").run();
  const member = await save("", { authorization: "Bearer " + createApiToken(app, "editor") });
  expect(member.statusCode).toBe(403);
  expect(member.body).toContain("ai.providers");
  const first = await save();
  expect(first.statusCode).toBe(409);
  expect(first.json()).toMatchObject({ confirmation: "embedding-model", clear: 2, to: "api:" + JSON.stringify([base + "/first", "m", 2]) });
  setAddress("/second");
  const second = await save(first.json().token);
  expect(second.statusCode).toBe(409);
  expect(second.json().to).toBe("api:" + JSON.stringify([base + "/second", "m", 2]));
  expect(second.json().token).not.toBe(first.json().token);
  expect(storedModel(app)).toBe(original);
  expect(vectorCounts(app).clear).toBe(2);
  expect(app.config.ai.providers[0].baseUrl).toBe(base);
  expect(JSON.parse(readFileSync(path, "utf8")).search.retrievers).toEqual([]);

  expect((await save(second.json().token)).statusCode).toBe(200);
  expect(app.config.ai.providers[0].baseUrl).toBe(base + "/second");
  expect(storedModel(app)).toBe(second.json().to);
  expect(vectorCounts(app).clear).toBe(0);
  expect(await embedPending(app)).toBe(2);
});

it("磁盘停用向量后保存旧网页设置，确认停用时保留索引", async () => {
  const { app } = await setup();
  saveConfig(app.config, app.home);
  expect(await embedPending(app)).toBe(2);
  const path = configPath(app.home);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.embeddings.provider = "none";
  writeFileSync(path, JSON.stringify(config));
  const server = await startServer(app, { port: 0, quiet: true });
  close.push(() => server.close());
  const save = (token = "") => server.inject({ method: "PUT", url: "/api/settings?confirmEmbedding=" + token,
    payload: { embeddings: { batch: 4 } } });
  const preview = await save();
  expect(preview.statusCode).toBe(409);
  expect(preview.json()).toMatchObject({ to: "none", clear: 0, rebuild: 0 });
  expect(app.config.embeddings.provider).toBe("api");
  expect((await save(preview.json().token)).statusCode).toBe(200);
  expect(app.config.embeddings.provider).toBe("none");
  expect(vectorCounts(app).clear).toBe(2);
});

it("确认重建后写配置失败，保留原模型和可用向量", async () => {
  const { app } = await setup();
  saveConfig(app.config, app.home);
  expect(await embedPending(app)).toBe(2);
  const original = storedModel(app);
  const server = await startServer(app, { port: 0, quiet: true });
  close.push(() => server.close());
  const save = (token = "") => server.inject({ method: "PUT", url: "/api/settings?confirmEmbedding=" + token,
    payload: { embeddings: { model: "replacement" } } });
  const preview = await save();
  expect(preview.statusCode).toBe(409);
  const path = configPath(app.home);
  renameSync(path, path + ".bak");
  mkdirSync(path);
  expect((await save(preview.json().token)).statusCode).toBe(500);
  expect(app.config.embeddings.model).toBe("m");
  expect(storedModel(app)).toBe(original);
  expect(vectorCounts(app).clear).toBe(2);
  expect(await embedQuery(app, "核对材料")).not.toBeNull();
});

it("旧 openai 索引升级沿用向量，地址变更仍要求确认", async () => {
  const { app } = await setup();
  app.config.embeddings.dimensions = undefined;
  app.db.prepare("insert or replace into kv(key,value) values('embedding_model','openai:m')").run();
  const old = pack(new Float32Array([0.6, 0.8]));
  const first = app.db.prepare("select min(id) as id from chunks").get()!.id;
  app.db.prepare("update chunks set embedding=? where id=?").run(old, first);
  const { modelChange } = await import("../src/search/embedding-index.ts");
  expect(modelChange(app, app.config)).toBeNull();
  expect(await embedPending(app)).toBe(2);
  expect(app.db.prepare("select embedding from chunks where id=?").get(first)!.embedding).toEqual(old);
  expect(modelChange(app, { ...app.config, embeddings: { ...app.config.embeddings, url: "https://example.org/v1" } })).not.toBeNull();
});

it.each(["packed", "float", "memory"])("旧 %s 向量保留实际维度，同名服务改变长度后确认才重建", async format => {
  const { app } = await setup();
  delete app.config.embeddings.dimensions;
  app.db.prepare("insert into kv(key,value) values('embedding_model','openai:m')").run();
  const old = new Float32Array([1, 0, 0]);
  if (format === "memory") {
    const memory = remember(app, { kind: "fact", spaceId: "personal", content: "这条记忆已经有旧向量。" });
    app.db.prepare("update memories set embedding=? where id=?").run(new Uint8Array(old.buffer), memory.id);
  } else {
    app.db.prepare("update chunks set embedding=? where id=(select min(id) from chunks)").run(format === "packed" ? pack(old) : new Uint8Array(old.buffer));
  }
  const before = vectorCounts(app);
  expect(await embedPending(app)).toBe(0);
  expect(await embedQuery(app, "检测索引维度")).toBeNull();
  expect(vectorCounts(app)).toEqual(before);
  expect(embeddingHealth(app).writeError).toContain("索引为 3 维，服务返回 2 维");
  const server = await startServer(app, { port: 0, quiet: true });
  close.push(() => server.close());
  const save = (token = "") => server.inject({ method: "PUT", url: "/api/settings?confirmEmbedding=" + token, payload: { embeddings: {} } });
  const preview = await save();
  expect(preview.statusCode).toBe(409);
  expect(preview.json()).toMatchObject(before);
  expect(vectorCounts(app).clear).toBe(1);
  expect((await save(preview.json().token)).statusCode).toBe(200);
  expect(vectorCounts(app).clear).toBe(0);
  expect(await embedPending(app)).toBe(2);
});

it("旧环境变量密钥和显式地址仍用于 OpenAI 形状接口", async () => {
  const { app, calls } = await setup();
  app.config.embeddings.keyRef = undefined;
  app.config.embeddings.url = app.config.ai.providers[0].baseUrl;
  app.config.embeddings.apiKeyEnv = "LEGACY_EMBEDDING_TEST_KEY";
  vi.stubEnv("LEGACY_EMBEDDING_TEST_KEY", "environment-key");
  expect(await embedQuery(app, "问题")).not.toBeNull();
  expect(calls[0].auth).toBe("Bearer environment-key");
});
