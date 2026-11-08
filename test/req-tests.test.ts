import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactPath, listArtifacts } from "../src/agents/artifacts.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { saveSkill, skillIndex } from "../src/agents/specs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createSpace, updateSpace } from "../src/core/spaces.ts";
import { KEEP_ARTIFACTS, testState, testsOf, testsText } from "../src/items/req-tests.ts";
import { saveReqs } from "../src/items/requirements.ts";
import { writeSpaceGuide } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function setup() {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  const dir = mkdtempSync(join(tmpdir(), "omem-reqtest-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
  createSpace(app, { id: "shop-web", name: "商城前端", kind: "repo", rootPath: dir });
  const r = saveReqs(app, [
    { op: "add", key: "page", kind: "page", title: "退款申请页" },
    { op: "add", key: "amount", parent: "$page", kind: "feature", title: "退款金额只算未发货的行" },
    { op: "add", key: "partial", parent: "$amount", kind: "test", title: "部分发货：只退未发货的两行", tests: [{ file: "refund.case.ts", name: "partial shipment" }] },
  ], { by: "user", label: "本人" }, { canWrite: () => {}, canRead: () => {}, defaultSpace: "shop" });
  const code = createRun(app, { kind: "code", spaceId: "shop", title: "退款", input: { task: "退款", repos: ["shop-web"] } });
  setRunOutput(app, code.id, { worktrees: [{ space: "shop-web", path: dir, branch: "main", base: git("rev-parse", "HEAD").trim() }] });
  const ctx: ToolContext = { app, runId: code.id, spaceId: "shop", spaces: ["shop", "shop-web"], tools: null, actor: "agent", role: "coder" };
  return { app, dir, git, keys: r.keys, code, ctx };
}

describe("test results on requirement points", () => {
  it("records what a coding run ran against its points, with artifacts, the commit, and only known ids", async () => {
    const { app, dir, git, keys, code, ctx } = setup();
    writeFileSync(join(dir, "partial.png"), PNG);
    const bad = await callTool(ctx, "report_tests", { tests: [{ req: "q-none", name: "x", status: "passed" }] });
    expect(bad).toMatchObject({ isError: true });
    expect(JSON.stringify(bad)).toMatch(/需求点 id 不存在/);

    const ok = await callTool(ctx, "report_tests", { tests: [
      { req: keys.partial, name: "partial shipment", file: "refund.case.ts", status: "failed", mode: "浏览器", note: "第 3 步：期望 2 行，实际 3 行", artifacts: ["partial.png"] },
      { name: "lint", status: "passed" },
    ] });
    expect(ok).toMatchObject({ isError: false });
    expect(JSON.stringify(ok)).toMatch(/1 个对上了需求点/);
    const [r] = testsOf(app, [keys.partial]).get(keys.partial)!;
    expect(r).toMatchObject({ status: "failed", mode: "浏览器", runId: code.id, workId: code.id, commit: git("rev-parse", "HEAD").trim() });
    expect(r.artifacts).toHaveLength(1);
    const shots = await listArtifacts(app, code.id);
    expect(shots).toEqual([expect.objectContaining({ id: r.artifacts[0], req: keys.partial, caption: "失败 · partial shipment" })]);
    expect(testState(testsOf(app, [keys.partial]).get(keys.partial)!)).toMatchObject({ status: "failed", failed: 1 });
    // The review reads them, failed first, with the files on this machine.
    const text = testsText(app, testsOf(app, [keys.partial]).get(keys.partial)!, { artifactPath: () => "/tmp/partial.png" });
    expect(text).toMatch(/失败：refund\.case\.ts › partial shipment（浏览器） → .*「部分发货：只退未发货的两行」/);
    expect(text).toMatch(/产物：\/tmp\/partial\.png/);
  });

  it("keeps the artifacts of each test's latest few results and drops older ones", async () => {
    const { app, dir, keys, code, ctx } = setup();
    for (let i = 0; i < KEEP_ARTIFACTS + 2; i++) {
      writeFileSync(join(dir, `shot-${i}.png`), PNG);
      await callTool(ctx, "report_tests", { tests: [{ req: keys.partial, name: "partial shipment", file: "refund.case.ts", status: i === KEEP_ARTIFACTS + 1 ? "passed" : "failed", artifacts: [`shot-${i}.png`] }] });
    }
    const results = testsOf(app, [keys.partial]).get(keys.partial)!;
    expect(results).toHaveLength(KEEP_ARTIFACTS + 2);
    expect(results.filter((r) => r.artifacts.length)).toHaveLength(KEEP_ARTIFACTS);
    expect(results.slice(KEEP_ARTIFACTS).every((r) => r.pruned && !r.artifacts.length)).toBe(true);
    const kept = await listArtifacts(app, code.id);
    expect(kept.map((a) => a.name).sort()).toEqual(["shot-2.png", "shot-3.png", "shot-4.png"]);
    // The latest result decides the point's state.
    expect(testState(results)).toMatchObject({ status: "passed", passed: 1 });
    // All five screenshots had the same bytes: one stored file, linked; dropping the first ones keeps the rest readable.
    for (const a of kept) expect(readFileSync(artifactPath(app, a))).toEqual(PNG);
  });

  it("names an extensionless file by its content and stores the same bytes once", async () => {
    const { app, dir, keys, code, ctx } = setup();
    mkdirSync(join(dir, ".dev-flow", "blobs", "ab"), { recursive: true });
    writeFileSync(join(dir, ".dev-flow", "blobs", "ab", "ab12cd34"), PNG);
    writeFileSync(join(dir, "copy.png"), PNG);
    await callTool(ctx, "report_tests", { tests: [{ req: keys.partial, name: "partial shipment", status: "passed", artifacts: [".dev-flow/blobs/ab/ab12cd34", "copy.png"] }] });
    const [blob, copy] = await listArtifacts(app, code.id);
    expect(blob).toMatchObject({ kind: "image", name: "ab12cd34.png", entry: "ab12cd34.png", mime: "image/png" });
    expect(statSync(artifactPath(app, copy)).ino).toBe(statSync(artifactPath(app, blob)).ino);
  });
});

describe("skills and guides of a space", () => {
  it("offers a space's skills only where they are mounted, and gives a coding run its repository's SPACE.md", () => {
    const { app, code } = setup();
    saveSkill(app, { name: "shop-web-tests", description: "商城前端怎么跑用例、怎么把结果交给 report_tests", body: "照做" });
    saveSkill(app, { name: "general", description: "通用的做法", body: "照做" });
    updateSpace(app, "shop-web", { settings: { skills: ["shop-web-tests"] } });
    writeSpaceGuide(app, "shop-web", "用例写在 *.case.ts，req 写测试点 id。");

    expect(skillIndex(app)).not.toMatch(/shop-web-tests/);
    expect(skillIndex(app)).toMatch(/general/);

    const coding = prepareRun(app, { actor: { role: "coder" }, spaceId: "shop", runId: code.id });
    expect(coding.system).toMatch(/## 仓库 商城前端（shop-web）的说明（SPACE\.md）\n\n用例写在 \*\.case\.ts/);
    expect(coding.system).toMatch(/## 这个空间和仓库的技能[^\n]*\n\n- shop-web-tests：商城前端怎么跑用例.*用于：商城前端/);
    expect(coding.system.match(/shop-web-tests/g)).toHaveLength(2); // the line and its path, not again in the general index

    const elsewhere = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null });
    expect(elsewhere.system).not.toMatch(/shop-web-tests/);
    expect(elsewhere.system).not.toMatch(/仓库 商城前端/);
  });
});
