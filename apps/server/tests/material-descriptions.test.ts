import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import { markdownPassages, RetrievalProjection } from "../src/retrieval/units.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { researchSnapshot } from "../src/knowledge/research-snapshot.js";
import { DatabaseSync } from "node:sqlite";
import type { MaterialDescription } from "../../../packages/contracts/src/material-description.js";
import { RoleBundleRegistry } from "../src/agent-runtime/bundles.js";

const resources: { store: Store; dir: string; retrieval: UnifiedRetrieval }[] =
  [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-descriptions-")),
    store = new Store(dir),
    retrieval = new UnifiedRetrieval(store.db);
  const result = { dir, store, retrieval };
  resources.push(result);
  return result;
}
afterEach(async () => {
  for (const r of resources.splice(0)) {
    await r.retrieval.close();
    r.store.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});
function capture(store: Store, key: string, text: string) {
  return store.capture({
    source: "manual",
    externalId: key,
    title: key,
    parts: [{ type: "text", text }],
    context: {},
  }).revision;
}
const description = (
  change: Partial<MaterialDescription> = {},
): MaterialDescription => ({
  role: "reference",
  status: "unknown",
  summary: "说明配送如何处理",
  topics: ["配送"],
  scope: null,
  validFrom: null,
  validUntil: null,
  concepts: [],
  basis: "根据材料正文",
  ...change,
});

it("keeps user corrections and historical descriptions tied to their own revision", () => {
  const { store } = setup(),
    first = capture(store, "delivery", "保存受理结果，重复通知复用结果。");
  const original = first.parts;
  store.descriptions.save(first.id, description(), "model", 0);
  const corrected = store.descriptions.save(
    first.id,
    description({ role: "plan", status: "proposed" }),
    "user",
    1,
  );
  expect(corrected.version).toBe(2);
  expect(() =>
    store.descriptions.save(first.id, description(), "model", 1),
  ).toThrow("已被更新");
  expect(() =>
    store.descriptions.save(first.id, description(), "model", 2),
  ).toThrow("保留用户修正");
  const second = capture(store, "delivery", "配送实现已经改变。");
  expect(store.descriptions.get(second.id)).toBeNull();
  expect(store.descriptions.get(first.id)?.description.role).toBe("plan");
  expect(store.revision(first.id)?.parts).toEqual(original);
  expect(
    store.db.prepare("SELECT count(*) n FROM material_descriptions").get()?.n,
  ).toBe(2);
});

it("uses persisted roles before the result limit and lets the reader explicitly find plans", async () => {
  const { store, retrieval } = setup();
  const plan = capture(
      store,
      "one",
      "配送失败后重试通知，重复配送失败后重试通知。",
    ),
    implemented = capture(store, "two", "配送失败后重试通知。");
  store.descriptions.save(
    plan.id,
    description({ role: "plan", status: "proposed" }),
    "user",
    0,
  );
  store.descriptions.save(
    implemented.id,
    description({ role: "reference", status: "current" }),
    "user",
    0,
  );
  const answer = await retrieval.search({
    text: "配送失败重试",
    purpose: "concept",
    limit: 1,
  });
  expect(answer[0]?.target).toMatchObject({ revisionId: implemented.id });
  const plans = await retrieval.search({
    text: "配送失败重试",
    materialRoles: ["plan"],
    limit: 1,
  });
  expect(plans[0]?.target).toMatchObject({ revisionId: plan.id });
  // Updating only navigation metadata invalidates the projection too.
  store.descriptions.save(plan.id, description({ role: "record" }), "user", 1);
  expect(
    await retrieval.search({ text: "配送失败重试", materialRoles: ["plan"] }),
  ).toEqual([]);
});

it("indexes passage-specific concept aliases and distinguishes effective dates from capture dates", async () => {
  const { store, retrieval } = setup();
  const revision = capture(
    store,
    "配送约定",
    "事件编号保存在受理账本，再次收到相同编号只读取结果。\n\n包装箱使用可回收材料。",
  );
  store.descriptions.save(
    revision.id,
    description({
      validFrom: "2020-01-01T00:00:00Z",
      validUntil: "2021-01-01T00:00:00Z",
      concepts: [
        {
          label: "幂等受理",
          aliases: ["重复投递去重"],
          startLine: 1,
          endLine: 1,
        },
      ],
    }),
    "model",
    0,
  );
  const hits = await retrieval.search({
    text: "重复投递去重",
    effectiveAt: "2020-02-01T00:00:00Z",
  });
  expect(hits).toHaveLength(1);
  expect(hits[0]?.text).toContain("受理账本");
  expect(hits[0]?.target).toMatchObject({ startLine: 1, endLine: 1 });
  expect(
    await retrieval.search({
      text: "重复投递去重",
      effectiveAt: "2021-02-01T00:00:00Z",
    }),
  ).toEqual([]);
  expect(await retrieval.search({ text: "重复投递去重" })).toHaveLength(1);
});

it("keeps the table introduction with its table and preserves source lines", () => {
  const text =
    "# 配送\n\n可以按责任定位：\n\n| 阶段 | 入口 |\n| --- | --- |\n| 受理 | Receiver |\n\n## 另外\n\n新的段落。";
  const passages = markdownPassages(text);
  expect(passages).toHaveLength(2);
  expect(passages[0]).toMatchObject({
    startLine: 3,
    endLine: 7,
    headingPath: ["配送"],
  });
  expect(passages[0]!.text).toBe(text.split("\n").slice(2, 7).join("\n"));
});

it("carries descriptions into the permitted Agent snapshot without unrelated metadata", () => {
  const { store, dir } = setup();
  const publicRevision = capture(store, "allowed", "配送约定"),
    privateRevision = capture(store, "private", "私人记录");
  store.descriptions.save(publicRevision.id, description(), "model", 0);
  store.descriptions.save(
    privateRevision.id,
    description({ summary: "不可暴露的材料说明" }),
    "user",
    0,
  );
  const repository = new KnowledgeRepository(store),
    file = join(dir, "scope.sqlite");
  researchSnapshot({
    repository,
    materials: repository
      .materials()
      .filter((m) => m.revisionId === publicRevision.id),
    articles: [],
    file,
  });
  const snapshot = new DatabaseSync(file, { readOnly: true });
  try {
    expect(
      snapshot.prepare("SELECT revision_id FROM material_descriptions").all(),
    ).toEqual([{ revision_id: publicRevision.id }]);
  } finally {
    snapshot.close();
  }
  expect(
    new RoleBundleRegistry().load("material-cataloger").manifest.output_schema,
  ).toBe("MaterialDescriptions.v1");
});

it("reuses admitted source indices but rebuilds outdated annotations and excludes hidden owners", async () => {
  const {store, dir} = setup();
  const kept = capture(store,"public","配送规则：发货前可修改地址。"),
    hidden = capture(store,"hidden","秘密配送安排，不可公开。");
  store.descriptions.save(kept.id,description({role:"plan",status:"proposed"}),"user",0);
  new RetrievalProjection(store.db).sync();
  // The source index is now stale, while the immutable material is unchanged.
  store.descriptions.save(kept.id,description({role:"reference",status:"current"}),"user",1);
  const repository = new KnowledgeRepository(store);
  const db = researchSnapshot({repository,materials:repository.materials().filter(m=>m.revisionId===kept.id),articles:[],file:join(dir,"warm.sqlite"),visible:id=>kept.fragments.some(f=>f.id===id)});
  const retrieval = new UnifiedRetrieval(db,undefined,undefined,true);
  try {
    const result = await retrieval.search({text:"配送",materialRoles:["reference"]});
    expect(result).toHaveLength(1);
    expect(result[0]!.materialDescription?.description.status).toBe("current");
    expect(result[0]!.target).toMatchObject({revisionId:kept.id});
    expect(db.prepare("SELECT 1 FROM retrieval_units WHERE owner=?").get("source:"+hidden.sourceId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM retrieval_units_fts WHERE body MATCH '秘密'").get()).toBeUndefined();
  } finally {await retrieval.close();db.close();}
});
