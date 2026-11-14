import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/main.ts";
import { all, run } from "../src/core/db.ts";
import { ensureDefaultSchedules, listSchedules, triggerSchedule } from "../src/core/scheduler.ts";
import { createSpace } from "../src/core/spaces.ts";
import { coverage, uncovered, runCoverage } from "../src/wiki/coverage.ts";
import * as generation from "../src/wiki/generate.ts";
import { citeCounts } from "../src/sources/cites.ts";
import { pullTables } from "../src/core/pull-data.ts";
import { runPeerCommand } from "../src/core/peer-exec.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
const at = () => new Date().toISOString();
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
function doc(id: string, space = "personal", fields: Record<string, string | null> = {}) {
  run(app.db, "insert into sources(id,space_id,kind,uri,title,hash,text,captured_at,updated_at,attention,attention_by) values(?,?,'doc',?,?,'hash','正文',?,?,'focus','agent')", id, space, `docs/${id}`, id, at(), at());
  for (const [key, value] of Object.entries(fields)) {
    if (!['kind', 'attention', 'attention_by', 'node_level', 'node_level_by', 'deleted_at', 'updated_at', 'uri', 'meta'].includes(key)) throw new Error(key);
    run(app.db, `update sources set ${key} = ? where id = ?`, value, id);
  }
  return id;
}
function item(id: string, refs: string[]) {
  run(app.db, "insert into items(id,space_id,kind,title,source_refs,created_at,updated_at) values(?,'personal','todo',?,?,?,?)", id, id, JSON.stringify(refs), at(), at());
}
function attempt(id: string, days: number) {
  run(app.db, "insert into wiki_coverage_tries values('personal',?,?, 'generation')", id, ago(days));
}

