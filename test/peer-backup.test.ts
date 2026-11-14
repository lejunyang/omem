import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { all } from "../src/core/db.ts";
import { App } from "../src/core/app.ts";
import { backupTick, listBackups, removeBackup, runBackup, setBackup, setBackupPullerForTests } from "../src/core/peer-backup.ts";
import { addPeer, invite } from "../src/core/peers.ts";
import { boot } from "../src/main.ts";
import { importText } from "../src/sources/import.ts";

/** The laptop keeps a copy of the server's data in a directory of its own, whenever the server can be reached. */
describe("backing up another device by itself", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "omem-bk-server-"));
  const homeB = mkdtempSync(join(tmpdir(), "omem-bk-laptop-"));
  writeFileSync(join(homeA, "config.json"), JSON.stringify({ node: { id: "server" } }));
  writeFileSync(join(homeB, "config.json"), JSON.stringify({ node: { id: "laptop" } }));
  const a = await boot(homeA, { port: 0, quiet: true, background: false });
  const b = await boot(homeB, { port: 0, quiet: true, background: false });
  afterAll(async () => {
    await b.server.close();
    await a.server.close();
  });
  afterEach(() => setBackupPullerForTests(null));
  const A = a.app;
  const B = b.app;
  A.config.token = "owner-server";
  importText(A, "personal", { title: "报销制度", text: "差旅报销在出差结束后 30 天内提交。", kind: "doc" });
  await addPeer(B, invite(A, { url: A.baseUrl! }).code);
  const dir = join(mkdtempSync(join(tmpdir(), "omem-bk-copy-")), "server-data");

  it("is set per device, never into this instance's own data directory", () => {
    expect(() => setBackup(B, { peer: "nobody", to: dir })).toThrow(/没有名为 nobody 的设备/);
    expect(() => setBackup(B, { peer: "server", to: B.home })).toThrow(/自己的数据目录/);
    expect(setBackup(B, { peer: "server", to: dir, everyHours: 6 })).toMatchObject({ peer: "server", everyHours: 6, parts: ["library", "files", "repos"] });
    expect(listBackups(B)).toEqual([expect.objectContaining({ peer: "server", running: false, paired: true })]);
  });

  it("pulls into the directory when the device answers (the real pull, in a process of its own)", async () => {
    const r = await runBackup(B, "server");
    expect(r, r.problem).toMatchObject({ ran: true });
    expect(r.okAt).toBeTruthy();
    // The copy is a data directory of its own, holding the server's document.
    const copy = App.open(dir);
    expect(all<{ title: string }>(copy.db, "select title from sources where kind = 'doc'").map((s) => s.title)).toContain("报销制度");
    copy.db.close();
    // Not due again for six hours: the schedule's look does nothing.
    let pulls = 0;
    setBackupPullerForTests(async () => (pulls++, { ok: true, output: "合并完成" }));
    await backupTick(B);
    expect(pulls).toBe(0);
  }, 120_000);

  it("a device that is away is only noted, and tried again at the next look", async () => {
    setBackup(B, { peer: "server", to: dir, everyHours: 1 });
    B.db.prepare("delete from kv where key = 'peer_backup:server'").run();
    let pulls = 0;
    setBackupPullerForTests(async () => (pulls++, { ok: true, output: "原件 新增 1\n合并完成（…）" }));
    // The server's address stops answering.
    const { readFileSync } = await import("node:fs");
    const file = join(B.home, "secrets", "peers.json");
    const saved = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify((JSON.parse(saved) as object[]).map((p) => ({ ...p, url: "http://127.0.0.1:9", urls: ["http://127.0.0.1:9"] }))));
    await backupTick(B);
    expect(pulls).toBe(0);
    expect(listBackups(B)[0]).toMatchObject({ away: true, problem: expect.any(String) });
    expect(listBackups(B)[0].okAt).toBeUndefined();
    // Back in the evening: the next look pulls.
    writeFileSync(file, saved);
    await backupTick(B);
    expect(pulls).toBe(1);
    expect(listBackups(B)[0]).toMatchObject({ summary: expect.stringContaining("原件 新增 1") });
    expect(listBackups(B)[0].problem).toBeUndefined();
    removeBackup(B, "server");
    expect(listBackups(B)).toEqual([]);
  }, 60_000);
});
