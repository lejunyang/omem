import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { kindBrief, parserList, pickParser } from "../src/plugins/formats.ts";
import { loadPlugins, manifestSchema, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { search } from "../src/search/search.ts";
import { startServer } from "../src/server/http.ts";
import { importDirectory, importFile, importText } from "../src/sources/import.ts";
import { findSourceByUri, readSource, reindexSource, sourceOutline } from "../src/sources/store.ts";
import { pagesToCheck } from "../src/wiki/upkeep.ts";
import { readPage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
const ctx: ToolContext = { app, actor: "agent", runId: null, spaceId: "personal", spaces: null, tools: null };
const dir = join(app.home, "documents");
const payload = JSON.stringify({ title: "directoryrecord", body: "第一行\n第二行" });
let server: Awaited<ReturnType<typeof startServer>>;
const undo: (() => void)[] = [];
const api = registerProcessHooks(manifestSchema.parse({ id: "fixture", name: "测试", permissions: { sourceParser: true, wikiPageKind: true } }), undo);

beforeAll(async () => {
  mkdirSync(dir);
  cpSync("examples/plugins/formats", join(app.home, "plugins", "formats"), { recursive: true });
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  expect((await trustPlugin(app, "formats")).runMode).toBe("isolated");
  server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
});
afterAll(async () => {
  for (const stop of undo) stop();
  untrustPlugin(app, "formats");
  await server?.close();
  app.db.close();
});

it("uploads by MIME, captures a matching URL, and imports a directory through the isolated parser", async () => {
  const form = new FormData();
  form.append("file", new Blob([payload], { type: "application/x-ndjson" }), "example.data");
  const response = await fetch(app.baseUrl + "/api/sources/upload?space=personal", { method: "POST", body: form });
  const upload = (await response.json()).results[0];
  expect(upload.status).toBe("created");
  const detail = (await server.inject("/api/sources/" + upload.id + "?from=2&to=3")).json();
  expect(detail).toMatchObject({ text: "第一行\n第二行", source: { meta: {
    parser: { id: "formats:jsonl", version: "1" }, display: { kind: "records", items: [{ title: "directoryrecord", lines: [1, 3] }] },
  } } });
  expect((await search(app, "directoryrecord", { spaces: ["personal"], routes: { vector: false } })).some(h => h.sourceId === upload.id)).toBe(true);
  const url = "https://example.org/records.jsonl";
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(payload));
  try {
    expect((await callTool(ctx, "import_url", { url })).isError).toBe(false);
    expect(findSourceByUri(app, "personal", url)?.meta.parser).toEqual(detail.source.meta.parser);
  } finally { mock.mockRestore(); }
  writeFileSync(join(dir, "records.jsonl"), payload);
  const report = await importDirectory(app, "personal", dir);
  expect(report).toMatchObject({ created: 1, skipped: [] });
  expect(readSource(app, report.sourceIds[0]).source.meta.display).toEqual(detail.source.meta.display);
  expect((await server.inject("/api/sources/parsers?space=personal")).json()).toContainEqual(expect.objectContaining({ id: "formats:jsonl", lastError: null }));
});

it("loads trusted parsers for a standalone CLI directory import and exits", async () => {
  const folder = join(app.home, "cli-docs");
  mkdirSync(folder);
  writeFileSync(join(folder, "cli.jsonl"), payload);
  await promisify(execFile)(process.execPath, ["src/cli-main.ts", "--home", app.home, "add", folder, "--no-ingest"], { timeout: 30000 });
  expect(findSourceByUri(app, "personal", "cli-docs/cli.jsonl")?.meta.parser).toEqual({ id: "formats:jsonl", version: "1" });
}, 35000);

it("limits hooks to declared permissions and spaces, and honors parser order", async () => {
  const register = (permissions: Record<string, boolean>) => registerProcessHooks(manifestSchema.parse({
    id: "scoped", name: "空间限定", spaces: [{ id: "demo", name: "示例" }], permissions,
  }), undo);
  const def = { id: "lines", label: "记录", match: { extensions: ["jsonl"] }, async parse() { return { text: "记录" }; } };
  expect(() => register({}).sourceParser(def)).toThrow("permissions.sourceParser");
  expect(() => register({}).wikiPageKind({ kind: "demo", label: "测试", describe: "描述", template: "模板" })).toThrow("permissions.wikiPageKind");
  register({ sourceParser: true }).sourceParser(def);
  expect(parserList("personal").map(p => p.id)).not.toContain("scoped:lines");
  createUser(app, { id: "reader", name: "读者" });
  const headers = { authorization: "Bearer " + createApiToken(app, "reader") };
  const response = await server.inject({ url: "/api/sources/parsers", headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().map((p: { id: string }) => p.id)).not.toContain("scoped:lines");
  expect((await server.inject({ url: "/api/wiki/kinds?space=personal", headers })).statusCode).toBe(403);
  expect(pickParser(parserList("demo"), [], "demo.jsonl", false)?.id).toBe("formats:jsonl");
  expect(pickParser(parserList("demo"), ["scoped:lines"], "demo.jsonl", false)?.id).toBe("scoped:lines");
});

it("only takes over a built-in format explicitly, rejects invalid output before writing, and preserves record boundaries on rebuild", async () => {
  let end = 4;
  const text = ["a".repeat(1600), "b".repeat(1600), "inside", "last"].join("\n");
  api.sourceParser({ id: "table", label: "表格", match: { extensions: [".md"] }, async parse() {
    return { text, display: { kind: "table", columns: ["列"], rowLines: [[2, end], [1, 1]] } };
  } });
  const file = join(app.home, "note.md");
  writeFileSync(file, "# Note");
  const saved = (await importFile(app, "personal", file))!;
  expect(readSource(app, saved.id).text).toBe("# Note");
  app.config.documents.parserOrder = ["fixture:table"];
  expect((await importFile(app, "personal", file))!.status).toBe("updated");
  const sections = sourceOutline(app, saved.id).sections;
  expect(sections.at(-1)?.line_end).toBe(4);
  expect(sections.some(s => s.line_end === 2 || s.line_end === 3)).toBe(false);
  reindexSource(app, saved.id);
  expect(sourceOutline(app, saved.id).sections).toEqual(sections);
  end = 5;
  await expect(importFile(app, "personal", file, "bad.md")).rejects.toThrow("display 行号");
  expect(findSourceByUri(app, "personal", "bad.md")).toBeFalsy();
  await expect(importFile(app, "personal", file)).rejects.toThrow("display 行号");
  expect(readSource(app, saved.id).text).toBe(text);
  expect((await server.inject("/api/sources/parsers?space=personal")).json()).toContainEqual(expect.objectContaining({ id: "fixture:table", lastError: expect.stringContaining("display") }));
});

it("uses the registered template, returns check findings to the writer, and schedules periodic upkeep", async () => {
  const args = { page: "api/example", title: "示例接口", kind: "api-reference", summary: "示例", body: "## 请求\n示例" };
  expect(kindBrief("personal", args.kind)).toContain("## 用途");
  expect((await callTool(ctx, "write_page", args)).text).toContain("缺少小节：返回");
  expect((await callTool(ctx, "write_page", { ...args, body: args.body + "\n## 返回\n结果" })).isError).toBe(false);
  expect(pagesToCheck(app, "personal", Date.now() + 31 * 86400000)).toContain(args.page);
  expect((await server.inject("/api/wiki/kinds?space=personal")).json()).toContainEqual(expect.objectContaining({
    kind: args.kind, hasTemplate: true, upkeep: { everyDays: 30, onSourcesChanged: true },
  }));
});

it("can turn off source-change upkeep for one kind", async () => {
  api.wikiPageKind({ kind: "manual", label: "手册", describe: "人工维护", template: "## 操作", upkeep: { onSourcesChanged: false } });
  const source = importText(app, "personal", { uri: "doc", kind: "doc", text: "旧版" });
  const body = `[原件](src:${source.id}#L1-L1)`;
  for (const kind of ["manual", "guide"]) {
    expect((await callTool(ctx, "write_page", { page: kind, title: kind, kind, summary: "示例", body })).isError).toBe(false);
  }
  importText(app, "personal", { uri: "doc", kind: "doc", text: "新版" });
  const due = pagesToCheck(app, "personal", Date.now() + 86400000);
  expect(due).toContain("guide");
  expect(due).not.toContain("manual");
});

it("saves on check timeout and keeps existing pages and records readable after unloading", async () => {
  api.wikiPageKind({ kind: "slow", label: "慢检查", describe: "测试", template: "## 示例", check: () => new Promise(() => {}) });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadline = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 15000 ? 20 : ms));
  try {
    expect((await callTool(ctx, "write_page", { page: "slow", title: "示例", summary: "测试", kind: "slow", body: "正文" })).isError).toBe(false);
  } finally { deadline.mockRestore(); }
  const file = join(app.home, "reload.jsonl");
  writeFileSync(file, payload);
  const parsed = (await importFile(app, "personal", file))!;
  const page = { page: "api/unloaded", title: "示例", summary: "说明", kind: "api-reference", body: "## 请求\n\n## 返回" };
  expect((await callTool(ctx, "write_page", page)).isError).toBe(false);
  untrustPlugin(app, "formats");
  expect(readSource(app, parsed.id).source.meta.display).toBeTruthy();
  expect(readPage(app, "personal", page.page).meta.kind).toBe("api-reference");
  expect((await callTool(ctx, "write_page", { ...page, body: "更新正文" })).isError).toBe(false);
  expect((await callTool(ctx, "write_page", { page: "api/new", title: "示例", summary: "新建", kind: "api-reference", body: "正文" })).isError).toBe(true);
  await importFile(app, "personal", file);
  expect(readSource(app, parsed.id).text).toBe(payload);
  expect(readSource(app, parsed.id).source.meta.display).toBeUndefined();
});
