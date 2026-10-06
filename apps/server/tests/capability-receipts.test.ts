import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { CapabilitySession } from "../src/capabilities/session.js";
import {
  CapabilityReceipts,
  receiptDigest,
} from "../src/capabilities/receipts.js";
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});

it("keeps selected earlier inputs and images after workspace removal, scoped to the same private conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-handoff-"));
  const store = new Store(join(directory, "data"));
  clean.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const archive = new CapabilityReceipts(store),
    router = archive.conversations;
  const conversation = router.open({
    principalId: "owner",
    channel: "web",
    chatId: "one",
    visibility: "private",
  });
  const first = router.enqueueTurn({
    conversationId: conversation.id,
    inputText: "比较两个方案",
  }).turn;
  const registry = new CapabilityRegistry(store.dataDir);
  registry.register({
    version: 1,
    id: "design",
    name: "Design",
    description: "Design",
    mcp: {
      transport: "stdio",
      command: process.execPath,
      args: [resolve("apps/server/tests/fixtures/capability-mcp.mjs")],
      readOnlyTools: ["read_design"],
    },
  });
  const session = new CapabilitySession(
    registry,
    registry.references(["design"]),
    {
      directory: join(directory, "question"),
      cwd: directory,
      onReceipt: (from, id) =>
        archive.save(
          { conversationId: conversation.id, turnId: first.id },
          from,
          id,
        ),
    },
  );
  clean.push(() => session.close());
  const a = await session.call("design", "mcp", "read_design", { node: "A" });
  const b = await session.call("design", "mcp", "read_design", { node: "B" });
  router.completeTurn({
    turnId: first.id,
    result: "A 和 B 是两个不同节点",
    selectedEvidence: [],
    toolActions: [],
  });
  const second = router.enqueueTurn({
    conversationId: conversation.id,
    inputText: "只做 B，开始实现",
  }).turn;
  const scope = { conversationId: conversation.id, turnId: second.id };
  await session.close();
  rmSync(join(directory, "question"), { recursive: true });
  const handoff = archive.handoff(
    scope,
    second.inputText,
    ["design"],
    [b.recordId],
  );
  expect(handoff.assignment.text).toBe(second.inputText);
  expect(handoff.discussion[0]?.userText).toBe(first.inputText);
  expect(handoff.inputs.map((r) => r.recordId)).toEqual([b.recordId]);
  expect(archive.list(scope).map((r) => r.recordId)).toContain(a.recordId);
  const dest = join(directory, "run", "external-inputs");
  archive.export(handoff.inputs, dest);
  rmSync(archive.directory, { recursive: true });
  const copied = JSON.parse(
    readFileSync(join(dest, b.recordId + ".json"), "utf8"),
  );
  expect(receiptDigest(dest, copied)).toBe(handoff.inputs[0]!.digest);
  expect(copied.args.node).toBe("B");
  const image = copied.result.content.find((c: any) => c.type === "image_file");
  expect(readFileSync(image.path).length).toBeGreaterThan(0);
  writeFileSync(image.path, "changed");
  expect(receiptDigest(dest, copied)).not.toBe(handoff.inputs[0]!.digest);
  const other = router.open({
    principalId: "owner",
    channel: "web",
    chatId: "two",
    visibility: "private",
  });
  const turn = router.enqueueTurn({
    conversationId: other.id,
    inputText: "读取之前资料",
  }).turn;
  expect(archive.list({ conversationId: other.id, turnId: turn.id })).toEqual(
    [],
  );
  expect(() =>
    archive.resolve({ conversationId: other.id, turnId: turn.id }, b.recordId),
  ).toThrow("不属于当前会话");
  expect(() => archive.handoff(scope, "模型改写交办", [], [])).toThrow(
    "交办原话",
  );
});
