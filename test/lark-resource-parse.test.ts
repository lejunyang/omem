import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testApp } from "./helpers.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { historyPage, historyScan } from "../src/channels/lark-history.ts";
import { keepResources, missingResources, persistChatMessages, storeMessages, type LarkMessage } from "../src/channels/lark-messages.ts";
import { parseLarkResource } from "../src/channels/lark-resource-parse.ts";
import { resourceKeys } from "../src/channels/lark-resource-keys.ts";
import { createRun, getRun, type RunContext } from "../src/agents/runs.ts";
import { doclingScript, convertDocument } from "../src/sources/import.ts";
import { setToolResolverForTests } from "../src/core/tools.ts";
import { updateSpace } from "../src/core/spaces.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { setLarkCliForTests(null); setToolResolverForTests(null); for (const app of apps.splice(0)) app.db.close(); });
const fresh = () => { const app = testApp(); apps.push(app); updateSpace(app, "personal", { settings: { autoIngest: false } }); return app; };
const message = (id: string): LarkMessage => ({ message_id: id, chat_id: "oc_history", msg_type: "file", content: '<file key="file_sheet" name="数据.xlsx"/>', create_time: String(Date.now() - 1000) });
const context = (app: ReturnType<typeof testApp>, id: string): RunContext => ({ app, run: getRun(app, id), signal: new AbortController().signal, event() {}, output() {} });

it("advances history after saving a spreadsheet, persists parse errors and retries the saved file independently", async () => {
  const app = fresh(); app.config.lark.capture.attachments = true;
  const converter = join(app.home, "converter.cjs");
  writeFileSync(converter, 'console.error("parser unavailable"); process.exit(2)');
  app.config.documents = { engines: [], converter: `"${process.execPath}" "${converter}" {file}` };
  setLarkCliForTests(async (_args, cwd) => {
    writeFileSync(join(cwd!, "sheet.xlsx"), "fixture");
    return { data: { messages: [{ ...message("om_sheet"), resources: [{ key: "file_sheet", type: "file", local_path: "sheet.xlsx" }] }], has_more: false } };
  });
  const input = { chatId: "oc_history", name: "项目 A", spaceId: "personal", target: 0, ingest: true };
  await historyPage(app, input);
  expect(historyScan(app, input.chatId)?.phase).toBe("done");
  const refs = () => JSON.parse((app.db.prepare("select resources from lark_messages where message_id='om_sheet'").get() as { resources: string }).resources).file_sheet;
  const first = refs();
  expect(existsSync(join(app.filesDir, first.file))).toBe(true);
  expect(first.parse.status).toBe("pending");
  expect(missingResources(app, [input.chatId])).toEqual([]);
  await expect(parseLarkResource(context(app, first.parse.runId))).rejects.toThrow("parser unavailable");
  expect(refs().parse.status).toBe("failed");
  expect(historyScan(app, input.chatId)?.error).toBeUndefined();
  expect(readFileSync(join(app.filesDir, first.file), "utf8")).toBe("fixture");
  // Replay of the same page must not turn the failed parse into an endless retry loop.
  const resources = await keepResources(app, "personal", input.chatId, [{ ...message("om_sheet"), resources: [{ key: "file_sheet", local_path: first.file }] }], app.filesDir, true, true);
  persistChatMessages(app, { ...input, messages: [message("om_sheet")], resources });
  expect(app.db.prepare("select count(*) n from runs where kind='lark-resource-parse'").get()).toEqual({ n: 1 });
  app.db.prepare("update runs set status='failed' where id=?").run(first.parse.runId);
  writeFileSync(converter, 'console.log("| 字段 | 值 |\\n| --- | --- |\\n| 数量 | 2 |")');
  const original = getRun(app, first.parse.runId);
  const retry = createRun(app, { kind: original.kind, title: original.title, spaceId: original.spaceId, input: original.input });
  updateSpace(app, "personal", { settings: { autoIngest: true } });
  const result = await parseLarkResource(context(app, retry.id));
  if (!("sourceId" in result)) throw new Error("Expected a parsed source");
  expect(refs().parse).toEqual({ status: "done", runId: retry.id });
  expect(refs().sourceId).toBe(result.sourceId);
  const source = app.db.prepare("select text from sources where kind='chat'").get() as { text: string };
  expect(source.text).toContain(`src:${result.sourceId}`);
  expect(source.text.match(/\(om_sheet\)/g)).toHaveLength(1);
  expect(app.db.prepare("select input from runs where kind='ingest'").all().map(row => JSON.parse(String(row.input)).sourceIds)).toEqual([[result.sourceId]]);
  await parseLarkResource(context(app, retry.id));
  expect(app.db.prepare("select count(*) n from runs where kind='ingest'").get()).toEqual({ n: 1 });
});

