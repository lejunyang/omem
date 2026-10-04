import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  KnowledgeArtifact,
  KnowledgeDocument,
  KnowledgeMaterial,
} from "../../../packages/contracts/src/knowledge.js";
import { Store } from "../src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../src/knowledge/repository.js";
import { prepareAssistantResearch } from "../src/assistant/research.js";
import type { AssistantModelReply } from "../src/assistant/runtime.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "omem-assistant-research-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "data"));
  cleanup.push(() => store.close());
  const repository = new KnowledgeRepository(store);
  const capture = (externalId: string, text: string) => {
    store.capture({
      source: "manual",
      externalId,
      title: externalId,
      parts: [{ type: "text", text }],
      context: {},
    });
    return repository
      .materials()
      .find((m) => m.key === `manual:${externalId}`)!;
  };
  const open = async (visible: (id: string) => boolean) => {
    const workspace = join(root, "task");
    const environment = await prepareAssistantResearch({
      repository,
      workspace,
      retrievalConfig: { enabled: false },
      context: {
        userText: "阅读已授权材料并对照历史版本。",
        priorTurns: [],
        evidence: [],
        visibility: "group",
        visible,
        mode: "research",
      },
    });
    cleanup.push(() => environment.close());
    const client = new Client({
      name: "assistant-research-check",
      version: "1",
    });
    cleanup.push(() => client.close());
    const server = environment.servers[0]!;
    if (server.type !== "http") throw Error("HTTP MCP expected");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    return { workspace, environment, call };
  };
  return { store, repository, capture, open };
}

function document(
  key: string,
  title: string,
  target: KnowledgeDocument["citations"][number]["target"],
): KnowledgeDocument {
  return {
    key,
    title,
    summary: title,
    category: "explanation",
    sections: [
      { key: "meaning", title: "安排说明", body: `${title}。[[source]]` },
    ],
    citations: [
      {
        key: "source",
        label: "安排原文",
        reason: "这段材料说明具体安排。",
        relation: "supports",
        target,
        quote: "",
      },
    ],
    questions: [],
  };
}

function artifact(
  document: KnowledgeDocument,
  dependencies: KnowledgeArtifact["dependencies"],
): KnowledgeArtifact {
  return {
    version: 1,
      publication: {role:"article"},
    document,
    dependencies,
    generation: {
      model: "fixture-writer",
      effort: null,
      at: "2026-01-01T00:00:00Z",
      trace: {},
    },
    review: {
      model: "fixture-reviewer",
      at: "2026-01-01T00:00:01Z",
      trace: {},
      verdict: "accepted",
    },
  };
}

function publishMaterial(
  repository: KnowledgeRepository,
  key: string,
  title: string,
  material: KnowledgeMaterial,
) {
  const doc = document(key, title, {
    kind: "material",
    key: material.key,
    startLine: 1,
    endLine: 1,
  });
  return repository.publish(
    artifact(bindKnowledgeQuotes(doc, new Map([[material.key, material]])), [
      { kind: "material", key: material.key, digest: material.digest },
    ]),
  );
}

function payload(result: unknown): any {
  const content = (result as { content: { type: string; text?: string }[] })
    .content;
  return JSON.parse(content.find((block) => block.type === "text")!.text!);
}

it("does not expose personal project metadata to a shared conversation through a visible original", async () => {
  const {store, capture, open} = setup();
  const material = capture("public-note", "公开活动安排。");
  const group = store.contexts.create({name: "私人项目名", kind: "project", description: "私有范围说明"});
  store.tx(() => store.contexts.setForSource(material.sourceId, [group.id]));
  const permitted = new Set(material.fragments.map(f=>f.id));
  const {workspace, call} = await open(id=>permitted.has(id));
  expect(payload(await call("list_material_groups", {})).groups).toEqual([]);
  expect(readFileSync(join(workspace, "catalog.json"), "utf8")).not.toContain(group.id);
  expect(readFileSync(join(workspace, "groups.json"), "utf8")).not.toContain(group.name);
});

it("excludes a hidden historical dependency from native snapshots, catalogs and MCP reads even when its current article is public", async () => {
  const { repository, capture, open } = setup();
  const hidden = capture(
    "schedule",
    "私密方案 SECRET_OLD_SCHEDULE：周四出发。",
  );
  const oldChild = publishMaterial(
    repository,
    "topic:schedule",
    "SECRET_OLD_SCHEDULE 说明",
    hidden,
  );
  const parent = repository.publish(
    artifact(
      document("topic:trip", "SECRET_OLD_SCHEDULE 行程背景", {
        kind: "article",
        key: oldChild.document.key,
        section: "meaning",
      }),
      [
        {
          kind: "article",
          key: oldChild.document.key,
          digest: oldChild.revision,
        },
      ],
    ),
  );
  const current = capture("schedule", "公开安排：周五出发。");
  const newChild = publishMaterial(
    repository,
    oldChild.document.key,
    "公开出发安排",
    current,
  );
  const permitted = new Set(current.fragments.map((f) => f.id));
  const { workspace, environment, call } = await open((id) =>
    permitted.has(id),
  );

  const snapshot = new DatabaseSync(join(workspace, "snapshot.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      snapshot
        .prepare("SELECT id FROM knowledge_revisions WHERE id IN (?,?)")
        .all(oldChild.revision, parent.revision),
    ).toEqual([]);
    expect(
      snapshot
        .prepare("SELECT id FROM revisions WHERE id=?")
        .get(hidden.revisionId),
    ).toBeUndefined();
    expect(
      snapshot
        .prepare("SELECT artifact FROM knowledge_revisions")
        .all()
        .map((r) => String(r.artifact))
        .join("\n"),
    ).not.toContain("SECRET_OLD_SCHEDULE");
  } finally {
    snapshot.close();
  }
  const catalog = JSON.parse(
    readFileSync(join(workspace, "knowledge.json"), "utf8"),
  );
  expect(catalog.map((a: { revision: string }) => a.revision)).toEqual([
    newChild.revision,
  ]);
  expect(JSON.stringify(catalog)).not.toContain("SECRET_OLD_SCHEDULE");
  expect(
    (await call("read_knowledge", { key: parent.document.key })).isError,
  ).toBe(true);
  expect(
    (
      await call("read_knowledge", {
        key: oldChild.document.key,
        revision: oldChild.revision,
      })
    ).isError,
  ).toBe(true);
  expect(
    payload(await call("read_knowledge", { key: newChild.document.key }))
      .revision,
  ).toBe(newChild.revision);
  expect(
    payload(
      await call("material_history", {
        key: current.key,
        revision: hidden.revisionId,
      }),
    ),
  ).toEqual([]);
  const rejected = await call("submit_result", {
    result: {
      answer: "旧版说周四出发。[[cite_1]]",
      citations: [
        {
          id: "cite_1",
          key: current.key,
          revision: hidden.revisionId,
          startLine: 1,
          endLine: 1,
        },
      ],
      create_task: null,
      update_task: null,
    },
  });
  expect(rejected.isError).toBe(true);
  expect(environment.result()).toBeUndefined();
});