beforeEach(() => { app = testApp(); });
afterEach(() => { vi.restoreAllMocks(); app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

describe("重点文档覆盖", () => {
  it("resolves own and folder levels with attention's precedence, excluding non-documents and deleted originals", () => {
    doc('own', 'personal', { attention_by: 'owner' });
    doc('folder', 'personal', { attention: null, attention_by: null, node_level: 'focus', node_level_by: 'owner' });
    doc('owner-folder', 'personal', { attention: 'normal', node_level: 'focus', node_level_by: 'owner' });
    doc('owner-ignore', 'personal', { attention: 'ignore', attention_by: 'owner', node_level: 'focus', node_level_by: 'agent' });
    doc('folder-ignore', 'personal', { node_level: 'ignore', node_level_by: 'owner' });
    doc('normal', 'personal', { attention: null });
    for (const kind of ['chat', 'code', 'conversation', 'activity', 'work', 'image']) doc(kind, 'personal', { kind });
    doc('deleted', 'personal', { deleted_at: at() });
    expect(coverage(app, 'personal')).toEqual({ covered: 0, total: 3 });
    expect(uncovered(app, 'personal', 20).map((r) => r.sourceId).sort()).toEqual(['folder', 'own', 'owner-folder']);
    expect(uncovered(app, 'personal', 20).find((r) => r.sourceId === 'folder')?.ownerSet).toBe(true);
  });

  it("excludes whole-document confirmed no-search notes, but keeps partial, pending, rejected and stale notes", () => {
    for (const id of ['excluded', 'partial', 'pending', 'rejected', 'stale']) {
      doc(id);
      run(app.db, "insert into source_notes(source_id,kind,by,status,line_start,stale_at,created_at) values(?,'exclude','agent',?,?,?,?)",
        id, id === 'pending' ? 'pending' : id === 'rejected' ? 'rejected' : 'confirmed', id === 'partial' ? 1 : null, id === 'stale' ? at() : null, at());
    }
    expect(coverage(app, 'personal').total).toBe(4);
  });

  it("counts any page citation once for coverage, including pages in other spaces", () => {
    doc('covered'); doc('missing');
    run(app.db, "insert into page_cites(page_id,source_id) values('other/page','covered'),('other/page','covered')");
    expect(coverage(app, 'personal')).toEqual({ covered: 1, total: 2 });
    expect(uncovered(app, 'personal', 20).map((r) => r.sourceId)).toEqual(['missing']);
  });

  it("ranks by counted links, distinct people, citations, distinct items, owner level and recency", () => {
    doc('plain', 'personal', { updated_at: ago(100) });
    doc('recent');
    doc('owner', 'personal', { attention_by: 'owner', updated_at: ago(100) });
    doc('valued', 'personal', { attention_by: 'owner', meta: JSON.stringify({ documentId: 'DocToken12345', wikiNodeToken: 'WikiToken12345' }) });
    for (const [mid, sender, kind] of [['m1', 'p1', 'user'], ['m2', 'p1', 'user'], ['m3', 'p2', 'user'], ['m4', 'bot', 'app']]) {
      run(app.db, "insert into lark_messages(message_id,chat_id,sender_id,sender_kind,create_ms) values(?,'chat',?,?,1)", mid, sender, kind);
      run(app.db, "insert into lark_doc_links values('DocToken12345',?,'chat'),('WikiToken12345',?,'chat')", mid, mid);
    }
    run(app.db, "insert into source_cites values('valued','msg:a','answer',?),('valued','msg:b','answer',?)", at(), at());
    item('i1', ['src:valued#L1', 'src:valued#L2']); item('i2', []);
    for (const id of ['i1', 'i2']) run(app.db, "insert into item_materials(item_id,kind,ref,created_at) values(?,'source','valued',?)", id, at());
    const ranked = uncovered(app, 'personal', 20);
    expect(ranked.map((r) => r.sourceId)).toEqual(['valued', 'owner', 'recent', 'plain']);
    expect(ranked[0]).toMatchObject({ posts: 4, people: 2, cites: citeCounts(app, ['valued']).get('valued'), items: 2, ownerSet: true, recent: true, score: 23 });
    expect(uncovered(app, 'personal', 1)).toHaveLength(1);
  });

  it("does not retry within 30 days, retries later, and drops a now-cited original", () => {
    doc('yesterday'); doc('old'); doc('now-covered');
    attempt('yesterday', 1); attempt('old', 31); attempt('now-covered', 31);
    run(app.db, "insert into page_cites(page_id,source_id) values('p','now-covered')");
    expect(uncovered(app, 'personal', 20).map((r) => r.sourceId)).toEqual(['old']);
    expect(coverage(app, 'personal')).toEqual({ total: 3, covered: 1 });
    expect(pullTables.some((t) => t.name === 'wiki_coverage_tries')).toBe(true);
  });

  it("uses a fixed number of set queries without reading candidate text, runs or chunks", () => {
    for (let i = 0; i < 50; i++) doc(`doc-${i}`, 'personal', { meta: JSON.stringify({ documentId: `TokenNumber${i}` }) });
    const prepare = vi.spyOn(app.db, 'prepare');
    coverage(app, 'personal');
    uncovered(app, 'personal', 20);
    const sql = prepare.mock.calls.map(([query]) => String(query));
    expect(sql).toHaveLength(6);
    expect(sql.join('\n')).not.toMatch(/\b(?:text|runs|chunks)\b/);
    const linkQuery = sql.find((q) => q.includes('join lark_doc_links'))!;
    prepare.mockRestore();
    const plan = all<{ detail: string }>(app.db, `explain query plan ${linkQuery}`, JSON.stringify([{ id: 'doc-0', token: 'TokenNumber0' }]));
    expect(plan.some((p) => /SEARCH l USING.*INDEX/.test(p.detail))).toBe(true);
    expect(plan.some((p) => /SEARCH m USING.*INDEX/.test(p.detail))).toBe(true);
  });

  it("enforces the nightly and per-space caps and takes the globally highest scores", () => {
    createSpace(app, { id: 'a', name: '项目 A' }); createSpace(app, { id: 'b', name: '项目 B' });
    for (const [id, space] of [['a1','a'], ['a2','a'], ['a3','a'], ['b1','b'], ['p1','personal']]) {
      doc(id, space);
      if (space === 'a') run(app.db, "insert into source_cites values(?, 'answer','answer',?)", id, at());
    }
    const spy = vi.spyOn(generation, 'generateWiki');
    const made = runCoverage(app);
    expect(made.flatMap((r) => r.sourceIds)).toHaveLength(3);
    expect(made.find((r) => r.spaceId === 'a')?.sourceIds).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(made.length);
    expect(all(app.db, "select * from wiki_coverage_tries")).toHaveLength(3);
  });

  it("skips autoOrganize=false and code spaces at night; explicit manual runs still work in an opted-out space", () => {
    createSpace(app, { id: 'off', name: '项目 A' }); createSpace(app, { id: 'repo', name: '仓库 A', kind: 'repo' });
    run(app.db, "update spaces set settings = '{\"autoOrganize\":false}' where id='off'");
    doc('off-doc', 'off'); doc('code-doc', 'repo'); doc('allowed');
    expect(runCoverage(app).flatMap((r) => r.sourceIds)).toEqual(['allowed']);
    expect(runCoverage(app, { spaceId: 'off' })[0].sourceIds).toEqual(['off-doc']);
    expect(() => runCoverage(app, { spaceId: 'repo' })).toThrow('代码空间');
  });

  it("zero disables nightly work, while a manual run keeps the per-space cap and retry rule", () => {
    for (const id of ['a','b','c']) doc(id);
    app.config.wiki.coverage.nightly = 0;
    expect(runCoverage(app)).toEqual([]);
    expect(runCoverage(app, { spaceId: 'personal' })[0].sourceIds).toHaveLength(2);
    expect(uncovered(app, 'personal', 20)).toHaveLength(1);
    app.config.wiki.coverage.perSpace = 0;
    expect(runCoverage(app, { spaceId: 'personal' })).toEqual([]);
  });

  it("the real nightly schedule calls the generation entry with selected source ids, without starting writing", () => {
    doc('night-doc');
    const spy = vi.spyOn(generation, 'generateWiki');
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.id === 'wiki-coverage')).toMatchObject({ cron: '10 4 * * *', enabled: true });
    triggerSchedule(app, 'wiki-coverage');
    expect(spy).toHaveBeenCalledWith(app, expect.objectContaining({ spaceId: 'personal', sourceIds: ['night-doc'], autoWrite: true }));
    expect(spy.mock.results[0].value).toMatchObject({ kind: 'wiki-plan', status: 'queued', input: { sourceIds: ['night-doc'] } });
    expect(spy.mock.results[0].value.input.focus).toContain('src:night-doc');
  });

  it("validates source ids in the generation entry and exposes read-only peer totals", async () => {
    doc('a');
    expect(() => generation.generateWiki(app, { spaceId: 'personal', sourceIds: ['missing'] })).toThrow('所选原件');
    expect(await runPeerCommand(app, 'wiki-coverage', {})).toEqual([expect.objectContaining({ spaceId: 'personal', covered: 0, total: 1 })]);
  });
});