it("treats covers as optional, still requires original videos, and ignores external URL copies", async () => {
  const app = fresh();
  const m: LarkMessage = { ...message("om_video"), msg_type: "post", content: '[Media: file_video]\n[截图](https://example.com/img_copy)',
    raw_content: JSON.stringify({ content: [[{ tag: "media", file_key: "file_video", image_key: "img_cover" }]] }),
    resources: [{ key: "file_video", local_path: "video.mp4" }, { key: "img_cover", type: "image", error: true }] };
  writeFileSync(join(app.home, "video.mp4"), "original video");
  const resources = await keepResources(app, "personal", "oc_history", [m], app.home, true, true);
  storeMessages(app, "oc_history", [m], { resources });
  expect(missingResources(app, ["oc_history"])).toEqual([]);
  expect(resources.get(m.message_id)?.img_cover.optional).toBe(true);
  const missing = { ...m, message_id: "om_missing", resources: [{ key: "img_cover", error: true }] };
  await expect(keepResources(app, "personal", "oc_history", [missing], app.home, true, true)).rejects.toThrow("file_video");
  expect(resourceKeys('<video key="file_video" cover="img_cover"/>').required).toEqual(new Set(["file_video"]));
  expect(resourceKeys('<video key="file_video" cover="img_cover"/>\n[Image: img_cover]').required).toEqual(new Set(["file_video", "img_cover"]));
});

it("finds the packaged parser from source and built module locations", () => {
  const root = new URL("../", import.meta.url);
  expect(doclingScript(new URL("src/sources/import.ts", root).href)).toBe(doclingScript(new URL("dist/src/sources/import.js", root).href));
  expect(doclingScript()?.replace(/\\/g, "/")).toMatch(/document-parser\/convert.py$/);
});

it.each(["csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx"])("routes %s through Docling without requiring PDF models or blocking the event loop", async ext => {
  const app = fresh(); app.config.documents = { engines: ["docling"] };
  const fake = join(app.home, "uv.cjs");
  writeFileSync(fake, 'console.log("toolchain ready"); setTimeout(()=>console.log(JSON.stringify({markdown:"parsed"})),50)');
  setToolResolverForTests(() => [process.execPath, fake]);
  let ticked = false;
  const result = convertDocument(app, join(app.home, `sample.${ext}`));
  setTimeout(() => { ticked = true; }, 5);
  expect(await result).toBe("parsed"); expect(ticked).toBe(true);
});

it("cancels conversion without deleting the saved attachment or blocking the next attempt", async () => {
  const app = fresh();
  const script = join(app.home, "converter.cjs"), file = join(app.home, "data.csv");
  writeFileSync(script, 'setTimeout(()=>console.log("parsed"),30000)');
  writeFileSync(file, "name,count\nA,2");
  app.config.documents = { engines: [], converter: `"${process.execPath}" "${script}" {file}` };
  const m = { ...message("om_cancel"), content: '<file key="file_sheet" name="data.csv"/>', resources: [{ key: "file_sheet", local_path: file }] };
  const resources = await keepResources(app, "personal", "oc_history", [m], app.home, true, true);
  persistChatMessages(app, { chatId: "oc_history", spaceId: "personal", name: "项目 A", messages: [m], resources });
  const ref = resources.get(m.message_id)!.file_sheet;
  const row = app.db.prepare("select id from runs where kind='lark-resource-parse'").get() as { id: string };
  const controller = new AbortController();
  const task = parseLarkResource({ ...context(app, row.id), signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancel fixture")), 30);
  await expect(task).rejects.toThrow("cancel fixture");
  expect(existsSync(join(app.filesDir, ref.file!))).toBe(true);
  expect(missingResources(app, ["oc_history"])).toEqual([]);
  const stored = app.db.prepare("select resources from lark_messages where message_id=?").get(m.message_id) as { resources: string };
  expect(JSON.parse(stored.resources).file_sheet.parse.status).toBe("failed");
});

it("can queue parsing of an already saved original without a new successful download", async () => {
  const app = fresh(), m = message("om_saved");
  writeFileSync(join(app.home, "sheet.xlsx"), "fixture");
  const resources = await keepResources(app, "personal", "oc_history", [{ ...m, resources: [{ key: "file_sheet", local_path: "sheet.xlsx" }] }], app.home, false, true);
  persistChatMessages(app, { chatId: "oc_history", spaceId: "personal", name: "项目 A", messages: [m], resources });
  expect(app.db.prepare("select count(*) n from runs").get()).toEqual({ n: 0 });
  const reused = await keepResources(app, "personal", "oc_history", [{ ...m, resources: [{ key: "file_sheet", error: true }] }], app.home, true, true);
  persistChatMessages(app, { chatId: "oc_history", spaceId: "personal", name: "项目 A", messages: [m], resources: reused });
  expect(app.db.prepare("select count(*) n from runs where kind='lark-resource-parse'").get()).toEqual({ n: 1 });
  expect(missingResources(app, ["oc_history"])).toEqual([]);
});
