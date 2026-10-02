import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/store.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";
import { captureSchema } from "../../../packages/contracts/src/index.js";

const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-retrieval-keyword-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const provenance = {
  collectorId: "keyword-test",
  actorId: "owner",
  actorType: "owner" as const,
  actorVerifiedBy: "test",
  sourceUri: null,
  eventId: null,
  eventAt: "2026-09-27T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  quoted: false,
  forwarded: false,
  producerKind: "original" as const,
};

describe("P0: RetrievalPort project handling", () => {
  it("ranks complete Chinese concepts above generic words and does not expand a title into every fragment", () => {
    const store = setup();
    for (const [id, title, text] of [
      ["answer", "相册整理", "导入旅行照片后，生成相册前先按地点整理照片，再选择封面。"],
      ["noise", "导入旅行照片生成相册", "这里介绍按钮颜色与菜单间距。"],
      ["generic", "其他", "照片可以包含多种格式。"],
    ]) store.capture(captureSchema.parse({source:"manual",externalId:id,title,parts:[{type:"text",text}]}));
    const hits = new KeywordRetrieval(store.db).searchSources({text:"导入旅行照片后怎么生成相册？",limit:10});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("按地点");
  });
  it("conversationId/application are context carriers, never a trusted project filter", () => {
    const store = setup();
    // Two sources live in different conversations. conversationId is NOT a project.
    store.capture(
      captureSchema.parse({
        source: "manual",
        externalId: "kw-a",
        title: "A doc",
        parts: [{ type: "text", text: "alpha-unique-marker-AAA" }],
        context: { conversationId: "conv-A", application: "app-A" },
        provenance,
      }),
    );
    store.capture(
      captureSchema.parse({
        source: "manual",
        externalId: "kw-b",
        title: "B doc",
        parts: [{ type: "text", text: "beta-unique-marker-BBB" }],
        context: { conversationId: "conv-B", application: "app-B" },
        provenance,
      }),
    );
    const retrieval = new KeywordRetrieval(store.db);

    // Untrusted/unknown project_id must NOT filter: even though conv-A != conv-B,
    // the source from conversation A is still recalled workspace-wide.
    const hits = retrieval.searchSources({
      text: "alpha-unique-marker",
      project_id: "conv-B",
      project_trusted: false,
      limit: 5,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.snippet).toContain("alpha-unique-marker-AAA");

    // And workspace recall still finds both sources' markers.
    expect(
      retrieval.searchSources({ text: "unique-marker", limit: 10 }).length,
    ).toBe(2);
  });

  it("searchMemories only filters by project when project_id is confirmed/trusted", () => {
    const store = setup();
    const retrieval = new KeywordRetrieval(store.db);
    // Seed an active memory scoped to project "payments".
    store.applications.applyMemory({
      metadata: {
        workspaceId: "personal",
        applicationId: "kw-mem-1",
        proposalDigest: createHash("sha256")
          .update("kw-mem-1")
          .digest("hex"),
        generation: 1,
        title: "Seed scoped memory",
        details: "payments retry policy",
        delivery: {
          channelBindingVersion: 1,
          channel: "in_app",
          target: "notification-center",
        },
      },
      memory: {
        kind: "claim",
        scope: { workspace_id: "personal", project_id: "payments" },
        body: { statement: "kw-unique-retry-term for payments" },
        evidenceSet: [],
      },
    });

    // Untrusted project_id must not exclude the payments memory.
    const untrusted = retrieval.searchMemories({
      text: "kw-unique-retry-term",
      project_id: "other-project",
      project_trusted: false,
      limit: 5,
    });
    expect(untrusted.length).toBe(1);

    // A trusted-but-wrong project DOES exclude it (contract field project_id).
    const trustedWrong = retrieval.searchMemories({
      text: "kw-unique-retry-term",
      project_id: "other-project",
      project_trusted: true,
      limit: 5,
    });
    expect(trustedWrong).toHaveLength(0);

    // A trusted matching project includes it.
    const trustedRight = retrieval.searchMemories({
      text: "kw-unique-retry-term",
      project_id: "payments",
      project_trusted: true,
      limit: 5,
    });
    expect(trustedRight.length).toBe(1);
  });

  it("searchMemories only returns active memories (invalidated are not evidence)", () => {
    const store = setup();
    const retrieval = new KeywordRetrieval(store.db);
    const apply = (applicationId: string, statement: string) =>
      store.applications.applyMemory({
        metadata: {
          workspaceId: "personal",
          applicationId,
          proposalDigest: createHash("sha256").update(applicationId).digest("hex"),
          generation: 1,
          title: applicationId,
          details: statement,
          delivery: {
            channelBindingVersion: 1,
            channel: "in_app",
            target: "notification-center",
          },
        },
        memory: {
          kind: "claim" as const,
          scope: { workspace_id: "personal" },
          body: { statement },
          evidenceSet: [],
        },
      });
    const active = apply("kw-mem-active", "kw-active-term present");
    const inactive = apply("kw-mem-inactive", "kw-active-term also here");
    store.db
      .prepare("UPDATE memories SET status='invalidated' WHERE id=?")
      .run(inactive.entityId);
    const hits = retrieval.searchMemories({
      text: "kw-active-term",
      limit: 10,
    });
    expect(hits.every((m) => m.status === "active")).toBe(true);
    expect(hits.map((m) => m.id)).toContain(active.entityId);
    expect(hits.map((m) => m.id)).not.toContain(inactive.entityId);
    expect(hits.length).toBe(1);
  });
});

it("does not combine far-apart words in a long fragment into a relevant passage",()=>{
  const store=setup();
  const words=["海边","度假","交通","渡轮","船票","岛屿","天气","酒店"];
  store.capture(captureSchema.parse({source:"manual",externalId:"long-misc",title:"零散清单",parts:[{type:"text",text:words.join("普通文字".repeat(180))}]}));
  store.capture(captureSchema.parse({source:"manual",externalId:"travel",title:"上岛交通",parts:[{type:"text",text:"海边度假去岛屿，需要乘渡轮，提前购买船票安排交通。"}]}));
  const hits=new KeywordRetrieval(store.db).searchSources({text:words.join(" ")});
  expect(hits).toHaveLength(1);
  expect(hits[0]!.snippet).toContain("提前购买船票");
});
