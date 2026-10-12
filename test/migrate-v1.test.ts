import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listItems } from "../src/items/store.ts";
import { listMemories } from "../src/memory/store.ts";
import { importV1 } from "../src/migrate-v1.ts";
import { listSources } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

it("imports sources, active memories and open tasks from a v1 database", () => {
  const path = join(mkdtempSync(join(tmpdir(), "v1-")), "omem.db");
  const v1 = new DatabaseSync(path);
  v1.exec(`
    create table sources(id text primary key, namespace text, external_id text, head text);
    create table revisions(id text primary key, source_id text, version int, title text, body text, fingerprint text, previous_id text, created_at text);
    create table memories(id text, workspace_id text, kind text, scope text, head_revision_id text, version int, status text, created_at text, updated_at text);
    create table memory_revisions(id text, workspace_id text, memory_id text, version int, body text, valid_from text, valid_to text, status text, evidence_set text, supersedes_revision_id text, created_at text);
    create table tasks(id text, title text, detail text, due_at text, evidence_id text, status text, created_at text, version int, follow_up text, next_step text);
  `);
  v1.prepare("insert into sources values('s1','manual','n1','r1'),('s2','repo-review','x','r2')").run();
  v1.prepare("insert into revisions values('r1','s1',1,'周会约定',?, 'f',null,'2026-09-01'),('r2','s2',1,'code',?, 'f',null,'2026-09-01')").run(
    JSON.stringify({ parts: [{ type: "text", text: "每周四下午三点同步。" }] }),
    JSON.stringify({ parts: [{ type: "text", text: "code" }] }),
  );
  v1.prepare("insert into memories values('m1','personal','claim','personal','mr1',1,'active','2026-09-01','2026-09-01'),('m2','personal','claim','personal','mr2',1,'superseded','x','x')").run();
  v1.prepare("insert into memory_revisions values('mr1','personal','m1',1,?,'2026-09-01',null,'active','[]',null,'2026-09-01'),('mr2','personal','m2',1,'old',null,null,'superseded','[]',null,'x')").run(JSON.stringify({ text: "预算上限 120 元" }));
  v1.prepare("insert into tasks values('t1','交报销单','',null,null,'open','2026-09-01',1,?, '找小王签字'),('t2','done','',null,null,'done','x',1,null,'')").run(JSON.stringify({ waiting_on: "小王" }));
  v1.close();
  const app = testApp();
  expect(importV1(app, path)).toEqual({ sources: 1, skippedSources: 1, memories: 1, items: 1 });
  expect(listSources(app, { spaceId: "personal" }).sources.map((s) => s.title)).toEqual(["周会约定"]);
  expect(listMemories(app, {}).map((m) => m.content)).toEqual(["预算上限 120 元"]);
  const [item] = listItems(app, {});
  expect([item.kind, item.waitingOn, item.detail]).toEqual(["waiting", "小王", "下一步：找小王签字"]);
});
