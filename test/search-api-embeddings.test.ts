import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { configSchema } from "../src/core/config.ts";
import { embedPending, embedQuery, embeddingHealth, resumeEmbedding, testEmbedding } from "../src/search/embeddings.ts";
import { vectorCounts } from "../src/search/embedding-index.ts";
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

it("旧 openai 索引升级沿用向量，地址变更仍要求确认", async () => {
  const { app } = await setup();
  app.config.embeddings.dimensions = undefined;
  app.db.prepare("insert or replace into kv(key,value) values('embedding_model','openai:m')").run();
  const { modelChange } = await import("../src/search/embedding-index.ts");
  expect(modelChange(app, app.config)).toBeNull();
  expect(await embedPending(app)).toBe(2);
  expect(modelChange(app, { ...app.config, embeddings: { ...app.config.embeddings, url: "https://example.org/v1" } })).not.toBeNull();
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
