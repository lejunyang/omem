import { it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  archiveLibrary,
  backupLibrary,
  restoreLibrary,
  migrateLibrary,
  libraryInfo,
} from "../src/storage/library.js";
import { hydrateMessage } from "../src/storage/cold.js";

it("moves old payloads to verified cold storage while retaining revisions, dedup state and portable backups", () => {
  const root = mkdtempSync(join(tmpdir(), "omem-library-")),
    hot = join(root, "hot"),
    cold = join(root, "cold"),
    backup = join(root, "backup");
  let store: Store | undefined = new Store(hot);
  try {
    const saved = store.capture(
      {
        source: "manual",
        externalId: "evidence",
        title: "原件",
        parts: [
          { type: "text", text: "保留固定版本" },
          {
            type: "image",
            data: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
              "base64",
            ).toString("base64"),
            mimeType: "image/png",
            label: "原图",
          },
        ],
        context: {},
      },
      { learning: false, notify: false },
    );
    const image = saved.revision.parts.find((p) => p.type === "image")!;
    if (image.type !== "image") throw Error("missing asset");
    utimesSync(
      join(hot, "assets", image.assetId),
      new Date("2020-01-01"),
      new Date("2020-01-01"),
    );
    const insert = store.db.prepare(
      "INSERT INTO personal_lark_messages(id,chat_id,chat_name,digest,raw,revision_id,decision,resources,state,observed_at,updated_at) VALUES(?,'chat','需求','stable',?,?,?,'[]','ready',?,?)",
    );
    for (let i = 0; i < 202; i++)
      insert.run(
        String(i),
        JSON.stringify({ message_id: String(i), content: "约定" }),
        saved.revision.id,
        JSON.stringify({ kind: "requirement" }),
        new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
        "2020-01-01T00:00:00.000Z",
      );
    writeFileSync(join(hot, "config.json"), "{}");
    expect(() => backupLibrary(hot, join(hot, "config.json"), backup)).toThrow(
      /停止/,
    );
    store.close();
    store = undefined;
    expect(
      archiveLibrary(hot, { before: "2021-01-01", destination: cold }),
    ).toMatchObject({ applied: false, messages: 2, assets: 1 });
    expect(existsSync(cold)).toBe(false);
    archiveLibrary(hot, {
      before: "2021-01-01",
      destination: cold,
      apply: true,
      compact: true,
    });
    store = new Store(hot);
    expect(existsSync(join(hot, "assets", image.assetId))).toBe(false);
    expect(store.asset(image.assetId)?.subarray(1, 4).toString()).toBe("PNG");
    expect(store.revision(saved.revision.id)?.fragments[0]?.text).toContain(
      "保留固定版本",
    );
    const row = store.db
      .prepare("SELECT * FROM personal_lark_messages WHERE id='0'")
      .get()!;
    expect(row).toMatchObject({
      raw: "{}",
      digest: "stable",
      revision_id: saved.revision.id,
    });
    expect(JSON.parse(String(hydrateMessage(hot, row).raw)).content).toBe(
      "约定",
    );
    expect(libraryInfo(hot, join(hot, "config.json")).cold?.available).toBe(
      true,
    );
    store.close();
    store = undefined;
    backupLibrary(hot, join(hot, "config.json"), backup);
    const restored = join(root, "restored");
    restoreLibrary(backup, restored);
    store = new Store(restored);
    expect(store.asset(image.assetId)?.subarray(1, 4).toString()).toBe("PNG");
    store.close();
    store = undefined;
    expect(() => restoreLibrary(backup, restored)).toThrow(/新目录/);
    migrateLibrary(hot, join(hot, "config.json"), join(root, "moved"));
    expect(existsSync(join(hot, "omem.sqlite"))).toBe(true);
    writeFileSync(join(backup, "config.json"), "changed");
    expect(() => restoreLibrary(backup, join(root, "bad"))).toThrow(/校验失败/);
    expect(existsSync(join(root, "bad"))).toBe(false);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("recovers a stale maintenance lease and does not drop a live one", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-library-lock-"));
  try {
    writeFileSync(
      join(dir, ".maintenance"),
      JSON.stringify({ pid: 2147483647 }),
    );
    const store = new Store(dir);
    store.close();
    writeFileSync(
      join(dir, ".maintenance"),
      JSON.stringify({ pid: process.pid }),
    );
    expect(() => new Store(dir)).toThrow(/维护|归档/);
    expect(
      JSON.parse(readFileSync(join(dir, ".maintenance"), "utf8")).pid,
    ).toBe(process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
