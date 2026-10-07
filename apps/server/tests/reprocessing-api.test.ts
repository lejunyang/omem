import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import {
  profileSchema,
  type CaptureInput,
} from "../../../packages/contracts/src/index.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../src/knowledge/repository.js";
import {
  restoreKnowledgeArticles,
  writeKnowledgeArticle,
} from "../src/knowledge/artifacts.js";
import { saveImportAsset } from "../src/imports/documents.js";
import {
  LarkEventInbox,
  type LarkInboundEvent,
} from "../src/integrations/lark/realtime.js";
import { DurableJobWorker } from "../src/jobs/worker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-reprocessing-api-"));
  const config: Config = {
    dataDir: dir,
    agentCwd: join(dir, "agents"),
    host: "127.0.0.1",
    port: 0,
    captureRoots: [],
    notifications: { mode: "instant" },
    decisions: { mode: "off" },
    logging: { level: "silent" },
    learning: { enabled: false, profileId: "unused", pollMs: 1000 },
    lark: { enabled: false, pollMs: 1000 },
    profiles: [
      profileSchema.parse({
        id: "unused",
        name: "Never invoked",
        transport: "traex-cli",
        command: "/usr/bin/false",
      }),
    ],
  };
  const previous = process.env.OMEM_REPO_ROOT;
  delete process.env.OMEM_REPO_ROOT;
  let built: Awaited<ReturnType<typeof buildApp>>;
  try {
    built = await buildApp(config);
  } finally {
    if (previous !== undefined) process.env.OMEM_REPO_ROOT = previous;
  }
  cleanup.push(async () => {
    await built.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, built };
}
async function document(
  built: Awaited<ReturnType<typeof buildApp>>,
  externalId: string,
  text: string,
) {
  const originalAssetId = await saveImportAsset(
    built.store.dataDir,
    Buffer.from(text),
  );
  const input: CaptureInput = {
    source: "file",
    externalId,
    title: "活动约定.docx",
    parts: [{ type: "text", text }],
    context: {
      document: {
        parser: "docling",
        parserVersion: "synthetic-api-input",
        originalAssetId,
        structureAssetId: originalAssetId,
        originalName: "活动约定.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount: 0,
        warnings: [],
      },
    },
  };
  return {
    capture: built.store.capture(input, { learning: false, notify: false }),
    originalAssetId,
  };
}
async function request(
  built: Awaited<ReturnType<typeof buildApp>>,
  target: string,
  targetId: string,
  action: string,
  replace = false,
) {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/reprocessing",
    payload: { requestId: randomUUID(), target, targetId, action, replace },
  });
  expect(response.statusCode).toBe(202);
  const id = response.json().id as string;
  await built.reprocessing.processOnce();
  return {
    id,
    read: async () =>
      (await built.app.inject("/api/reprocessing/" + id)).json(),
  };
}

it("deletes generated results through HTTP while retaining the current original and rejecting restoration of a cleared article", async () => {
  const { built, dir } = await setup();
  const source = await document(built, "activity", "活动预算上限120元。");
  const repository = new KnowledgeRepository(built.store),
    material = repository.materials()[0]!;
  const brief = {
    key: "activity-guide",
    title: "参加活动前的约定",
    reader: "参加者",
    goal: "了解活动费用",
    scenario: "准备参加活动",
    kind: "reference" as const,
    order: 0,
    questions: ["预算是多少？"],
    entryPaths: [],
    topicPath: ["活动"],
    materialKeys: [material.key],
  };
  repository.savePlan(brief, true);
  // Synthetic article data exercises deletion/restoration; it is not an AI-quality result.
  const article = repository.publish({
    version: 1,
    reading: brief,
    publication: { role: "reference" },
    document: bindKnowledgeQuotes(
      {
        key: brief.key,
        title: brief.title,
        summary: "了解活动费用",
        category: "活动",
        sections: [
          {
            key: "budget",
            title: "预算",
            body: "活动预算上限120元。[[budget]]",
          },
        ],
        citations: [
          {
            key: "budget",
            label: "原约定",
            reason: "费用约定",
            relation: "supports",
            target: {
              kind: "material",
              key: material.key,
              startLine: 1,
              endLine: 1,
            },
            quote: "",
          },
        ],
        questions: [],
      },
      new Map([[material.key, material]]),
    ),
    dependencies: [
      { kind: "material", key: material.key, digest: material.digest },
    ],
    generation: {
      model: "synthetic-api-data",
      at: "2026-01-01T00:00:00Z",
      trace: {},
    },
    review: {
      model: "synthetic-api-data",
      at: "2026-01-01T00:00:01Z",
      verdict: "accepted",
      trace: {},
    },
  });
  const artifacts = join(dir, "saved-articles");
  writeKnowledgeArticle(artifacts, article);
  const deletion = await request(
    built,
    "source",
    source.capture.revision.sourceId,
    "delete",
    true,
  );
  expect((await deletion.read()).state).toBe("succeeded");
  expect(
    (
      await built.app.inject(
        `/api/revisions/${source.capture.revision.id}/document/original`,
      )
    ).body,
  ).toBe("活动预算上限120元。");
  expect(built.store.asset(source.originalAssetId)).toEqual(
    Buffer.from("活动预算上限120元。"),
  );
  expect(
    (await built.app.inject("/api/knowledge/articles/activity-guide"))
      .statusCode,
  ).toBe(404);
  expect(restoreKnowledgeArticles(repository, artifacts)[0]?.state).toBe(
    "removed",
  );
  expect(
    (await built.app.inject("/api/knowledge/articles/activity-guide"))
      .statusCode,
  ).toBe(404);
  expect(
    repository.pages().find((page) => page.key === brief.key)?.plan?.goal,
  ).toBe(brief.goal);
});

