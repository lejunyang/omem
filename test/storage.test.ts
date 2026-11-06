import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run as sql } from "../src/core/db.ts";
import { dbModule, mediaType, scanStorage } from "../src/core/storage-scan.ts";
import { startStorageScan, storageStatus } from "../src/core/storage.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const file = (name: string, bytes: number) => writeFileSync(join(app.filesDir, name), Buffer.alloc(bytes));
file("aaaaaaaaaaaaaaa1.mp4", 5000);
file("aaaaaaaaaaaaaaa2.png", 300);
file("aaaaaaaaaaaaaaa3.png", 200);
file("aaaaaaaaaaaaaaa4.pdf", 100);
file("aaaaaaaaaaaaaaa5.zip", 50);
sql(app.db, "insert into lark_messages(message_id, chat_id, create_ms, resources) values('om_1', 'oc_1', 0, ?)", JSON.stringify({ k1: { type: "media", file: "aaaaaaaaaaaaaaa1.mp4", name: "演示.mp4" } }));
upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://tenant.larkoffice.com/docx/abc", title: "《差旅报销制度》", text: "正文".repeat(50), meta: { url: "https://tenant.larkoffice.com/docx/abc", media: { tok: "aaaaaaaaaaaaaaa2.png" } } });
upsertSource(app, { spaceId: "personal", kind: "doc", uri: "报销.pdf", title: "报销", text: "pdf 正文", meta: { original: "aaaaaaaaaaaaaaa4.pdf" } });
upsertSource(app, { spaceId: "personal", kind: "image", uri: "lark:oc_1/截图.png", title: "截图.png", text: "图", meta: { original: "aaaaaaaaaaaaaaa3.png" } });

describe("storage", () => {
  it("groups files by origin and media type", () => {
    const r = scanStorage(app.home);
    const group = (origin: string, type: string) => r.files.groups.find((g) => g.origin === origin && g.type === type);
    expect(group("chat", "video")).toMatchObject({ bytes: 5000, files: 1 });
    expect(group("chat", "image")).toMatchObject({ bytes: 200, files: 1 });
    expect(group("doc-media", "image")).toMatchObject({ bytes: 300, files: 1 });
    expect(group("import", "document")).toMatchObject({ bytes: 100, files: 1 });
    expect(group("unreferenced", "archive")).toMatchObject({ bytes: 50, files: 1 });
    expect(r.files.total).toEqual({ bytes: 5650, files: 5 });
    expect(r.files.largest[0]).toMatchObject({ name: "aaaaaaaaaaaaaaa1.mp4", label: "演示.mp4" });
    expect(r.dirs.find((d) => d.name === "files")).toMatchObject({ bytes: 5650, files: 5 });
  });

  it("counts a hard-linked file once (pnpm links node_modules to its store) and reports it as shared", () => {
    const a = join(app.home, "workspaces", "repo", "1");
    const b = join(app.home, "runs", "r1", "work");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "dep.js"), Buffer.alloc(4000));
    linkSync(join(a, "dep.js"), join(b, "dep.js"));
    writeFileSync(join(b, "own.txt"), Buffer.alloc(10));
    const r = scanStorage(app.home);
    const dir = (n: string) => r.dirs.find((d) => d.name === n)!;
    expect(dir("workspaces").bytes + dir("runs").bytes).toBe(4010);
    expect(dir("workspaces").shared! + dir("runs").shared!).toBe(4000);
    expect(dir("workspaces").files + dir("runs").files).toBe(2);
  });

  it("splits the database by table and source category", () => {
    const r = scanStorage(app.home);
    expect(r.db.tables.find((t) => t.name === "sources")).toMatchObject({ module: "sources", rows: 3 });
    expect(r.db.tables.find((t) => t.name === "chunks_fts_data")?.module).toBe("fts");
    expect(r.db.sources.find((s) => s.category === "doc:url")).toMatchObject({ count: 1, textBytes: 300 });
    expect(r.db.sources.find((s) => s.category === "image:lark")?.count).toBe(1);
    expect(r.db.sources.find((s) => s.category === "doc")?.count).toBe(1);
  });

  it("classifies names", () => {
    expect(mediaType("x.MOV")).toBe("video");
    expect(mediaType("x.opus")).toBe("audio");
    expect(mediaType("x.bin")).toBe("other");
    expect(dbModule("memories_fts_idx")).toBe("fts");
    expect(dbModule("lark_meeting_lines")).toBe("lark");
    expect(dbModule("run_events")).toBe("runs");
  });

  it("runs in a child process and keeps the report", async () => {
    await startStorageScan(app);
    const s = storageStatus(app);
    expect(s.error).toBeNull();
    expect(s.running).toBeNull();
    expect(s.report?.files.total.files).toBe(5);
  }, 60_000);
});
