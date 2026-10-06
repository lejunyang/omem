import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import {
  CapabilityReceipts,
  type CapabilityReceipt,
} from "../src/capabilities/receipts.js";
import { captureCapabilityMaterial } from "../src/capabilities/materials.js";
import { prepareAssistantResearch } from "../src/assistant/research.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "omem-external-material-"));
  const store = new Store(join(root, "data")),
    directory = join(root, "receipts");
  mkdirSync(directory);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const receipt = (text: string): CapabilityReceipt => ({
    recordId: randomUUID(),
    capability: "design",
    revision: "fixed-config",
    kind: "mcp",
    tool: "read_design",
    args: { node: "panel" },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: { content: [{ type: "text", text }] },
  });
  return { root, store, directory, receipt };
}
it("keeps selected originals and images, reuses unchanged reads, and preserves old references after changes", () => {
  const s = setup(),
    repository = new KnowledgeRepository(s.store);
  const make = (text: string) => {
    const r = s.receipt(text),
      path = join(s.directory, `${r.recordId}-1.png`);
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(path, bytes);
    (r.result as any).content.push({
      type: "image_file",
      mimeType: "image/png",
      path,
    });
    return r;
  };
  const r1 = make("# 归档入口\n\n## 布局\n两个按钮水平排列，间距 12 px。"),
    first = captureCapabilityMaterial(s.store, s.directory, r1, {
      title: "归档入口设计",
    });
  const same = captureCapabilityMaterial(
    s.store,
    s.directory,
    make(r1.result ? (r1.result as any).content[0].text : ""),
    { title: "另一标题" },
  );
  expect(same.revisionId).toBe(first.revisionId);
  expect(repository.materials()).toHaveLength(1);
  const structured = s.receipt("具体配置见结构化结果");
  (structured.result as any).structuredContent = { gap: 18, layout: "grid" };
  const structuredMaterial = captureCapabilityMaterial(
    s.store,
    s.directory,
    structured,
    { title: "网格配置" },
  );
  expect(structuredMaterial.text).toContain('"gap": 18');
  const next = captureCapabilityMaterial(
    s.store,
    s.directory,
    make("# 归档入口\n\n## 布局\n改为纵向排列，间距 16 px。"),
    { title: "归档入口设计" },
  );
  expect(next.sourceId).toBe(first.sourceId);
  expect(next.revisionId).not.toBe(first.revisionId);
  expect(
    captureCapabilityMaterial(s.store, s.directory, r1, { title: "旧引用" })
      .revisionId,
  ).toBe(first.revisionId);
  expect(repository.materials()[0]!.revisionId).toBe(next.revisionId);
  rmSync(s.directory, { recursive: true });
  expect(s.store.asset(first.images[0]!.assetId)?.length).toBeGreaterThan(0);
  expect(
    repository.resolveMaterial(first.key, first.digest)?.material.text,
  ).toContain("12 px");
  const failed = s.receipt("无权限");
  (failed.result as any).isError = true;
  expect(() =>
    captureCapabilityMaterial(s.store, s.directory, failed, { title: "失败" }),
  ).toThrow("读取失败");
  expect(repository.materials()).toHaveLength(1);
});

it("admits a captured response for same-turn search and citations without refreshing unrelated live evidence", async () => {
  const s = setup(),
    repository = new KnowledgeRepository(s.store),
    archive = new CapabilityReceipts(s.store);
  const conversation = archive.conversations.open({
    principalId: "owner",
    channel: "web",
    chatId: "capture",
    visibility: "private",
  });
  const turn = archive.conversations.enqueueTurn({
    conversationId: conversation.id,
    inputText: "保存设计并告诉我按钮间距",
  }).turn;
  const scope = { conversationId: conversation.id, turnId: turn.id };
  const initial = s.store.capture({
    source: "manual",
    externalId: "other",
    title: "无关约定",
    parts: [{ type: "text", text: "周五出发" }],
    context: {},
  });
  const env = await prepareAssistantResearch({
    repository,
    workspace: join(s.root, "task"),
    retrievalConfig: { enabled: false },
    context: { visibility: "private" } as any,
    tools: archive.tools(scope),
  });
  const client = new Client({ name: "material-check", version: "1" });
  cleanup.push(async () => {
    await client.close();
    await env.close();
  });
  const server = env.servers[0]!;
  if (server.type !== "http") throw Error("expected HTTP");
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  const call = async (name: string, args: unknown) => {
    const r = await client.callTool({ name, arguments: args as any });
    expect(r.isError, JSON.stringify(r)).not.toBe(true);
    return JSON.parse((r.content as any)[0].text);
  };
  const r = s.receipt("# 归档入口\n\n按钮间距为12px，仅归档入口采用横向排列。");
  writeFileSync(join(s.directory, r.recordId + ".json"), JSON.stringify(r));
  archive.save(scope, s.directory, r.recordId);
  s.store.capture({
    source: "manual",
    externalId: "other",
    title: "无关约定",
    parts: [{ type: "text", text: "改为周六" }],
    context: {},
  });
  const saved = await call("capture_external_input", {
    recordId: r.recordId,
    title: "归档入口设计",
  });
  expect(
    JSON.stringify(await call("read_material", { key: saved.key })),
  ).toContain("按钮间距为12px");
  expect(
    JSON.stringify(await call("search_materials", { query: "归档入口" })),
  ).toContain("12px");
  expect(
    JSON.stringify(await call("read_material", { key: "manual:other" })),
  ).toContain("周五出发");
  expect(
    JSON.stringify(await call("read_material", { key: "manual:other" })),
  ).not.toContain("周六");
  const changed = s.receipt("# 归档入口\n\n按钮间距改为16px，仍然横向排列。");
  writeFileSync(
    join(s.directory, changed.recordId + ".json"),
    JSON.stringify(changed),
  );
  archive.save(scope, s.directory, changed.recordId);
  const newer = await call("capture_external_input", {
    recordId: changed.recordId,
    title: "归档入口设计",
  });
  expect(newer.key).not.toBe(saved.key);
  expect(
    JSON.stringify(await call("read_material", { key: saved.key })),
  ).toContain("12px");
  expect(
    JSON.stringify(await call("read_material", { key: newer.key })),
  ).toContain("16px");
  expect(
    JSON.stringify(await call("search_materials", { query: "归档入口 16px" })),
  ).toContain("16px");
  await call("submit_result", {
    result: {
      answer: "按钮间距为12px。[[cite_1]]",
      citations: [
        {
          id: "cite_1",
          key: saved.key,
          revision: saved.revision,
          startLine: 3,
          endLine: 3,
        },
      ],
      create_task: null,
      update_task: null,
    },
  });
  await env.submission;
  const result: any = env.result();
  expect(result.researchedEvidence[0].sourceRevisionId).not.toBe(
    initial.revision.id,
  );
  expect(JSON.stringify(result.researchedEvidence)).toContain("12px");
});
