import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";

/** Queries that run on the main thread on every call and once scanned whole tables. */
const plan = (app: ReturnType<typeof testApp>, sql: string, ...params: (string | number)[]) =>
  (app.db.prepare(`explain query plan ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join("\n");

it("counts a page's stale citations through an index, not a scan per page", () => {
  const app = testApp();
  try {
    const detail = plan(app, `select p.slug,
      (select count(distinct c.source_id) from page_cites c join sources s on s.id = c.source_id where c.page_id = p.id and (s.hash != c.hash or s.deleted_at is not null)) stale
     from pages p where p.space_id = ? order by p.slug`, "personal");
    expect(detail).toMatch(/SEARCH c USING INDEX page_cites_page/);
    expect(detail).not.toMatch(/SCAN c\b/);
  } finally { app.db.close(); }
});

it("finds symbols by name and by qualified name through indexes", () => {
  const app = testApp();
  try {
    const sel = "select y.id from symbols y join sources s on s.id = y.source_id where";
    expect(plan(app, `${sel} y.name = ? and y.space_id in (?, ?) and s.deleted_at is null order by y.id limit 20`, "f", "a", "b")).toMatch(/USING INDEX symbols_(any_)?name/);
    expect(plan(app, `${sel} y.qname = ? and y.space_id in (?, ?) and s.deleted_at is null order by y.id limit 20`, "A.f", "a", "b")).toMatch(/USING INDEX symbols_qname/);
    expect(plan(app, `${sel} y.qname = ? and s.deleted_at is null order by y.id limit 20`, "A.f")).toMatch(/USING INDEX symbols_qname/);
    expect(plan(app, `${sel} y.name = ? and s.deleted_at is null order by y.id limit 20`, "f")).toMatch(/USING INDEX symbols_any_name/);
  } finally { app.db.close(); }
});