it("reads an admitted fixed child revision rather than following an inaccessible current article", async () => {
  const { repository, capture, open } = setup();
  const shared = capture("shared-schedule", "共享安排：周四下午评审。");
  const oldChild = publishMaterial(
    repository,
    "topic:review",
    "共享评审安排",
    shared,
  );
  const parent = repository.publish(
    artifact(
      document("topic:shared-project", "项目使用共享评审安排", {
        kind: "article",
        key: oldChild.document.key,
        section: "meaning",
      }),
      [
        {
          kind: "article",
          key: oldChild.document.key,
          digest: oldChild.revision,
        },
      ],
    ),
  );
  const hidden = capture(
    "private-schedule",
    "私密安排 SECRET_CURRENT：改为周六。",
  );
  const currentChild = publishMaterial(
    repository,
    oldChild.document.key,
    "SECRET_CURRENT 安排",
    hidden,
  );
  const permitted = new Set(shared.fragments.map((f) => f.id));
  const { workspace, call } = await open((id) => permitted.has(id));

  const catalog = JSON.parse(
    readFileSync(join(workspace, "knowledge.json"), "utf8"),
  );
  expect(catalog.map((a: { revision: string }) => a.revision)).toEqual([
    parent.revision,
  ]);
  expect(
    payload(await call("read_knowledge", { key: parent.document.key }))
      .dependencies,
  ).toEqual(parent.dependencies);
  const historical = payload(
    await call("read_knowledge", {
      key: oldChild.document.key,
      revision: oldChild.revision,
    }),
  );
  expect(historical.revision).toBe(oldChild.revision);
  expect(historical.sections[0].body).toContain("共享评审安排");
  expect(historical.reviewState).toBe("needs-review");
  expect(
    (
      await call("read_knowledge", {
        key: currentChild.document.key,
        revision: currentChild.revision,
      })
    ).isError,
  ).toBe(true);
});

it("submits a historical material's exact revision and line range as an immutable assistant citation", async () => {
  const { repository, store, capture, open } = setup();
  const previous = capture(
    "review-time",
    "# 项目评审\n原安排：周四 10:00 评审。\n会议室稍后通知。",
  );
  const current = capture(
    "review-time",
    "# 项目评审\n新安排：周五 17:00 评审。\n线上进行。",
  );
  const permitted = new Set(
    [...previous.fragments, ...current.fragments].map((f) => f.id),
  );
  const { environment, call } = await open((id) => permitted.has(id));
  const historical = payload(
    await call("material_history", {
      key: current.key,
      revision: previous.revisionId,
    }),
  );
  expect(historical).toHaveLength(1);
  expect(historical[0]).toMatchObject({
    revision: previous.revisionId,
    current: false,
    text: previous.text,
    lineCount: 3,
  });
  const submission = await call("submit_result", {
    result: {
      answer: "原先约定周四 10:00 评审。[[cite_1]]",
      citations: [
        {
          id: "cite_1",
          key: current.key,
          revision: previous.revisionId,
          startLine: 2,
          endLine: 2,
        },
      ],
      create_task: null,
      update_task: null,
    },
  });
  expect(submission.isError).not.toBe(true);
  const reply = environment.result() as AssistantModelReply;
  expect(reply.researchedEvidence).toHaveLength(1);
  const evidence = reply.researchedEvidence![0]!;
  expect(evidence.sourceRevisionId).toBe(previous.revisionId);
  expect(evidence.sourceTarget).toMatchObject({
    revisionId: previous.revisionId,
    key: current.key,
    startLine: 2,
    endLine: 2,
  });
  expect(evidence.text).toBe("原安排：周四 10:00 评审。");
  expect(evidence.text).not.toContain("周五");
  expect(reply.citationIds).toEqual([evidence.citationId]);
  expect(reply.answer).toContain(`[[${evidence.citationId}]]`);
  expect(store.revision(evidence.sourceRevisionId)!.id).toBe(
    previous.revisionId,
  );
  expect(environment.activity()).toContainEqual(
    expect.objectContaining({
      kind: "mcp",
      tool: "material_history",
      success: true,
    }),
  );
});
