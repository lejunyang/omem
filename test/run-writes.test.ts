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
  expect(w[0].action).toBe("新建");
  expect(w[1].action).toBe("新建");
  expect(runWrites(app, getRun(app, createRun(app, { kind: "ask", title: "只查询" }).id))).toEqual([]);
});

it("reads ids and new-or-updated from the tool's answer", async () => {
  const { upsertItem } = await import("../src/items/store.ts");
  const app = testApp();
  apps.push(app);
  const item = upsertItem(app, undefined, { title: "退款接口文档" });
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "更新事项" });
  addRunEvent(app, r.id, "tool-write", { name: "upsert_item", args: { id: item.id, status: "done" }, result: `已更新事项 ${item.id}：[todo/done] 退款接口文档` });
  addRunEvent(app, r.id, "tool-write", { name: "write_page", args: { page: "cases/refund", title: "退款超时" }, result: "已创建页面 personal/cases/refund。引用原件 0 个" });
  const w = runWrites(app, getRun(app, r.id));
  expect(w[0]).toMatchObject({ action: "更新", label: "退款接口文档", target: { kind: "item", id: item.id } });
  expect(w[1]).toMatchObject({ action: "新建", target: { kind: "page", space: "personal", slug: "cases/refund" } });
});

it("finds what an id names, within the spaces the caller may read", async () => {
  const { lookupId } = await import("../src/core/lookup.ts");
  const app = testApp();
  apps.push(app);
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "查一下经营信息" });
  const m = remember(app, { spaceId: "personal", kind: "fact", content: "示例商城的退款走异步回调" });
  expect(lookupId(app, `运行 ${r.id}`)).toMatchObject([{ type: "run", id: r.id, title: "查一下经营信息" }]);
  expect(lookupId(app, `mem:${m.id}`)).toMatchObject([{ type: "memory", id: m.id }]);
  expect(lookupId(app, "no-such-id-123")).toEqual([]);
  expect(lookupId(app, "两个 词")).toEqual([]);
});
