import { afterAll, describe, expect, it } from "vitest";
import { createRun, getRun, listRuns, countRuns } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { addMaterials, itemMaterials, materialSpaces, materialsBrief, materialViews, removeMaterials } from "../src/items/materials.ts";
import { itemEvents, upsertItem } from "../src/items/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());
createSpace(app, { id: "docs", name: "需求文档", kind: "project" });
createSpace(app, { id: "secret", name: "别人的空间", kind: "project" });
const prd = upsertSource(app, { spaceId: "docs", kind: "doc", uri: "prd.md", title: "退款需求文档", text: "第一版\n" });
const hidden = upsertSource(app, { spaceId: "secret", kind: "doc", uri: "x.md", title: "看不到", text: "x\n" });

describe("item materials", () => {
  it("adds documents and spaces once, notes when an original changed, and gives reviews the spaces to read", () => {
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "退款改造需求" }, "user");
    addMaterials(app, item.id, [{ kind: "source", ref: `src:${prd.id}#L1-L1` }, { kind: "space", ref: "docs", note: "迁移的源实现" }], "owner", "user");
    // The same original again only updates it.
    addMaterials(app, item.id, [{ kind: "source", ref: prd.id, note: "以这份为准" }], "owner");
    const list = itemMaterials(app, item.id);
    expect(list).toHaveLength(2);
    expect(list.find((m) => m.kind === "source")!.meta.note).toBe("以这份为准");
    expect(materialSpaces(app, item.id, "owner")).toEqual(["docs"]);
    expect(materialsBrief(app, item.id, "owner")).toContain(`src:${prd.id}`);

    upsertSource(app, { spaceId: "docs", kind: "doc", uri: "prd.md", title: "退款需求文档", text: "第二版\n" });
    expect(materialViews(app, item.id, "owner").find((m) => m.kind === "source")!.changed).toBe(true);
    expect(materialsBrief(app, item.id, "owner")).toContain("加入后有更新");

    expect(removeMaterials(app, item.id, [`space:docs`], "owner", "user")).toBe(1);
    expect(itemMaterials(app, item.id).map((m) => m.kind)).toEqual(["source"]);
    expect(itemEvents(app, item.id).map((e) => e.text).join("\n")).toMatch(/加入材料[\s\S]*移除材料/);
  });

  it("only takes what the user may see", () => {
    createUser(app, { id: "u2", name: "小王" });
    addMember(app, "docs", "u2");
    const item = upsertItem(app, undefined, { spaceId: "docs", title: "小王的事", userId: "u2" }, "user");
    expect(() => addMaterials(app, item.id, [{ kind: "source", ref: hidden.id }], "u2")).toThrow(/不能访问/);
    expect(() => addMaterials(app, item.id, [{ kind: "source", ref: prd.id }], "owner")).toThrow(/他人/);
    expect(addMaterials(app, item.id, [{ kind: "source", ref: prd.id }], "u2")).toHaveLength(1);
  });

  it("upsert_item adds materials without touching the item, and read_item lists them", async () => {
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "只加材料" }, "user");
    const before = itemEvents(app, item.id).length;
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" };
    const res = await callTool(ctx, "upsert_item", { id: item.id, materials_add: [{ kind: "source", ref: `src:${prd.id}`, note: "需求" }] });
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/加入 #\d+ 退款需求文档/);
    // One timeline entry for the materials, none for unchanged fields.
    expect(itemEvents(app, item.id)).toHaveLength(before + 1);
    const read = JSON.parse((await callTool(ctx, "read_item", { item_id: item.id })).text) as { materials: { ref: string; note: string }[] };
    expect(read.materials).toEqual([expect.objectContaining({ ref: `src:${prd.id}`, note: "需求" })]);
  });
});

describe("finding runs", () => {
  it("filters by keyword and by the built-in roles a run used, and leaves input and output out of brief lists", () => {
    const a = createRun(app, { kind: "code", spaceId: "personal", title: "评审分支 feature/refund-split", input: { task: "对照源仓库的退款卡片" } });
    const b = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理新材料" });
    run(app.db, "update runs set roles = '|coder|review-style|' where id = ?", a.id);
    expect(listRuns(app, { q: "refund-split" }).map((r) => r.id)).toEqual([a.id]);
    expect(listRuns(app, { q: "退款卡片" }).map((r) => r.id)).toEqual([a.id]);
    expect(listRuns(app, { q: b.id }).map((r) => r.id)).toEqual([b.id]);
    expect(listRuns(app, { q: "100%" })).toEqual([]);
    expect(listRuns(app, { kind: "role:review-style" }).map((r) => r.id)).toEqual([a.id]);
    expect(countRuns(app, { kind: "role:review-style,ingest" })).toBe(2);
    expect(listRuns(app, { q: "refund-split", brief: true })[0].input).toEqual({});
    expect(getRun(app, a.id).input).toMatchObject({ task: "对照源仓库的退款卡片" });
  });
});
