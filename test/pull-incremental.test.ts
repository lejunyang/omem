import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { all, one, run } from "../src/core/db.ts";
import { addPeer, invite } from "../src/core/peers.ts";
import { cleanupFetched, fetchPeer, mergeLibrary } from "../src/core/pull.ts";
import { readManifest } from "../src/core/pull-repos.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertItem } from "../src/items/store.ts";
import { boot } from "../src/main.ts";
import { remember } from "../src/memory/store.ts";
import { importText } from "../src/sources/import.ts";
import { getSource, upsertSource } from "../src/sources/store.ts";
import { moveSource } from "../src/sources/archive.ts";
import { mergeSources } from "../src/sources/duplicates.ts";

/**
 * A pull's snapshot (core/pull-snapshot.ts): built table by table without the derived tables, and,
 * from the second pull on, with only the sources and run events changed since the last one.
 */
describe("the snapshot a pull takes", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "omem-snap-server-"));
  const homeB = mkdtempSync(join(tmpdir(), "omem-snap-laptop-"));
  writeFileSync(join(homeA, "config.json"), JSON.stringify({ node: { id: "server" } }));
  writeFileSync(join(homeB, "config.json"), JSON.stringify({ node: { id: "laptop" } }));
  const a = await boot(homeA, { port: 0, quiet: true, background: false });
  const b = await boot(homeB, { port: 0, quiet: true, background: false });
  afterAll(async () => {
    await b.server.close();
    await a.server.close();
  });
  const A = a.app;
  const B = b.app;
  A.config.token = "owner-server";
  createSpace(A, { id: "handbook", name: "手册" });
  createSpace(B, { id: "handbook", name: "手册" });
  const rules = importText(A, "handbook", { title: "报销制度", text: "# 报销制度\n\n差旅报销在出差结束后 30 天内提交。", kind: "doc" });
  const travel = importText(A, "handbook", { title: "差旅标准", text: "# 差旅标准\n\n一线城市住宿每晚 600 元。", kind: "doc" });
  remember(A, { spaceId: "handbook", kind: "fact", content: "报销期限是 30 天", sourceRefs: [`src:${rules.id}#L3`] });
  // The laptop already holds the same document under an id of its own (captured there earlier).
  const mine = importText(B, "handbook", { title: "差旅标准", text: "# 差旅标准\n\n一线城市住宿每晚 600 元。", kind: "doc" });
  run(B.db, "update sources set uri = (select uri from sources where id = ?) where id = ?", mine.id, mine.id);
  const travelUri = one<{ uri: string }>(A.db, "select uri from sources where id = ?", travel.id)!.uri;
  run(B.db, "update sources set uri = ? where id = ?", travelUri, mine.id);
  await addPeer(B, invite(A, { url: A.baseUrl! }).code);

  const open = (dir: string) => new DatabaseSync(join(dir, "omem.db"), { readOnly: true });
  let takenAt = "";
  let again = "";

  it("is built without the search chunks and code outline, and is otherwise the whole library", async () => {
    expect(one<{ n: number }>(A.db, "select count(*) n from chunks")!.n).toBeGreaterThan(0);
    const fetched = await fetchPeer(B, "server", { selection: { parts: [], strip: true } });
    try {
      const snap = open(fetched.dbDir);
      const count = (t: string) => (snap.prepare(`select count(*) n from ${t}`).get() as { n: number }).n;
      expect(count("chunks")).toBe(0);
      expect(count("sources")).toBe(one<{ n: number }>(A.db, "select count(*) n from sources")!.n);
      expect(count("memories")).toBe(1);
      // Kept to the device: tokens, key-value state. The schema version travels.
      expect(count("api_tokens")).toBe(0);
      expect((snap.prepare("pragma user_version").get() as { user_version: number }).user_version).toBe((A.db.prepare("pragma user_version").get() as { user_version: number }).user_version);
      // Full-text tables come empty: the merge indexes what it takes.
      expect(count("memories_fts_docsize")).toBe(0);
      expect(count("chunks_fts_docsize")).toBe(0);
      snap.close();
      const manifest = readManifest(fetched.dbDir)!;
      expect(manifest.since).toBeNull();
      takenAt = manifest.takenAt!;
      expect(Date.parse(takenAt)).toBeGreaterThan(0);
      const r = mergeLibrary(B, fetched);
      expect(r.sources).toMatchObject({ added: 1 });
    } finally {
      cleanupFetched(fetched);
    }
    // The laptop's own copy of the travel document took the server's place; its search index was rebuilt here.
    expect(all<{ title: string }>(B.db, "select title from sources where space_id = 'handbook' and deleted_at is null order by title").map((s) => s.title)).toEqual(["差旅标准", "报销制度"]);
    expect(one<{ n: number }>(B.db, "select count(*) n from chunks where source_id = ?", rules.id)!.n).toBeGreaterThan(0);
  }, 60_000);

  it("from then on carries only what changed, and still maps the ids of what it left out", async () => {
    await new Promise((r) => setTimeout(r, 20));
    // On the server since the first pull: one document changed, one new, an item citing an unchanged one.
    upsertSource(A, { spaceId: "handbook", kind: "doc", uri: one<{ uri: string }>(A.db, "select uri from sources where id = ?", rules.id)!.uri, title: "报销制度", text: "# 报销制度\n\n差旅报销在出差结束后 45 天内提交。" });
    const fresh = importText(A, "handbook", { title: "加班餐标准", text: "# 加班餐标准\n\n每餐 40 元。", kind: "doc" });
    const item = upsertItem(A, undefined, { spaceId: "handbook", kind: "todo", title: "核对住宿标准", sourceRefs: [`src:${travel.id}#L3`] });
    const fetched = await fetchPeer(B, "server", { selection: { parts: [], strip: true, since: takenAt } });
    try {
      const snap = open(fetched.dbDir);
      expect((snap.prepare("select title from sources order by title").all() as { title: string }[]).map((s) => s.title)).toEqual(["加班餐标准", "报销制度"]);
      expect((snap.prepare("select id from pull_source_keys").all() as { id: string }[]).map((s) => s.id)).toContain(travel.id);
      snap.close();
      expect(readManifest(fetched.dbDir)!.since).toBe(new Date(takenAt).toISOString());
      const r = mergeLibrary(B, fetched);
      expect(r.sources).toMatchObject({ added: 1, updated: 1 });
      again = readManifest(fetched.dbDir)!.takenAt!;
    } finally {
      cleanupFetched(fetched);
    }
    expect(getSource(B, fresh.id).title).toBe("加班餐标准");
    expect(one<{ text: string }>(B.db, "select text from sources where id = ?", rules.id)!.text).toContain("45 天");
    // The item cites the travel document, which did not travel this time: its citation is the laptop's id of it.
    expect(JSON.parse(one<{ source_refs: string }>(B.db, "select source_refs from items where id = ?", item.id)!.source_refs)).toEqual([`src:${mine.id}#L3`]);
  }, 60_000);

  it("follows a source the other side has moved to another space, unless it was moved here later", async () => {
    await new Promise((r) => setTimeout(r, 20));
    createSpace(A, { id: "finance", name: "财务" });
    // Moving changes neither the text nor the time of a document: the next snapshot leaves all three out.
    moveSource(A, rules.id, "finance", "制度归财务");
    moveSource(A, travel.id, "finance", "制度归财务");
    const meals = one<{ id: string }>(A.db, "select id from sources where title = '加班餐标准'")!.id;
    moveSource(A, meals, "finance", "制度归财务");
    await new Promise((r) => setTimeout(r, 20));
    // The laptop has since put the meal standard somewhere itself.
    moveSource(B, meals, "personal", "我自己在看");
    const fetched = await fetchPeer(B, "server", { selection: { parts: [], strip: true, since: again } });
    try {
      const snap = open(fetched.dbDir);
      expect((snap.prepare("select count(*) n from sources").get() as { n: number }).n).toBe(0);
      snap.close();
      mergeLibrary(B, fetched);
    } finally {
      cleanupFetched(fetched);
    }
    const place = (id: string) => one<{ space_id: string }>(B.db, "select space_id from sources where id = ?", id)!.space_id;
    // Taken with the server's id by the first pull; and the laptop's own copy, found where it used to be.
    expect(place(rules.id)).toBe("finance");
    expect(place(mine.id)).toBe("finance");
    expect(all<{ space_id: string }>(B.db, "select distinct space_id from chunks where source_id in (?, ?)", rules.id, mine.id)).toEqual([{ space_id: "finance" }]);
    expect(one<{ n: number }>(B.db, "select count(*) n from sources where uri = (select uri from sources where id = ?) and deleted_at is null", mine.id)!.n).toBe(1);
    expect(place(meals)).toBe("personal");
    // Pulled again, whole this time: nothing moves back or twice.
    const whole = await fetchPeer(B, "server", { selection: { parts: [], strip: true } });
    try { mergeLibrary(B, whole); } finally { cleanupFetched(whole); }
    expect([place(rules.id), place(mine.id), place(meals)]).toEqual(["finance", "finance", "personal"]);
  }, 60_000);

  it("follows a copy the other side has merged into another source: what hung on it is not taken twice", async () => {
    await new Promise((r) => setTimeout(r, 20));
    // A second copy of the rules, read by a digest job; the laptop has both after a pull.
    const copy = importText(A, "finance", { title: "报销制度（旧链接）", text: "# 报销制度\n\n差旅报销在出差结束后 45 天内提交。", kind: "doc" });
    run(A.db, "insert into digest_jobs(id, space_id, mode, body, created_at, updated_at) values('dj1', 'finance', 'grade', '{}', '2026-01-01', '2026-01-01')");
    run(A.db, "insert into digest_done(job_id, source_id, hash, at) values('dj1', ?, 'h', '2026-01-02')", copy.id);
    let since = "";
    const first = await fetchPeer(B, "server", { selection: { parts: [], strip: true } });
    try {
      since = readManifest(first.dbDir)!.takenAt!;
      mergeLibrary(B, first);
    } finally {
      cleanupFetched(first);
    }
    expect(all<{ source_id: string }>(B.db, "select source_id from digest_done where job_id = 'dj1'")).toEqual([{ source_id: copy.id }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(mergeSources(A, copy.id, rules.id, "same-doc")).toBeTruthy();
    expect(all<{ source_id: string }>(A.db, "select source_id from digest_done where job_id = 'dj1'")).toEqual([{ source_id: rules.id }]);
    const fetched = await fetchPeer(B, "server", { selection: { parts: [], strip: true, since } });
    try {
      mergeLibrary(B, fetched);
    } finally {
      cleanupFetched(fetched);
    }
    // The one row, now on the kept source; the copy is an alias of it and gone from the listing.
    expect(all<{ source_id: string }>(B.db, "select source_id from digest_done where job_id = 'dj1'")).toEqual([{ source_id: rules.id }]);
    expect(one<{ source_id: string }>(B.db, "select source_id from source_aliases where alias_id = ?", copy.id)?.source_id).toBe(rules.id);
    expect(one<{ deleted_at: string | null }>(B.db, "select deleted_at from sources where id = ?", copy.id)!.deleted_at).toBeTruthy();
  }, 60_000);
});
