import { afterAll, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { tx } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { now } from "../src/core/util.ts";
import { citationReach } from "../src/sources/reach.ts";
import { archiveEvidenceFor, homingOverview, sweepHoming } from "../src/sources/homing.ts";
import { testApp } from "./helpers.ts";

/**
 * The nightly “从个人空间归位” check on a library the size of a real one (docs/v2/archive-routing.md
 * §7): 3000 kept personal documents, 12 000 other sources, 3000 items and memories, 1000 pages with
 * 20 000 citations, 60 000 messages. The check must leave the event loop free (no synchronous step
 * longer than a few hundred milliseconds) and finish in reasonable time.
 */
const app = testApp();
afterAll(() => app.db.close());
const N = { personal: 3000, other: 12000, items: 3000, memories: 3000, pages: 1000, cites: 20000, messages: 60000, kbs: 20, folders: 300 };
const spaces = Array.from({ length: 10 }, (_, i) => `biz-${i}`);
for (const s of spaces) createSpace(app, { id: s, name: `业务 ${s}`, kind: "project" });
createUser(app, { id: "colleague", name: "小王" });
addMember(app, spaces[0], "colleague", "reader");

const at = now();
tx(app.db, () => {
  const src = app.db.prepare("insert into sources(id,space_id,kind,uri,title,hash,text,meta,captured_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)");
  const route = app.db.prepare("insert into source_routes(source_id,origin_space,mode,reason,decision_hash,pending) values(?,?,?,?,?,0)");
  const meta = (i: number) => JSON.stringify({ wikiSpaceId: `kb${i % N.kbs}`, wikiParentNodeToken: `P${i % N.folders}`, wikiSpaceName: `知识库 ${i % N.kbs}`, wikiPath: `目录 ${i % N.folders}` });
  for (let i = 0; i < N.personal; i++) {
    src.run(`p${i}`, "personal", "doc", `https://tenant.larkoffice.com/wiki/PERSONALDOC${String(i).padStart(6, "0")}`, `个人文档 ${i}`, `h${i}`, `第 ${i} 份文档的正文`, meta(i), at, at);
    route.run(`p${i}`, "personal", "fallback", "未命中归档规则，暂存个人空间", `h${i}`);
  }
  for (let i = 0; i < N.other; i++) {
    const space = spaces[i % spaces.length];
    src.run(`o${i}`, space, i % 3 ? "code" : "doc", `doc/${space}/${i}`, `其他 ${i}`, `x${i}`, "正文", i % 3 ? "{}" : meta(i), at, at);
  }
  const ws = app.db.prepare("insert into wiki_spaces(id,name,status,target_space,discovered_at) values(?,?,?,?,?)");
  for (let k = 0; k < N.kbs; k++) ws.run(`kb${k}`, `知识库 ${k}`, k % 2 ? "mapped" : "new", k % 2 ? spaces[k % spaces.length] : null, at);
  const item = app.db.prepare("insert into items(id,space_id,kind,title,source_refs,created_at,updated_at) values(?,?,?,?,?,?,?)");
  for (let i = 0; i < N.items; i++) item.run(`i${i}`, spaces[i % spaces.length], "todo", `事项 ${i}`, JSON.stringify([`src:p${(i * 7) % N.personal}#L1`, `src:o${i}`]), at, at);
  const mem = app.db.prepare("insert into memories(id,space_id,kind,content,source_refs,created_at,updated_at) values(?,?,?,?,?,?,?)");
  for (let i = 0; i < N.memories; i++) mem.run(`m${i}`, spaces[i % spaces.length], "fact", `记忆 ${i}`, JSON.stringify([`src:p${(i * 11) % N.personal}#L2`]), at, at);
  const page = app.db.prepare("insert into pages(id,space_id,slug,title,body,hash,updated_at) values(?,?,?,?,?,?,?)");
  const cite = app.db.prepare("insert into page_cites(page_id,source_id,line_start,line_end,hash) values(?,?,1,1,'h')");
  for (let i = 0; i < N.pages; i++) page.run(`${spaces[i % spaces.length]}/page-${i}`, spaces[i % spaces.length], `page-${i}`, `页面 ${i}`, "正文", "h", at);
  for (let i = 0; i < N.cites; i++) cite.run(`${spaces[i % spaces.length]}/page-${i % N.pages}`, i % 4 ? `o${i % N.other}` : `p${(i * 13) % N.personal}`);
  const msg = app.db.prepare("insert into lark_messages(message_id,chat_id,content,create_ms) values(?,?,?,?)");
  for (let i = 0; i < N.messages; i++) msg.run(`msg${i}`, `oc_${i % 200}`, i % 10 ? `普通消息 ${i}` : `看这个 https://tenant.larkoffice.com/wiki/PERSONALDOC${String(i % N.personal).padStart(6, "0")}`, i);
});
// The seed went into the WAL in one go; checkpoint it now, or the first commits of the check pay for
// copying it (a second or more on a busy disk), which is the seed's cost and not the check's.
app.db.exec("pragma wal_checkpoint(truncate)");

it("a sweep over a large library keeps every synchronous step short and finishes", async () => {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const t = performance.now();
    maxGap = Math.max(maxGap, t - last);
    last = t;
  }, 5);
  const start = performance.now();
  const report = await sweepHoming(app, { budget: 60 });
  const total = performance.now() - start;
  // A second sweep with nothing new.
  await new Promise((r) => setTimeout(r, 20));
  const again = performance.now();
  await sweepHoming(app, { budget: 60 });
  const second = performance.now() - again;
  await new Promise((r) => setTimeout(r, 20));
  const evStart = performance.now();
  // One archive run: evidence for its batch of 40.
  archiveEvidenceFor(app, Array.from({ length: 40 }, (_, i) => `p${i * 50}`));
  const evidenceMs = performance.now() - evStart;
  await new Promise((r) => setTimeout(r, 20));
  const reachStart = performance.now();
  const reach = await citationReach(app, spaces[0]);
  const reachMs = performance.now() - reachStart;
  const overviewStart = performance.now();
  homingOverview(app);
  const overviewMs = performance.now() - overviewStart;
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(timer);
  console.log(JSON.stringify({ totalMs: Math.round(total), secondMs: Math.round(second), maxGapMs: Math.round(maxGap), reachMs: Math.round(reachMs), evidence40Ms: Math.round(evidenceMs), overviewMs: Math.round(overviewMs), queued: report.queued, left: report.left, found: report.found, reachEntries: reach.entries.length }));
  expect(report.queued).toBe(60);
  expect(report.left).toBeGreaterThan(1000);
  expect(report.links.complete).toBe(true);
  expect(reach.entries.length).toBeGreaterThan(0);
  // Before the fix (2026-11-12): the check was one synchronous block of ~28 s on this data, the
  // evidence for one archive run ~2 s; after: the longest step stays well under these bounds.
  // ~0.1 s on its own; the bound leaves room for a busy machine (the whole suite in parallel).
  expect(maxGap).toBeLessThan(500);
  expect(evidenceMs).toBeLessThan(1000);
  expect(total).toBeLessThan(20_000);
}, 600_000);
