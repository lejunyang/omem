import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { configSchema } from "../src/core/config.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertSource } from "../src/sources/store.ts";
import { remember } from "../src/memory/store.ts";
import { embedPending, embedPendingMemories, embedQuery, embeddingHealth, resetEmbedder } from "../src/search/embeddings.ts";
import { encodeBatch } from "../src/search/embedding-provider.ts";
import { modelChange, replaceIndex, vectorCounts } from "../src/search/embedding-index.ts";
import { embedders, registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { manifestSchema, loadPlugins, trustPlugin, untrustPlugin, getPlugin, describePlugin } from "../src/plugins/registry.ts";
import { trustState, setTrust } from "../src/plugins/trust.ts";
import { all } from "../src/core/db.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); resetEmbedder(); });

function fixture() {
  const app = testApp();
  cleanup.push(() => app.db.close());
  resetEmbedder();
  createSpace(app, { id: "allowed", name: "项目 A", kind: "project" });
  for (const spaceId of ["personal", "allowed"]) {
    upsertSource(app, { spaceId, kind: "note", uri: spaceId, title: spaceId, text: spaceId + "材料" });
    remember(app, { spaceId, kind: "fact", content: spaceId + "资料每周更新。" });
  }
  app.config.embeddings = configSchema.shape.embeddings.parse({ provider: "plugin:vector:small", timeoutMs: 300, batch: 2 });
  return app;
}

it("进程内向量遵守批量、字符和空间范围；模型改变先暂停通知，确认后重建", async () => {
  const app = fixture();
  const undo: (() => void)[] = [];
  cleanup.push(() => undo.reverse().forEach(f => f()));
  const api = registerProcessHooks(manifestSchema.parse({ id: "vector", name: "向量", spaces: [{ id: "allowed", name: "项目 A" }], permissions: { embedder: true } }), undo);
  const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([3, 4])));
  const def = { id: "small", name: "示例向量", model: "first", dimensions: 2, maxBatch: 1, maxChars: 6, embed };
  api.embedder(def);
  expect(await embedPending(app)).toBe(1);
  expect(await embedPendingMemories(app)).toBe(1);
  expect(embed.mock.calls.flatMap(c => c[0]).every(t => t.length <= 6 && !t.includes("personal"))).toBe(true);
  expect(all(app.db, "select id from chunks where space_id='personal' and embedding is not null")).toHaveLength(0);
  expect(all(app.db, "select id from memories where space_id='personal' and embedding is not null")).toHaveLength(0);
  expect(await embedQuery(app, "外部空间的问题", "query", ["personal"])).toBeNull();
  expect(await embedQuery(app, "问题", "query", ["allowed"])).toEqual(new Float32Array([0.6, 0.8]));
  const count = embed.mock.calls.length;
  def.model = "second";
  expect(await embedPending(app)).toBe(0);
  expect(await embedQuery(app, "问题")).toBeNull();
  expect(embed).toHaveBeenCalledTimes(count);
  expect(embeddingHealth(app).lastError).toContain("已变化");
  expect(all(app.db, "select id from notifications where title='插件向量已暂停'")).toHaveLength(1);
  const change = modelChange(app, app.config)!;
  expect(change).toMatchObject({ clear: 2, rebuild: 2 });
  replaceIndex(app, change.to);
  expect(vectorCounts(app).clear).toBe(0);
  expect(await embedPending(app)).toBe(1);
});

it("插件无权限不能注册，链接插件新增向量权限也要重新确认", () => {
  const app = fixture();
  const undo: (() => void)[] = [];
  cleanup.push(() => undo.reverse().forEach(f => f()));
  expect(() => registerProcessHooks(manifestSchema.parse({ id: "blocked", name: "示例" }), undo)
    .embedder({ id: "small", name: "示例", model: "m", dimensions: 2, async embed() { return []; } })).toThrow("permissions.embedder");
  const dir = join(app.home, "plugins", "linked");
  mkdirSync(dir, { recursive: true });
  setTrust(app, "linked", dir, "isolated", true);
  expect(trustState(app, "linked", dir, true, undefined, true)).toBe("changed");
});

it("统一调用层分批、限流重试、维度变化整次作废", async () => {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [3, 4]));
  const e = { id: "plugin:demo", maxBatch: 2, dimensions: 2, embed };
  embed.mockRejectedValueOnce(Object.assign(new Error("限流"), { status: 429 }));
  expect(await encodeBatch(e, ["a", "b", "c"], "passage", 500)).toHaveLength(3);
  expect(embed.mock.calls.map(c => c[0].length)).toEqual([2, 2, 1]);
  embed.mockImplementationOnce(async () => [[3, 4], [3, 4]]).mockImplementationOnce(async () => [[1]]);
  await expect(encodeBatch(e, ["a", "b", "c"], "passage", 500)).rejects.toThrow("维度");
});

it.each([429, 503])("沙箱向量首次返回 %i 时退避重试并写入，权限声明和使用状态可查", async (status) => {
  const app = fixture();
  const plugin = "vector" + status;
  app.config.embeddings.provider = `plugin:${plugin}:small`;
  const dir = join(app.home, "plugins", plugin);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), `id: ${plugin}\nname: 向量\nspaces: [{ id: allowed, name: 项目 A }]\npermissions: { embedder: true }\n`);
  writeFileSync(join(dir, "server.mjs"), `let attempts = 0; export default api => api.embedder({ id: "small", name: "示例", model: "sandbox", dimensions: 2, maxBatch: 1, async embed(texts, kind, signal) { if (++attempts === 1) throw Object.assign(new Error("稍后重试"), { status: ${status} }); if (!signal || !["query", "passage"].includes(kind)) throw Error("参数"); return texts.map(() => new Float32Array([3, 4])); } });`);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  cleanup.push(() => untrustPlugin(app, plugin));
  expect((await trustPlugin(app, plugin)).runMode).toBe("isolated");
  const embed = vi.spyOn(embedders.get(plugin + ":small")!.def, "embed");
  expect(await embedPending(app)).toBe(1);
  expect(embed).toHaveBeenCalledTimes(2);
  expect(all(app.db, "select id from chunks where space_id='allowed' and embedding is not null")).toHaveLength(1);
  expect(await embedPendingMemories(app)).toBe(1);
  expect(await embedQuery(app, "问题")).toEqual(new Float32Array([0.6, 0.8]));
  expect(describePlugin(getPlugin(plugin)).permissions.embeddingNotice).toContain("外部服务");
});
