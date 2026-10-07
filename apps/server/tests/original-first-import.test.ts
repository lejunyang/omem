import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { DocumentImportService } from "../src/imports/service.js";
import { saveImportAsset } from "../src/imports/documents.js";
import {
  LarkEventInbox,
  type LarkInboundEvent,
} from "../src/integrations/lark/realtime.js";
import type { LarkResourcePort } from "../src/integrations/lark/resources.js";
import { messageMaterial } from "../src/integrations/lark-personal/materials.js";
import { LarkResourceCache } from "../src/integrations/lark-personal/cache.js";

const directories: string[] = [];
const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function database(directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), "omem-original-first-"));
  if (!directory) directories.push(dir);
  const store = new Store(dir);
  open.push(store);
  return store;
}
function close(store: Store) {
  store.close();
  open.splice(open.indexOf(store), 1);
}

it("retains uploaded bytes through failure and restart, reparses those bytes and queues learning only after publication", async () => {
  let store = database();
  let service = new DocumentImportService(store, {
    parser: async () => {
      throw Error("解析器未准备");
    },
  });
  const bytes = Buffer.from("合成DOCX原件，仅供验证");
  const saved = await service.save({
    bytes,
    name: "活动约定.docx",
    externalId: "activity-agreement",
  });
  expect(store.asset(saved.import.originalAssetId)).toEqual(bytes);
  expect(store.list()).toHaveLength(0);
  await service.processOnce();
  expect(service.get(saved.import.id)).toMatchObject({
    state: "failed",
    error: "解析器未准备",
    revisionId: null,
  });
  const directory = store.dataDir;
  close(store);
  store = database(directory);
  let parsedBytes: Buffer | undefined;
  service = new DocumentImportService(store);
  service.reparse(saved.import.id);
  // Another restart before processing must not require uploading again.
  close(store);
  store = database(directory);
  service = new DocumentImportService(store, {
    parser: async (original, name, _dataDir, externalId) => {
      parsedBytes = original;
      return {
        source: "file",
        externalId,
        title: name,
        parts: [{ type: "text", text: "活动预算上限120元。" }],
        context: {},
      };
    },
  });
  await service.processOnce();
  expect(parsedBytes).toEqual(bytes);
  expect(service.get(saved.import.id)?.state).toBe("parsed");
  expect(store.list()).toHaveLength(1);
  expect(
    store.jobs.list().filter((job) => job.kind === "extract_claims"),
  ).toHaveLength(1);
  expect(
    store.jobs.list().find((job) => job.kind === "extract_claims")?.parentJobId,
  ).toBe(service.get(saved.import.id)?.jobId);
});

