import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../src/agents/runner.ts";
import { callTool, revokeToolToken, toolContextForToken, type ToolContext } from "../src/agents/tools.ts";
import { declineRelation, dependsOn, relationCandidates, packageName } from "../src/core/space-candidates.ts";
import { createSpace, relatedIds, relatedSpaces, relateSpaces, spaceForDir, unrelateSpaces } from "../src/core/spaces.ts";
import { remember } from "../src/memory/store.ts";
import { importText } from "../src/sources/import.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());
createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo" });
createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo" });
createSpace(app, { id: "travel", name: "差旅" });

describe("space relations", () => {
  it("are symmetric; the owner's removal sticks against agents but not against the owner", () => {
    relateSpaces(app, "shop-web", "shop-api", { note: "前端调用订单服务的接口", origin: "agent", evidence: "src:x" });
    expect(relatedIds(app, "shop-api")).toEqual(["shop-web"]);
    expect(relatedSpaces(app, "shop-web")[0]).toMatchObject({ space: "shop-api", note: "前端调用订单服务的接口", origin: "agent" });
    // An agent confirming the owner's relation does not overwrite the owner's note.
    relateSpaces(app, "shop-web", "shop-api", { note: "本人写的说明", origin: "owner" });
    relateSpaces(app, "shop-api", "shop-web", { note: "Agent 的说法", origin: "agent" });
    expect(relatedSpaces(app, "shop-web")[0]).toMatchObject({ note: "本人写的说明", origin: "owner" });
    unrelateSpaces(app, "shop-web", "shop-api", "owner");
    expect(relatedIds(app, "shop-web")).toEqual([]);
    expect(() => relateSpaces(app, "shop-web", "shop-api", { note: "再加", origin: "agent" })).toThrow(/移除过/);
    relateSpaces(app, "shop-web", "shop-api", { note: "前端调用订单服务的接口", origin: "owner" });
    expect(relatedIds(app, "shop-web")).toEqual(["shop-api"]);
    expect(() => relateSpaces(app, "travel", "travel", { origin: "owner" })).toThrow();
  });

  it("let a run limited to one space read its related spaces but write only its own", async () => {
    importText(app, "shop-api", { title: "接口约定", text: "# 订单接口\n创建订单接口 POST /orders 的超时是 3 秒，重试两次。\n" });
    importText(app, "travel", { title: "差旅", text: "差旅订单超时按公司规定处理。\n" });
    const ctx: ToolContext = { app, runId: null, spaceId: "shop-web", spaces: ["shop-web", "shop-api"], writable: ["shop-web"], tools: null, actor: "agent", userId: "owner" };
    // Default search covers the related space and says where a hit lives; unrelated spaces stay out.
    const hits = (await callTool(ctx, "search", { query: "订单接口 超时" })).text;
    expect(hits).toContain("〔空间 shop-api〕");
    expect(hits).not.toContain("travel");
    expect((await callTool(ctx, "search", { query: "订单接口 超时", space: "shop-web" })).text).not.toContain("shop-api");
    // Writes into the related space are refused with a pointer to the current one.
    const refused = await callTool(ctx, "remember", { content: "订单服务创建订单接口超时 3 秒", kind: "fact", space: "shop-api" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/只能读/);
    const theirs = remember(app, { spaceId: "shop-api", kind: "fact", subject: "订单接口", content: "订单服务创建订单接口的超时是 3 秒，重试两次" });
    expect((await callTool(ctx, "supersede", { memory_id: theirs.id, content: "改成 5 秒" })).text).toMatch(/只能读/);
    // Writing a near copy in the current space works, and says the related space has one.
    const ok = await callTool(ctx, "remember", { content: "订单服务创建订单接口的超时是 3 秒，重试两次", kind: "fact", subject: "订单接口" });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain(theirs.id);
    expect((await callTool(ctx, "list_spaces", {})).text).toMatch(/相关：shop-api/);
  });

  it("gives scoped roles the related spaces read-only and tells them about it", () => {
    app.baseUrl = app.baseUrl || "http://127.0.0.1:1";
    const run = prepareRun(app, { actor: { role: "ingest" }, spaceId: "shop-web", runId: null });
    try {
      const ctx = toolContextForToken(app, run.token)!;
      expect(ctx.spaces).toEqual(["shop-web", "shop-api"]);
      expect(ctx.writable).toEqual(["shop-web"]);
      expect(run.system).toContain("## 相关空间");
      expect(run.system).toContain("前端调用订单服务的接口");
      expect(run.system).toContain("代码仓库");
    } finally {
      revokeToolToken(run.token);
    }
    const assistant = prepareRun(app, { actor: { role: "assistant" }, spaceId: "shop-web", runId: null });
    try {
      expect(toolContextForToken(app, assistant.token)!.spaces).toBeNull();
      expect(assistant.system).toContain("## 相关空间");
    } finally {
      revokeToolToken(assistant.token);
    }
  });

  it("finds candidates from citations and manifests, skipping known and rejected pairs", () => {
    createSpace(app, { id: "pay-sdk", name: "支付 SDK", kind: "repo" });
    createSpace(app, { id: "checkout", name: "收银台", kind: "repo" });
    // Manifests only count in spaces linked to a directory.
    const dir = mkdtempSync(join(tmpdir(), "omem-rel-"));
    app.db.prepare("update spaces set root_path = ? where id in ('pay-sdk','checkout')").run(dir);
    upsertSource(app, { spaceId: "pay-sdk", uri: "package.json", kind: "code", title: "package.json", text: '{ "name": "@acme/pay-sdk", "version": "1.0.0" }' });
    upsertSource(app, { spaceId: "checkout", uri: "package.json", kind: "code", title: "package.json", text: '{ "name": "checkout", "dependencies": { "@acme/pay-sdk": "^1.0.0" } }' });
    const doc = importText(app, "travel", { title: "差旅标准", text: "住宿每晚 500 元。\n" });
    remember(app, { spaceId: "personal", kind: "fact", content: "本人出差住宿标准每晚 500 元", sourceRefs: [`src:${doc.id}#L1-L1`] });
    const found = relationCandidates(app);
    const pay = found.find((c) => c.a === "checkout" && c.b === "pay-sdk");
    expect(pay?.signals.join()).toMatch(/依赖 pay-sdk 发布的 @acme\/pay-sdk/);
    expect(found.find((c) => c.a === "personal" && c.b === "travel")?.signals.join()).toMatch(/引用 travel 的原件/);
    expect(found.some((c) => c.a === "shop-api" && c.b === "shop-web")).toBe(false);
    unrelateSpaces(app, "checkout", "pay-sdk", "owner");
    expect(relationCandidates(app).some((c) => c.a === "checkout" && c.b === "pay-sdk")).toBe(false);
    expect(packageName("go.mod", "module example.com/acme/pay\n\ngo 1.22")).toBe("example.com/acme/pay");
    expect(packageName("package.json", '{"name":"app"}')).toBeNull();
  });

  it("matches a dependency as a whole name, skips names several spaces publish, and remembers declined pairs", () => {
    expect(dependsOn("package.json", '{"dependencies":{"@acme/view-kit":"1"},"scripts":{"preview":"vite preview"}}', "view")).toBe(false);
    expect(dependsOn("package.json", '{"devDependencies":{"view":"1"}}', "view")).toBe(true);
    expect(dependsOn("go.mod", "module example.com/a\n\nrequire (\n\texample.com/acme/pay v1.2.0\n\texample.com/acme/payment v1\n)", "example.com/acme/pay")).toBe(true);
    expect(dependsOn("go.mod", "module example.com/a\n\nrequire example.com/acme/payment v1", "example.com/acme/pay")).toBe(false);
    expect(dependsOn("Cargo.toml", '[package]\nname = "app-cli"\n\n[dependencies]\nacme-core = { path = "../core" }', "acme-core")).toBe(true);
    expect(dependsOn("Cargo.toml", '[dependencies]\nacme-core-extra = "1"', "acme-core")).toBe(false);
    expect(dependsOn("pyproject.toml", 'dependencies = ["acme-sdk>=1.2", "requests"]', "acme-sdk")).toBe(true);
    expect(dependsOn("pyproject.toml", 'dependencies = ["acme-sdk-extra"]', "acme-sdk")).toBe(false);
    expect(dependsOn("pom.xml", "<dependencies><dependency><groupId>a</groupId><artifactId>acme-pay</artifactId></dependency></dependencies>", "acme-pay")).toBe(true);
    expect(dependsOn("build.gradle", "implementation 'com.acme:acme-pay:1.0'", "acme-pay")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "omem-dep-"));
    for (const id of ["ui-kit", "admin", "fork-kit", "tools"]) createSpace(app, { id, name: id, kind: "repo", rootPath: dir });
    upsertSource(app, { spaceId: "ui-kit", uri: "package.json", kind: "code", title: "package.json", text: '{ "name": "view" }' });
    upsertSource(app, { spaceId: "admin", uri: "package.json", kind: "code", title: "package.json", text: '{ "name": "admin-site", "scripts": { "preview": "vite preview" } }' });
    expect(relationCandidates(app, Infinity).some((c) => c.a === "admin" && c.b === "ui-kit")).toBe(false);
    // A shared name (two spaces publish @acme/config) says nothing about which one is used.
    upsertSource(app, { spaceId: "fork-kit", uri: "packages/config/package.json", kind: "code", title: "package.json", text: '{ "name": "@acme/config" }' });
    upsertSource(app, { spaceId: "tools", uri: "packages/config/package.json", kind: "code", title: "package.json", text: '{ "name": "@acme/config" }' });
    upsertSource(app, { spaceId: "admin", uri: "web/package.json", kind: "code", title: "package.json", text: '{ "name": "admin-web", "dependencies": { "@acme/config": "1", "view": "1" } }' });
    const found = relationCandidates(app, Infinity);
    expect(found.some((c) => c.a === "admin" && (c.b === "fork-kit" || c.b === "tools"))).toBe(false);
    expect(found.find((c) => c.a === "admin" && c.b === "ui-kit")?.signals.join()).toMatch(/依赖 ui-kit 发布的 view/);

    // Declined: gone until a new kind of evidence turns up (a different count is not new).
    expect(declineRelation(app, "ui-kit", "admin", "只是同名的小组件，没有实际调用")).toEqual(["admin 的 web/package.json 依赖 ui-kit 发布的 view"]);
    expect(relationCandidates(app, Infinity).some((c) => c.a === "admin" && c.b === "ui-kit")).toBe(false);
    const doc = upsertSource(app, { spaceId: "ui-kit", kind: "doc", uri: "guide.md", title: "组件说明", text: "按钮用法" });
    remember(app, { spaceId: "admin", kind: "fact", content: "后台的按钮沿用组件库的写法", sourceRefs: [`src:${doc.id}#L1-L1`] });
    const back = relationCandidates(app, Infinity).find((c) => c.a === "admin" && c.b === "ui-kit");
    expect(back?.signals.join()).toMatch(/1 条记忆引用 ui-kit/);
  });

  it("lets an agent decline a pair through relate_spaces", async () => {
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
    expect((await callTool(ctx, "relate_spaces", { a: "travel", b: "shop-web", decline: true })).text).toMatch(/为什么无关/);
    expect((await callTool(ctx, "relate_spaces", { a: "travel", b: "shop-web", decline: true, note: "只是偶然提到" })).text).toMatch(/已记下 travel 与 shop-web 无关/);
    expect(app.db.prepare("select reason from space_relation_declines where space_a = 'shop-web' and space_b = 'travel'").get()).toMatchObject({ reason: "只是偶然提到" });
  });

  it("picks the innermost linked space for a working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "omem-dir-"));
    createSpace(app, { id: "outer", name: "outer", rootPath: root });
    expect(spaceForDir(app, join(root, "src", "x"))).toBe("outer");
    expect(spaceForDir(app, root + "-other")).toBeNull();
  });
});
