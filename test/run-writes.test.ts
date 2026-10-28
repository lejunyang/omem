import { afterEach, expect, it } from "vitest";
import { runWrites } from "../src/agents/run-writes.ts";
import { addRunEvent, createRun, getRun } from "../src/agents/runs.ts";
import { remember } from "../src/memory/store.ts";
import { writeWorkFile } from "../src/sources/work.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

it("lists what a run wrote, each pointing where it lives", () => {
  const app = testApp();
  apps.push(app);
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "查一下经营信息为什么不展示" });
  writeWorkFile(app, { spaceId: "personal", path: "investigations/demo", title: "经营信息入口排查", text: "# 排查\n结论", runId: r.id });
  addRunEvent(app, r.id, "tool-write", { name: "write_file", args: { path: "investigations/demo", content: "…" } });
  const m = remember(app, { spaceId: "personal", kind: "experience", content: "经营信息不展示先看业务域，见 [[cases/homepage-domain]]", runId: r.id });
  addRunEvent(app, r.id, "tool-write", { name: "remember", args: { content: m.content } });
  addRunEvent(app, r.id, "tool-write", { name: "write_page", args: { page: "cases/homepage-domain", title: "经营信息入口隐藏" } });
  addRunEvent(app, r.id, "tool-write", { name: "lark_react", args: { emoji: "DONE" } });
  addRunEvent(app, r.id, "tool-write", { name: "lark_react", args: { emoji: "OK" } });

  const w = runWrites(app, getRun(app, r.id));
  expect(w.map((x) => [x.tool, x.target?.kind])).toEqual([["write_file", "source"], ["remember", "memory"], ["write_page", "page"], ["lark_react", undefined]]);
  expect(w[0].label).toBe("经营信息入口排查");
  expect(w[2].target).toEqual({ kind: "page", space: "personal", slug: "cases/homepage-domain" });
  expect(w[3].n).toBe(2);
  expect(runWrites(app, getRun(app, createRun(app, { kind: "ask", title: "只查询" }).id))).toEqual([]);
});
