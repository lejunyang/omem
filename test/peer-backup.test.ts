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
    // Left by a pull that was killed halfway, days ago, and by one that may still be running.
    const { existsSync, mkdirSync, utimesSync } = await import("node:fs");
    const stale = join(dir, ".pull-tmp", "omem-pull-stale");
    const fresh = join(dir, ".pull-tmp", "omem-pull-fresh");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "snapshot.tar"), "half of one");
    utimesSync(stale, new Date(Date.now() - 2 * 86400_000), new Date(Date.now() - 2 * 86400_000));
    const r = await runBackup(B, "server");
    expect(r, r.problem).toMatchObject({ ran: true });
    expect(r.okAt).toBeTruthy();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
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

  it("tells the owner after three pulls in a row that failed, once, and leaves the device alone for longer each time", async () => {
    const { backupHoldOff } = await import("../src/core/peer-backup.ts");
    setBackup(B, { peer: "server", to: dir, everyHours: 1 });
    B.db.prepare("delete from kv where key = 'peer_backup:server'").run();
    const notices = () => all<{ title: string; body: string }>(B.db, "select title, body from notifications where title like 'server 的备份%' order by rowid");
    const before = notices().length;
    let pulls = 0;
    setBackupPullerForTests(async () => (pulls++, { ok: false, output: "从设备 server 拉取…\n快照传到 300 MB / 2000 MB 后 15 分钟没再收到数据：terminated" }));
    // As if each look came after the wait the one before it asked for.
    const later = () => {
      const s = JSON.parse((B.db.prepare("select value from kv where key = 'peer_backup:server'").get() as { value: string }).value);
      B.db.prepare("update kv set value = ? where key = 'peer_backup:server'").run(JSON.stringify({ ...s, triedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }));
    };
    await backupTick(B);
    expect(listBackups(B)[0]).toMatchObject({ fails: 1, away: false, problem: expect.stringContaining("没再收到数据") });
    // Twenty minutes have not passed: the next look does not have the device make another snapshot.
    await backupTick(B);
    expect(pulls).toBe(1);
    later();
    await backupTick(B);
    expect(notices().length).toBe(before);
    later();
    await backupTick(B);
    expect(listBackups(B)[0]).toMatchObject({ fails: 3 });
    expect(notices().slice(before)).toEqual([expect.objectContaining({ title: "server 的备份连续 3 次没拉下来", body: expect.stringContaining("没再收到数据") })]);
    // Told once: the fourth failure says nothing new.
    later();
    await backupTick(B);
    expect(pulls).toBe(4);
    expect(notices().length).toBe(before + 1);
    // 20 minutes, 40, 80 … six hours at most; a device that was only away is looked for at every look.
    const at = Date.parse("2026-11-14T00:00:00.000Z");
    const tried = { triedAt: new Date(at).toISOString() };
    expect(backupHoldOff({ ...tried, fails: 1 }, at + 10 * 60_000)).toBe(true);
    expect(backupHoldOff({ ...tried, fails: 1 }, at + 20 * 60_000)).toBe(false);
    expect(backupHoldOff({ ...tried, fails: 3 }, at + 60 * 60_000)).toBe(true);
    expect(backupHoldOff({ ...tried, fails: 3 }, at + 80 * 60_000)).toBe(false);
    expect(backupHoldOff({ ...tried, fails: 30 }, at + 5 * 3600_000)).toBe(true);
    expect(backupHoldOff({ ...tried, fails: 30 }, at + 6 * 3600_000)).toBe(false);
    expect(backupHoldOff({ ...tried, fails: 3, away: true }, at + 60_000)).toBe(false);
    // A pull that gets through starts the count again.
    setBackupPullerForTests(async () => ({ ok: true, output: "合并完成（…）" }));
    later();
    await backupTick(B);
    expect(listBackups(B)[0].fails).toBeUndefined();
    expect(listBackups(B)[0].problem).toBeUndefined();
    removeBackup(B, "server");
  }, 60_000);
});

describe("a backup at a time of day", () => {
  it("is due once the time has passed and nothing got through since; a device away then is caught up with later", async () => {
    const { backupDue } = await import("../src/core/peer-backup.ts");
    const app = { config: { timezone: "Asia/Shanghai" } } as never;
    const b = { peer: "server", to: "/x", everyHours: 12, at: "00:00", parts: [] } as never;
    const at = (iso: string) => Date.parse(iso);
    // 23:50 local, last pull at 00:10 the same day: not yet.
    expect(backupDue(app, b, { okAt: "2026-11-13T16:10:00.000Z" }, at("2026-11-14T15:50:00.000Z"))).toBe(false);
    // 00:00 local the next day: due.
    expect(backupDue(app, b, { okAt: "2026-11-13T16:10:00.000Z" }, at("2026-11-14T16:00:30.000Z"))).toBe(true);
    // Still due in the evening when it never got through that day; not after it did.
    expect(backupDue(app, b, { okAt: "2026-11-13T16:10:00.000Z" }, at("2026-11-15T12:00:00.000Z"))).toBe(true);
    expect(backupDue(app, b, { okAt: "2026-11-15T12:05:00.000Z" }, at("2026-11-15T13:00:00.000Z"))).toBe(false);
    expect(backupDue(app, b, {}, at("2026-11-14T03:00:00.000Z"))).toBe(true);
    // Without a time: by the hours since the last pull.
    const hourly = { peer: "server", to: "/x", everyHours: 12, parts: [] } as never;
    expect(backupDue(app, hourly, { okAt: "2026-11-14T00:00:00.000Z" }, at("2026-11-14T11:00:00.000Z"))).toBe(false);
    expect(backupDue(app, hourly, { okAt: "2026-11-14T00:00:00.000Z" }, at("2026-11-14T12:00:00.000Z"))).toBe(true);
  });
});