function bind(store: Store) {
  const at = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO lark_connections(id,workspace_id,app_id,tenant_brand,state,active_version,owner_open_id,created_at,updated_at)
    VALUES('connection','personal','cli_test','feishu','active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_connection_versions(id,connection_id,version,secret_ref,requested_config,capability_profile,missing_capabilities,state,created_at,updated_at)
    VALUES('version','connection',1,'test-secret','{}','{}','[]','active',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(id,workspace_id,connection_id,connection_version,binding_version,owner_open_id,target_chat_id,target_type,state,created_at)
    VALUES('binding','personal','connection',1,1,'ou_owner','oc_group','group','active',?)`,
    )
    .run(at);
}
it("recovers a bot resource job after restart and replays saved image bytes without calling a remote port", async () => {
  let store = database();
  bind(store);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZsAAAAASUVORK5CYII=",
    "base64",
  );
  const event: LarkInboundEvent = {
    appId: "cli_test",
    eventId: "event-image",
    kind: "im.message.receive_v1",
    eventTime: new Date().toISOString(),
    senderOpenId: "ou_member",
    senderType: "user",
    chatId: "oc_group",
    chatType: "group",
    messageId: "om_image",
    messageType: "image",
    parentMessageId: null,
    payload: {
      message: { content: JSON.stringify({ image_key: "img_original" }) },
    },
  };
  let reads = 0;
  const resources: LarkResourcePort = {
    resource: async () => {
      reads++;
      return png;
    },
  };
  let inbox = new LarkEventInbox(store, { resources });
  const queued = inbox.enqueue(event);
  expect(reads).toBe(0);
  expect(
    JSON.parse(store.asset(inbox.material(queued.id)!.rawAssetId)!.toString()),
  ).toEqual(event.payload);
  const directory = store.dataDir;
  close(store);
  store = database(directory);
  inbox = new LarkEventInbox(store, { resources });
  await inbox.processOnce();
  expect(reads).toBe(1);
  const saved = inbox.material(queued.id)!;
  expect(saved.resources[0]?.assetId).toBeTruthy();
  expect(store.asset(saved.resources[0]!.assetId!)).toEqual(png);
  close(store);
  store = database(directory);
  store.db
    .prepare(
      "UPDATE lark_connections SET state='failed',active_version=NULL WHERE id='connection'",
    )
    .run();
  store.db
    .prepare("UPDATE lark_bindings SET state='superseded' WHERE id='binding'")
    .run();
  let unexpectedReads = 0;
  inbox = new LarkEventInbox(store, {
    resources: {
      resource: async () => {
        unexpectedReads++;
        throw Error("离线，不应读取远端");
      },
    },
  });
  const replay = inbox.reprocess(queued.id, { mode: "saved" });
  await inbox.processSavedOnce();
  expect(store.jobs.get(replay.job.id)?.state).toBe("succeeded");
  expect(inbox.material(queued.id)?.resources[0]).toMatchObject({
    assetId: saved.resources[0]!.assetId,
    cached: true,
  });
  expect(
    store.jobs
      .list()
      .some(
        (job) =>
          job.kind === "extract_claims" &&
          job.cause === "reprocess_bot_original",
      ),
  ).toBe(true);
  expect(
    store.jobs
      .list()
      .find(
        (job) =>
          job.kind === "extract_claims" &&
          job.cause === "reprocess_bot_original",
      )?.parentJobId,
  ).toBe(replay.job.id);
  expect(unexpectedReads).toBe(0);
  const before = store.jobs
    .list()
    .filter((job) => job.kind === "extract_claims").length;
  store.db
    .prepare(
      "UPDATE lark_message_materials SET resources='[]' WHERE inbox_id=?",
    )
    .run(queued.id);
  const missing = inbox.reprocess(queued.id, { mode: "saved" });
  await inbox.processSavedOnce();
  expect(store.jobs.get(missing.job.id)?.state).toBe("failed");
  expect(
    store.jobs.list().filter((job) => job.kind === "extract_claims"),
  ).toHaveLength(before);
  expect(inbox.material(queued.id)?.resources[0]?.error).toContain(
    "尚无保存原件",
  );
  expect(unexpectedReads).toBe(0);
});

it("reparses a saved Lark response without using a newer document cache or remote access", async () => {
  const store = database();
  const uri = "https://example.feishu.cn/docx/SAVEDORIGINAL";
  const rawAssetId = await saveImportAsset(
    store.dataDir,
    Buffer.from(
      JSON.stringify({
        response: { data: { content: "原始约定：预算120元。" } },
      }),
    ),
  );
  const document = {
    parser: "lark-api" as const,
    parserVersion: "test",
    originalAssetId: rawAssetId,
    structureAssetId: rawAssetId,
    originalName: "响应.json",
    mimeType: "application/json",
    pageCount: 0,
    warnings: [],
  };
  const cached = store.capture(
    {
      source: "lark",
      externalId: "newer-doc",
      title: "更新后的约定",
      parts: [{ type: "text", text: "最新约定：预算80元。" }],
      context: {},
    },
    { learning: false },
  );
  new LarkResourceCache(store).put(
    `document:bot:test:${uri}`,
    { revisionId: cached.revision.id },
    60_000,
  );
  for (const mode of ["saved", "capture"] as const) {
    const result = await messageMaterial(
      store,
      {
        resource: async () => {
          throw Error("不能下载");
        },
      },
      {
        message_id: "doc-message",
        chat_id: "doc-chat",
        content: uri,
        create_time: new Date().toISOString(),
        msg_type: "text",
      },
      "群",
      "bot:test",
      true,
      false,
      () => {},
      {
        mode,
        readDocument: async () => {
          throw Error("不能读取远端文档");
        },
        savedResources: [
          {
            kind: "document",
            uri,
            label: "保存的约定",
            assetId: rawAssetId,
            document,
            status: "failed",
          },
        ],
      },
    );
    expect(result.resources[0]?.status).toBe("read");
    expect(
      result.input.parts.some(
        (part) => part.type === "text" && part.text.includes("预算120元"),
      ),
    ).toBe(true);
    expect(
      result.input.parts.some(
        (part) => part.type === "text" && part.text.includes("预算80元"),
      ),
    ).toBe(false);
  }
});
