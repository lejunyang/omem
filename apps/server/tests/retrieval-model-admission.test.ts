import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createRetrieval } from "../src/retrieval/factory.js";
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import { candidatePool } from "../src/retrieval/candidate-pool.js";
import {
  evaluatedOrder,
  promotedOrder,
} from "../src/retrieval/evaluated-order.js";
import type { DecisionService } from "../src/decision/service.js";
import { captureRepositoryMaterials } from "../src/review/materials.js";
import { runCodeSync } from "../src/code/sync.js";

it("visits a query frontier hidden by fusion before exhausting the model budget", () => {
  const head = Array.from({ length: 80 }, (_, i) => ({
    id: `head-${i}`,
    owner: `owner-${i}`,
    score: 1 - i / 100,
    routes: ["bm25"],
    routeRanks: { bm25: i },
    recallRanks: { "0:bm25": i },
  }));
  const answer = {
    id: "answer",
    owner: "answer",
    score: 0.001,
    routes: ["bm25"],
    routeRanks: { bm25: 0 },
    recallRanks: { "1:bm25": 0 },
  };
  expect(candidatePool([...head, answer], 2).map((h) => h.id)).toEqual([
    "head-0",
    "answer",
  ]);
});

it("does not compare model scores against unscored fallback scores", () => {
  const hits = [
    { id: "a", score: 0.2 },
    { id: "unread" },
    { id: "b", score: 0.9 },
    { id: "tail" },
  ];
  expect(evaluatedOrder(hits, (h) => h.score).map((h) => h.id)).toEqual([
    "b",
    "unread",
    "a",
    "tail",
  ]);
  expect(evaluatedOrder(hits, () => undefined)).toEqual(hits);
});

it("promotes a qualified positive judgment ahead of unread slots without removing them", () => {
  const hits = [
    { id: "unread" },
    { id: "partial", score: 0.4 },
    { id: "answer", score: 0.95, strong: true },
    { id: "tail" },
  ];
  expect(
    promotedOrder(
      hits,
      (h) => h.score,
      (h) => h.strong === true,
    ).map((h) => h.id),
  ).toEqual(["answer", "unread", "partial", "tail"]);
});

it("judges recalled candidates beyond both old head cutoffs before the reading limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-admission-")),
    store = new Store(dir);
  const inputs: string[] = [];
  const service = {
    status: () => ({ status: "ready" }),
    decide: async (state: { material: string }) => {
      inputs.push(state.material);
      return {
        model: { alias: "fixture", revision: "fixed", size: "2b" },
        answers: {
          relevance: {
            choice: "answer",
            confidence: 1,
            probabilities: {
              answer: state.material.includes("durable checkpoint") ? 1 : 0.1,
            },
          },
        },
      };
    },
  } as unknown as DecisionService;
  const shared = createRetrieval(store.db, undefined, process.cwd(), service);
  try {
    for (let i = 0; i < 55; i++)
      store.capture({
        source: "manual",
        externalId: `noise-${i}`,
        title: `Discussion ${i}`,
        parts: [{ type: "text", text: `怎样保留改动，需要整理讨论 ${i}。` }],
      });
    store.capture({
      source: "manual",
      externalId: "answer",
      title: "Durability",
      parts: [
        {
          type: "text",
          text: "Preserve edits by writing a durable checkpoint.",
        },
      ],
    });
    const traces: import("../src/retrieval/unified.js").RetrievalTrace[] = [];
    const hits = await shared.retrieval.search!(
      {
        text: "怎样保留改动？",
        queryVariants: ["durable checkpoint"],
        limit: 1,
      },
      (t) => traces.push(t),
    );
    expect(inputs).toHaveLength(56);
    expect(inputs[1]).toContain("durable checkpoint");
    expect(hits[0]!.text).toContain("durable checkpoint");
    expect(traces.filter((t) => t.stage === "decision-input")).toHaveLength(56);
  } finally {
    await shared.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps an optional cross encoder's stronger answer ahead of a named definition boost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-model-priority-")),
    store = new Store(join(dir, "data"));
  const retrieval = new UnifiedRetrieval(store.db, undefined, async () => ({
    id: "fixture",
    close: async () => {},
    score: async (_q, passages) =>
      passages.map((p) => (p.includes("durable checkpoint") ? 0.9 : 0.8)),
  }));
  try {
    writeFileSync(
      join(dir, "dispatch.ts"),
      'export function saveCheckpoint() { return "保存改动讨论"; }\n',
    );
    captureRepositoryMaterials(store, dir);
    await runCodeSync(store, dir);
    store.capture({
      source: "manual",
      externalId: "answer",
      title: "Checkpoint",
      parts: [{ type: "text", text: "保存改动必须写入 durable checkpoint。" }],
    });
    const [hit] = await retrieval.search({
      text: "saveCheckpoint 保存改动如何持久化",
      limit: 1,
    });
    expect(hit!.text).toContain("durable checkpoint");
    expect(hit!.score).toBe(0.9);
    expect(hit!.reranking!.retrievalScore).not.toBe(0.9);
  } finally {
    await retrieval.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
