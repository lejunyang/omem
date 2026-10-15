import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { cleanupFetched, fetchRemote, mergeLibrary, overwriteLocal } from "../src/core/pull.ts";
import { createSpace, ensurePersonalSpace, getSpace } from "../src/core/spaces.ts";
import { upsertItem } from "../src/items/store.ts";
import { remember, supersede } from "../src/memory/store.ts";
import { search } from "../src/search/search.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { writePage } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

/** A "fetched" copy of a library, the way fetchRemote leaves it: omem.db + library/ + files/. */
function snapshot(app: App) {
  const dir = mkdtempSync(join(tmpdir(), "omem-snap-"));
  app.db.prepare("vacuum into ?").run(join(dir, "omem.db"));
  execFileSync("cp", ["-R", app.libraryDir, join(dir, "library")]);
  execFileSync("cp", ["-R", app.filesDir, join(dir, "files")]);
  return dir;
}

describe("pulling a library from another machine", () => {
  it("merges both sides: newer wins, chats grow, history is unioned, nothing runs twice", async () => {
    const local = testApp();
    const remote = testApp();
    // Same document on both sides; remote edited later.
    upsertSource(local, { spaceId: "personal", kind: "doc", uri: "plan.md", title: "计划", text: "预算 100" });
    await new Promise((r) => setTimeout(r, 5));
    upsertSource(remote, { spaceId: "personal", kind: "doc", uri: "plan.md", title: "计划", text: "预算 120" });
    // A chat that only grew on the remote.
    appendToSource(local, { spaceId: "personal", kind: "chat", uri: "lark:oc_1", title: "群", lines: ["a"] });
    appendToSource(remote, { spaceId: "personal", kind: "chat", uri: "lark:oc_1", title: "群", lines: ["a", "b", "c"] });
    // Remote-only things.
    createSpace(remote, { id: "proj", name: "项目", kind: "repo", rootPath: mkdtempSync(join(tmpdir(), "omem-repo-")) });
    const m1 = remember(remote, { spaceId: "personal", kind: "fact", content: "周四和小王同步" });
    supersede(remote, m1.id, { content: "周五和小王同步", reason: "改期" });
    const item = upsertItem(remote, undefined, { title: "交报销单", kind: "todo" }, "user");
    upsertItem(remote, item.id, { detail: "附发票" }, "user");
    createRun(remote, { kind: "heartbeat", spaceId: "personal", title: "巡检" }); // queued over there
    writePage(remote, "personal", "notes", { meta: { title: "笔记" }, body: "远端写的页面" });
    writeFileSync(join(remote.filesDir, "abc.pdf"), "pdf");
    // Local-only memory stays.
    const mine = remember(local, { spaceId: "personal", kind: "preference", content: "回复用中文" });

    const snapDir = snapshot(remote);
    const fetched = { dbDir: snapDir, libraryDir: join(snapDir, "library"), filesDir: join(snapDir, "files"), fetchedFiles: [] };
    // The remote repo path does not exist on this machine.
    const db = new (await import("node:sqlite")).DatabaseSync(join(fetched.dbDir, "omem.db"));
    db.prepare("update spaces set root_path = '/nowhere/proj' where id = 'proj'").run();
    db.close();

    const dry = mergeLibrary(local, fetched, { dryRun: true });
    expect(dry.sources.updated).toBe(2);
    expect(one<{ n: number }>(local.db, "select count(*) n from memories")!.n).toBe(1); // dry run wrote nothing

    const r = mergeLibrary(local, fetched);
    expect(r.sources).toMatchObject({ updated: 2 });
    const text = (uri: string) => one<{ text: string }>(local.db, "select text from sources where uri = ?", uri)!.text;
    expect(text("plan.md")).toBe("预算 120");
    expect(text("lark:oc_1").split("\n")).toHaveLength(3);
    // Indexes were rebuilt: the merged text is searchable.
    expect((await search(local, "预算 120")).some((h) => h.snippet.includes("120"))).toBe(true);
    // Memories: the supersede chain and the local-only one.
    const mems = all<{ content: string; status: string }>(local.db, "select content, status from memories order by created_at");
    expect(mems.map((m) => `${m.status}:${m.content}`).sort()).toEqual(["active:周五和小王同步", "active:回复用中文", "superseded:周四和小王同步"].sort());
    expect((await search(local, "小王")).some((h) => h.type === "memory")).toBe(true);
    expect(all(local.db, "select 1 from memories where id = ?", mine.id)).toHaveLength(1);
    // Item and its whole timeline.
    expect(all(local.db, "select * from item_events where item_id = ?", item.id).length).toBeGreaterThanOrEqual(2);
    // The remote's queued run does not run here.
    expect(one<{ status: string }>(local.db, "select status from runs where kind = 'heartbeat'")!.status).toBe("cancelled");
    // Repo space without a local path: kept, path remembered for re-linking.
    const proj = getSpace(local, "proj");
    expect(proj.rootPath).toBeNull();
    expect(proj.settings.remoteRootPath).toBe("/nowhere/proj");
    // Wiki and files.
    expect(readFileSync(join(local.libraryDir, "personal", "wiki", "notes.md"), "utf8")).toContain("远端写的页面");
    expect(one(local.db, "select 1 from pages where id = 'personal/notes'")).toBeTruthy();
    expect(existsSync(join(local.filesDir, "abc.pdf"))).toBe(true);

    // Merging the same snapshot again changes nothing.
    const againDir = snapshot(remote);
    const again = mergeLibrary(local, { dbDir: againDir, libraryDir: join(againDir, "library"), filesDir: join(againDir, "files"), fetchedFiles: [] });
    expect(again.sources.updated + again.sources.added).toBe(0);
    expect(again.memories.added + again.memories.updated).toBe(0);
    expect(again.item_events.added).toBe(0);
    cleanupFetched(againDir);
  });

  it("keeps the local page on a wiki conflict and saves the remote one beside it", () => {
    const local = testApp();
    const remote = testApp();
    writePage(local, "personal", "same", { meta: { title: "同名" }, body: "本地版本" });
    writePage(remote, "personal", "same", { meta: { title: "同名" }, body: "远端版本" });
    const f = snapshot(remote);
    const r = mergeLibrary(local, { dbDir: f, libraryDir: join(f, "library"), filesDir: "", fetchedFiles: [] });
    expect(r.wiki?.conflicts).toEqual(["personal/wiki/same.md"]);
    expect(readFileSync(join(local.libraryDir, "personal/wiki/same.md"), "utf8")).toContain("本地版本");
    expect(readFileSync(join(local.libraryDir, "personal/wiki/same.remote.md"), "utf8")).toContain("远端版本");
  });

  it("overwrite replaces data, keeps config and a backup, and defuses queued runs", () => {
    const remote = testApp();
    createRun(remote, { kind: "dream", spaceId: "personal", title: "整理" });
    remember(remote, { spaceId: "personal", kind: "fact", content: "来自服务器" });
    const local = testApp();
    remember(local, { spaceId: "personal", kind: "fact", content: "本地旧数据" });
    writeFileSync(join(local.home, "config.json"), JSON.stringify({ port: 5555 }));
    const home = local.home;
    local.db.close();
    const f = snapshot(remote);
    const backup = overwriteLocal(home, { dbDir: f, libraryDir: join(f, "library"), filesDir: join(f, "files"), fetchedFiles: [] });
    const after = App.open(home);
    ensurePersonalSpace(after);
    expect(all<{ content: string }>(after.db, "select content from memories").map((m) => m.content)).toEqual(["来自服务器"]);
    expect(one<{ status: string }>(after.db, "select status from runs")!.status).toBe("cancelled");
    expect(after.config.port).toBe(5555);
    expect(existsSync(join(backup, "omem.db"))).toBe(true);
    run(after.db, "select 1");
  });
});
