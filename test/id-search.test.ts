import { expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { idQuery } from "../src/core/id-query.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it("recognizes bare ids across types and keeps copied labels and routes compatible", () => {
  for (const id of ["r0123456789abcdef0123", "s0123456789abcdef0123", "m0123456789abcdef0123", "ci0123456789abcdef0123"]) {
    expect(idQuery(id)).toBe(id);
    expect(idQuery(`id ${id} · codex · gpt-x · low · 12 秒`)).toBe(id);
  }
  expect(idQuery("运行 r123456789")).toBe("r123456789");
  expect(idQuery("#/runs/r123456789")).toBe("r123456789");
  expect(idQuery("src:s123456789#L2-L4")).toBe("s123456789");
  for (const text of ["退款 123456", "怎么查运行", "abcdef", "123456", ""]) expect(idQuery(text)).toBeNull();
});

it("looks up a brief run by primary key with the list's filters, then searches its references", async () => {
  const app = testApp();
  const target = createRun(app, { kind: "ask", spaceId: "personal", title: "原始问答" });
  const reference = createRun(app, { kind: "code", spaceId: "personal", title: "相关交办", input: { task: `接着 ${target.id} 做` } });
  run(app.db, "update runs set status = 'done' where id = ?", target.id);
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const exact = await server.inject({ url: `/api/runs?id=${target.id}&brief=1` });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ total: 1, runs: [{ id: target.id, output: {} }] });
    for (const filter of ["space=other", "kind=code", "status=running"]) {
      const filtered = await server.inject({ url: `/api/runs?id=${target.id}&${filter}&brief=1` });
      expect(filtered.json()).toMatchObject({ total: 0, runs: [] });
    }
    const related = await server.inject({ url: `/api/runs?q=${target.id}&brief=1` });
    expect(related.json().runs.map((r: { id: string }) => r.id).sort()).toEqual([target.id, reference.id].sort());
    const missing = await server.inject({ url: "/api/runs?id=r_missing123&brief=1" });
    expect(missing.json()).toMatchObject({ total: 0, runs: [] });
    const plan = app.db.prepare("explain query plan select id from runs where id = ? and quiet = 0").all(target.id) as { detail: string }[];
    expect(plan.some((row) => /SEARCH runs USING INDEX .*\(id=\?\)/.test(row.detail))).toBe(true);
  } finally {
    await server.close();
    app.db.close();
  }
});
