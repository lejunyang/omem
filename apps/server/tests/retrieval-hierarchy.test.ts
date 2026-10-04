import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { materialFromRevision } from "../src/knowledge/repository.js";
import { RetrievalProjection, sourceAnchor } from "../src/retrieval/units.js";
import { contextHierarchy } from "../src/retrieval/hierarchy.js";
import { sourceContextRange } from "../src/retrieval/context.js";

it("persists chapter membership without reindexing existing passages, and keeps old citation context after a revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-context-tree-"));
  let store = new Store(dir);
  try {
    const text =
      "# 春游\n\n仅限已报名的参加者。\n\n## 预算\n\n每人80元。\n\n### 报销\n\n保留车票。\n\n## 集合\n\n图书馆门口。";
    const capture = (body: string) =>
      store.capture({
        source: "file",
        externalId: "trip",
        title: "活动.md",
        context: {},
        parts: [{ type: "text", text: body }],
      });
    const first = capture(text),
      material = materialFromRevision(store, first.revision.id)!;
    new RetrievalProjection(store.db).sync();
    const before = store.db
      .prepare("SELECT * FROM retrieval_units ORDER BY id")
      .all();
    const owner = "source:" + material.sourceId;
    store.db.prepare("DELETE FROM retrieval_contexts WHERE owner=?").run(owner);
    // This is the migration path for a database with warm FTS/vector unit IDs.
    new RetrievalProjection(store.db).sync();
    expect(
      store.db.prepare("SELECT * FROM retrieval_units ORDER BY id").all(),
    ).toEqual(before);
    store.close();
    store = new Store(dir);
    const tree = contextHierarchy(material, store.db);
    const budget = tree.nodes.find((n) => n.title === "预算")!,
      expense = tree.nodes.find((n) => n.title === "报销")!;
    expect(expense.parentId).toBe(budget.id);
    expect(budget.children).toContain(expense.id);
    expect(tree.nodes.find((n) => n.id === budget.parentId)?.title).toBe(
      "春游",
    );
    const unit = before.find((r) => String(r.text).includes("每人80元"))!;
    expect(tree.members[String(unit.id)]).toBe(budget.id);
    const hit = sourceAnchor(material, 7, 7);
    const context = sourceContextRange(material, hit, () => true, {
      db: store.db,
      unitId: String(unit.id),
    });
    expect(
      material.text
        .split("\n")
        .slice(context.startLine - 1, context.endLine)
        .join("\n"),
    ).toContain("保留车票");
    expect(context.endLine).toBeLessThan(13);
    const second = capture(text.replace("每人80元", "每人120元"));
    new RetrievalProjection(store.db).sync();
    expect(
      store.db
        .prepare("SELECT revision_id FROM retrieval_contexts WHERE owner=?")
        .get(owner)?.revision_id,
    ).toBe(second.revision.id);
    expect(contextHierarchy(material, store.db).nodes).toEqual(tree.nodes);
    expect(
      sourceContextRange(material, hit, () => true, {
        db: store.db,
        unitId: String(unit.id),
      }),
    ).toEqual(context);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("links an operation to its class and keeps attached documentation in the fixed context", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-code-context-")),
    store = new Store(dir);
  try {
    const saved = store.capture({
      source: "file",
      externalId: "delivery",
      title: "delivery.ts",
      context: { filePath: "delivery.ts" },
      parts: [
        {
          type: "text",
          text: [
            "export class Delivery {",
            "  /** Send only after payment. */",
            "  send(paid: boolean) {",
            "    if (!paid) return false;",
            "    return true;",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
    });
    new RetrievalProjection(store.db).sync();
    const material = materialFromRevision(store, saved.revision.id)!,
      tree = contextHierarchy(material, store.db);
    const method = tree.nodes.find((n) => n.title === "Delivery.send")!;
    expect(method).toBeDefined();
    expect(method.startLine).toBe(2);
    expect(tree.nodes.find((n) => n.id === method.parentId)?.title).toBe(
      "Delivery",
    );
    const row = store.db
      .prepare("SELECT id FROM retrieval_units WHERE text LIKE '%Send only%'")
      .get()!;
    expect(tree.members[String(row.id)]).toBe(method.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
