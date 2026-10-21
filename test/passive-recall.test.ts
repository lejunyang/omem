import { describe, expect, it } from "vitest";
import { one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { passiveBlock, passiveRecall } from "../src/memory/passive.ts";
import { recallStats, recordRecalls } from "../src/memory/recall-stats.ts";
import { remember, updateMemoryText } from "../src/memory/store.ts";
import { embedPending, embedPendingMemories, setEmbedderForTests } from "../src/search/embeddings.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

async function setup() {
  const app = testApp();
  app.config.embeddings.provider = "local";
  setEmbedderForTests(fakeEmbedder());
  createSpace(app, { id: "proj", name: "项目 A", kind: "project" });
  const ids = {
    deploy: remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 每周二下午发布，发布前要先跑回归测试。" }).id,
    other: remember(app, { spaceId: "personal", kind: "fact", content: "小王的生日是三月十二日。" }).id,
    pref: remember(app, { spaceId: "personal", kind: "preference", content: "项目 A 发布说明用中文写，周二发布。" }).id,
    elsewhere: remember(app, { spaceId: "proj", kind: "fact", content: "项目 A 每周二下午发布，发布前跑回归测试。" }).id,
    spec: remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 每周二发布前要先跑回归测试。", agent: "reviewer" }).id,
  };
  await embedPending(app);
  while (await embedPendingMemories(app)) {}
  return { app, ids };
}

describe("passive recall", () => {
  it("adds only memories above the gate, within the run's spaces and agent, never preferences", async () => {
    const { app, ids } = await setup();
    const hits = await passiveRecall(app, { text: "项目 A 周二发布前要做什么？", spaces: ["personal"], userId: "owner", threshold: 0.5 });
    const got = hits.map((h) => h.memory.id);
    expect(got).toContain(ids.deploy);
    expect(got).not.toContain(ids.other);
    expect(got).not.toContain(ids.pref);
    expect(got).not.toContain(ids.elsewhere);
    expect(got).not.toContain(ids.spec);
    // The spec sees its own memories; all spaces (null) include the project's.
    const wide = (await passiveRecall(app, { text: "项目 A 周二发布前要做什么？", spaces: null, userId: "owner", spec: "reviewer", threshold: 0.5 })).map((h) => h.memory.id);
    expect(wide).toEqual(expect.arrayContaining([ids.deploy, ids.elsewhere, ids.spec]));
    // Unrelated messages add nothing; already shown ones are skipped.
    expect(await passiveRecall(app, { text: "今天天气怎么样", spaces: null, userId: "owner", threshold: 0.5 })).toEqual([]);
    expect((await passiveRecall(app, { text: "项目 A 周二发布前要做什么？", spaces: ["personal"], userId: "owner", threshold: 0.5, exclude: new Set([ids.deploy]) })).map((h) => h.memory.id)).not.toContain(ids.deploy);
    expect(passiveBlock(hits)).toContain(`mem:${ids.deploy}`);
    expect(passiveBlock([])).toBe("");
  });

  it("re-embeds edited memories, resets on a model change, and stays off without vectors", async () => {
    const { app, ids } = await setup();
    updateMemoryText(app, ids.other, { content: "小王的生日改成四月一日。" });
    expect(one<{ e: Uint8Array | null }>(app.db, "select embedding e from memories where id = ?", ids.other)?.e).toBeNull();
    setEmbedderForTests(fakeEmbedder("test:other"));
    await embedPending(app);
    expect(one<{ n: number }>(app.db, "select count(*) n from memories where embedding is not null")?.n).toBe(0);
    while (await embedPendingMemories(app)) {}
    expect(one<{ n: number }>(app.db, "select count(*) n from memories where embedding is null")?.n).toBe(0);
    app.config.memory.passive.enabled = false;
    expect(await passiveRecall(app, { text: "项目 A 周二发布前要做什么？", spaces: null, userId: "owner", threshold: 0 })).toEqual([]);
    app.config.memory.passive.enabled = true;
    app.config.embeddings.provider = "none";
    expect(await passiveRecall(app, { text: "项目 A 周二发布前要做什么？", spaces: null, userId: "owner", threshold: 0 })).toEqual([]);
  });

  it("counts passive additions separately in recall stats", async () => {
    const { app, ids } = await setup();
    recordRecalls(app, [ids.deploy], { runId: "r1", via: "passive" });
    recordRecalls(app, [ids.other], { runId: "r1" });
    const s = recallStats(app);
    expect(s.totalRecalls).toBe(2);
    expect(s.passiveRecalls).toBe(1);
  });
});
