import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import { configSchema } from "../src/core/config.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { memoriesFor } from "../src/channels/lark-watch.ts";
import { findThread, setChatSettings, threadMessages } from "../src/agents/threads.ts";
import { watchedNote } from "../src/agents/sessions.ts";
import { saveContext } from "../src/channels/listen.ts";
import { runActions } from "../src/rules/actions.ts";
import { saveRule } from "../src/rules/store.ts";
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

it("停用插件可调整批量和超时，未注册的提供者不能选用，恢复后沿用旧索引", async () => {
  const app = fixture();
  const manifest = manifestSchema.parse({ id: "vector", name: "向量", permissions: { embedder: true } });
  const undo: (() => void)[] = [];
  const unload = () => undo.splice(0).reverse().forEach(stop => stop());
  cleanup.push(unload);
  const def = { id: "small", name: "示例", model: "first", dimensions: 2, async embed(texts: string[]) { return texts.map(() => [1, 0]); } };
  registerProcessHooks(manifest, undo).embedder(def);
  expect(await embedPending(app)).toBe(2);
  unload();
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const state = async () => (await server.inject("/api/search/providers")).json().embeddings;
    const save = (embeddings: object) => server.inject({ method: "PUT", url: "/api/settings", payload: { embeddings } });
    expect(await state()).toMatchObject({ state: "unavailable", model: null });
    expect((await save({ batch: 1, timeoutMs: 600 })).statusCode).toBe(200);
    expect(app.config.embeddings).toMatchObject({ provider: "plugin:vector:small", batch: 1, timeoutMs: 600 });
    const missing = await save({ provider: "plugin:vector:other" });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain("不可用");
    expect(vectorCounts(app).clear).toBe(2);
    registerProcessHooks(manifest, undo).embedder(def);
    expect(await embedPendingMemories(app)).toBe(1);
    expect(await state()).toMatchObject({ model: "first", lastError: null });
    expect(modelChange(app, app.config)).toBeNull();
    expect(all(app.db, "select id from notifications where title='插件向量已暂停'")).toHaveLength(0);
    registerProcessHooks(manifest, undo).embedder({ ...def, id: "other", model: "second" });
    const preview = await save({ provider: "plugin:vector:other" });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().clear).toBe(3);
  } finally {
    await server.close();
  }
});

it("关注可查个人记忆时仍按群消息来源授权，混合批次不外发", async () => {
  const app = fixture();
  const undo: (() => void)[] = [];
  cleanup.push(() => undo.reverse().forEach(stop => stop()));
  const api = registerProcessHooks(manifestSchema.parse({ id: "vector", name: "向量", spaces: [{ id: "personal", name: "个人" }], permissions: { embedder: true } }), undo);
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
  api.embedder({ id: "small", name: "示例", model: "first", dimensions: 2, embed });
  await embedPendingMemories(app);
  embed.mockClear();
  setChatSettings(app, "lark", "project-group", { spaceId: "allowed" });
  const watched = (text: string, spaceId: string | null, chats: string[]) =>
    memoriesFor(app, text, { spaceId }, chats.map(chatId => ({ meta: { chatId } })));
  expect(await watched("项目群的原始消息", "allowed", ["project-group"])).toBe("");
  expect(await watched("两个群的合并消息", null, ["personal-group", "project-group"])).toBe("");
  expect(embed).not.toHaveBeenCalled();
  expect(await watched("个人空间的一条消息", null, ["personal-group"])).toContain("personal资料");
  expect(embed).toHaveBeenCalledTimes(1);
});

it("规则转入未加入关注的项目群消息时，跟进处理不向个人空间插件发送正文", async () => {
  const app = fixture();
  const undo: (() => void)[] = [];
  cleanup.push(() => undo.reverse().forEach(stop => stop()));
  const api = registerProcessHooks(manifestSchema.parse({ id: "vector", name: "向量", spaces: [{ id: "personal", name: "个人" }], permissions: { embedder: true } }), undo);
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
  api.embedder({ id: "small", name: "示例", model: "first", dimensions: 2, embed });
  setChatSettings(app, "lark", "project-group", { spaceId: "allowed" });
  const watch = saveContext(app, { kind: "place", name: "个人关注", spaceId: "personal", chats: ["personal-group"] });
  const rule = saveRule(app, { name: "项目提醒", description: "项目消息交给个人关注", judge: "code",
    conditions: { all: [{ field: "chat.id", op: "equals", value: "project-group" }] },
    actions: [{ type: "context", context: watch.id }] });
  const [result] = await runActions(app, rule, {
    key: "lark:project-message", kind: "message", at: new Date().toISOString(), via: "capture",
    chat: { id: "project-group", name: "项目群", kind: "group" },
    message: { id: "project-message", text: "项目群的跟进材料", type: "text", mentionsOwner: false, mentionsBot: false },
  }, "");
  expect(result.ok).toBe(true);
  const thread = findThread(app, watch.conversationId!)!;
  const [message] = threadMessages(app, thread.id);
  expect(message.meta.sourceChatId).toBe("project-group");
  expect(message.meta).not.toHaveProperty("chatId");
  expect(await watchedNote(app, thread, [message])).toContain("项目群的跟进材料");
  expect(embed).not.toHaveBeenCalled();

  // A mixed batch containing an older forwarded message with no recorded origin.
  const personal = { ...message, meta: { chatId: "personal-group", speaker: "读者" } };
  const legacy = { ...message, meta: { rule: rule.id, speaker: "规则" } };
  await watchedNote(app, thread, [personal, legacy]);
  expect(embed).not.toHaveBeenCalled();
  await watchedNote(app, thread, [personal]);
  expect(embed).toHaveBeenCalledTimes(1);
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