it("returns 410 for a retired original and evidence, and 404 for an unknown original", async () => {
  const { built } = await setup();
  const old = await document(built, "mutable-document", "旧约定120元。");
  const current = await document(built, "mutable-document", "新约定80元。");
  expect(
    (await built.app.inject(`/api/revisions/${old.capture.revision.id}`))
      .statusCode,
  ).toBe(410);
  expect(
    (
      await built.app.inject(
        `/api/revisions/${old.capture.revision.id}/document/original`,
      )
    ).statusCode,
  ).toBe(410);
  expect(
    (
      await built.app.inject(
        `/api/evidence/${old.capture.revision.fragments[0]!.id}`,
      )
    ).statusCode,
  ).toBe(410);
  expect(
    (
      await built.app.inject(
        `/api/revisions/${current.capture.revision.id}/document/original`,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await built.app.inject("/api/revisions/unknown/document/original"))
      .statusCode,
  ).toBe(404);
});

it("replays a saved bot event with bot configuration disabled and waits for its persisted learning and review jobs", async () => {
  const { built, config } = await setup();
  expect(built.larkRuntime).toBeNull();
  const at = new Date().toISOString();
  built.store.db
    .prepare(
      `INSERT INTO lark_connections(id,workspace_id,app_id,tenant_brand,state,active_version,created_at,updated_at)
    VALUES('bot','personal','cli_saved','feishu','active',NULL,?,?)`,
    )
    .run(at, at);
  const event: LarkInboundEvent = {
    appId: "cli_saved",
    eventId: "saved-message",
    kind: "im.message.receive_v1",
    eventTime: at,
    senderOpenId: "ou_member",
    senderType: "user",
    chatId: "oc_saved",
    chatType: "group",
    messageId: "om_saved",
    messageType: "text",
    parentMessageId: null,
    text: "活动预算120元。",
    payload: {
      message: { content: JSON.stringify({ text: "活动预算120元。" }) },
    },
  };
  const inbox = new LarkEventInbox(built.store),
    receipt = inbox.persist(event);
  const captured = built.store.capture(
    {
      source: "chat",
      externalId: "cli_saved:om_saved",
      title: "活动消息",
      parts: [{ type: "text", text: "活动预算120元。" }],
      context: { conversationId: "oc_saved" },
    },
    { learning: false },
  );
  built.store.db
    .prepare("UPDATE lark_message_materials SET revision_id=? WHERE inbox_id=?")
    .run(captured.revision.id, receipt.id);
  built.store.db
    .prepare("UPDATE lark_connections SET state='failed' WHERE id='bot'")
    .run();
  const derived = built.store.createTask({
    title: "旧模型事项",
    detail: "旧约定的后续事项",
    dueAt: null,
    evidenceId: captured.revision.fragments[0]!.id,
  });
  built.store.db
    .prepare(
      `INSERT INTO application_receipts(id,workspace_id,application_id,proposal_digest,application_generation,request_digest,entity_type,entity_id,entity_version,change_id,created_at)
    VALUES(?,'personal',?,?,1,?,'task',?,1,?,?)`,
    )
    .run(
      derived.id,
      "proposal:" + derived.id,
      derived.id,
      derived.id,
      derived.id,
      built.store.changes()[0]!.id,
      at,
    );
  // Enable submission policy only. No model worker or external Agent is started;
  // controlled durable jobs below exercise the HTTP completion contract.
  config.learning!.enabled = true;
  const replay = await request(
    built,
    "bot-event",
    receipt.id,
    "understand",
    true,
  );
  await inbox.processSavedOnce();
  let state = await replay.read();
  expect(state.state).toBe("running");
  expect(state.result.cleared.cleared.tasks).toContain(derived.id);
  expect(built.store.tasks().some((task) => task.id === derived.id)).toBe(
    false,
  );
  expect(
    state.jobs.some((job: { kind: string }) => job.kind === "extract_claims"),
  ).toBe(true);
  expect(
    built.store.asset(inbox.material(receipt.id)!.rawAssetId),
  ).toBeTruthy();
  const fingerprint = () => ({
    model: null,
    effort: null,
    promptHash: "api-contract",
    skillHash: "",
    toolHash: "",
  });
  const extraction = new DurableJobWorker(
    built.store.jobs,
    "api-extract",
    {
      extract_claims: async (job) => {
        built.store.jobs.enqueue({
          kind: "api-review-check",
          inputRefs: [{ extractionJobId: job.id }],
          parentJobId: job.id,
          roleVersion: "api-check@1",
          policyVersion: "api-check@1",
        });
        return {};
      },
    },
    { kinds: ["extract_claims"], fingerprint },
  );
  await extraction.processOne();
  expect((await replay.read()).state).toBe("running");
  const review = new DurableJobWorker(
    built.store.jobs,
    "api-review",
    {
      "api-review-check": async () => {
        throw Error("复核未完成，不能报告成功");
      },
    },
    { kinds: ["api-review-check"], fingerprint },
  );
  await review.processOne();
  state = await replay.read();
  expect(state.state).toBe("failed");
  expect(state.error).toContain("复核未完成");
  expect((await built.app.inject("/api/reprocessing/unknown")).statusCode).toBe(
    404,
  );
});
