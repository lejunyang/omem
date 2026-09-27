import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { captureSchema } from "../../../packages/contracts/src/index.js";
const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-store-"));
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
const input = (text = "first") =>
  captureSchema.parse({
    source: "manual",
    externalId: "test",
    title: "A",
    parts: [{ type: "text", text }],
    provenance: {
      collectorId: "authenticated-test",
      actorId: "owner",
      actorType: "owner",
      actorVerifiedBy: "test-session",
      sourceUri: null,
      eventId: null,
      eventAt: "2026-09-27T00:00:00Z",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  });
describe("versioned evidence and transaction outbox", () => {
  it("deduplicates retries but keeps historical evidence fixed", () => {
    const s = setup();
    const a = s.capture(input());
    expect(s.capture(input()).duplicate).toBe(true);
    const b = s.capture(input("second"));
    expect(b.revision.version).toBe(2);
    expect(s.evidence(a.revision.fragments[0]!.id)?.fragment.text).toBe(
      "first",
    );
    expect(s.revision(a.revision.id)?.current).toBe(false);
    expect(s.revision(a.revision.id)?.provenance?.actorId).toBe("owner");
    expect(s.notifications()).toHaveLength(2);
  });
  it("restores as new revision and rejects stale rollback", () => {
    const s = setup();
    const a = s.capture(input());
    const b = s.capture(input("second"));
    const change = s.changes().find((c) => c.afterId === b.revision.id)!;
    const restored = s.restore(change.id, b.revision.id)!;
    expect(restored.version).toBe(3);
    expect(restored.fragments[0]?.text).toBe("first");
    expect(s.revision(b.revision.id)?.fragments[0]?.text).toBe("second");
    expect(() => s.restore(change.id, b.revision.id)).toThrow(
      "REBASE_REQUIRED",
    );
    expect(s.changes()).toHaveLength(3);
  });
  it("keeps cyclic references as navigable edges and deduplicates link writes", () => {
    const s = setup();
    const a = s.capture(input("a\n\nb")).revision;
    const [x, y] = a.fragments;
    s.link(x!.id, y!.id);
    s.link(y!.id, x!.id);
    s.link(x!.id, y!.id);
    expect(s.evidence(x!.id)?.outgoing).toHaveLength(1);
    expect(s.evidence(x!.id)?.backlinks).toHaveLength(1);
    expect(s.notifications()).toHaveLength(3);
  });
  it("rejects image type mismatch before publishing a revision", () => {
    const s = setup();
    expect(() =>
      s.capture(
        captureSchema.parse({
          ...input(),
          parts: [
            {
              type: "image",
              data: Buffer.from("not png").toString("base64"),
              mimeType: "image/png",
            },
          ],
        }),
      ),
    ).toThrow();
    expect(s.list()).toHaveLength(0);
    expect(s.notifications()).toHaveLength(0);
  });
  it("reminds an overdue task once per state version", () => {
    const s = setup();
    const t = s.createTask({
      title: "task",
      detail: "do it",
      dueAt: "2020-01-01T00:00:00Z",
    });
    s.remind();
    s.remind();
    expect(s.notifications()).toHaveLength(2);
    s.setTaskStatus(t.id, "done", 1);
    expect(() => s.setTaskStatus(t.id, "open", 1)).toThrow(
      "STALE_TASK_VERSION",
    );
    s.remind();
    expect(s.notifications()).toHaveLength(3);
    s.setTaskStatus(t.id, "open", 2);
    s.remind();
    expect(s.notifications()).toHaveLength(5);
  });
  it("keeps a literal percent search from becoming a wildcard", () => {
    const s = setup();
    s.capture(input("100% checked"));
    s.capture({ ...input("other"), externalId: "other" });
    expect(s.search("%")).toHaveLength(1);
  });
});
