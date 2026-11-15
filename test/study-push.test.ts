import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, run } from "../src/core/db.ts";
import { createApiToken, createUser, addMember } from "../src/core/users.ts";
import { getRun, __testHandlers } from "../src/agents/runs.ts";
import * as runner from "../src/agents/runner.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { expandTools } from "../src/agents/tool-help.ts";
import { ownerAction, stopFlow } from "../src/flows/engine.ts";
import { studyPush, studyPushSchema } from "../src/studies/push.ts";
import { putScope, studyScope } from "../src/studies/scope.ts";
import { studyView } from "../src/studies/service.ts";
import { startServer } from "../src/server/http.ts";
import { studyFixture, git } from "./study-fixture.ts";

const fixtures: Awaited<ReturnType<typeof studyFixture>>[] = [];
async function setup() {
  const f = await studyFixture(); fixtures.push(f);
  const remote = join(f.app.home, "remote.git"); mkdirSync(remote); await git(remote, "init", "--bare", "-q");
  await git(f.root, "remote", "add", "origin", remote);
  const s = f.stage("try"), r = getRun(f.app, s.control.runId!), cwd = String(r.input.cwd);
  const push = (name = "sample") => studyPush(f.app, { trial: s.control.trialId!, name, note: "核对登记流水线" }, r.id, "owner");
  const authorize = () => putScope(f.app, f.item.id, { pushRemote: "origin", pushPrefix: "study/" }, "owner");
  return { ...f, remote, r, cwd, trial: s.control.trialId!, push, authorize };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { f.app.events.emit("close"); await stopFlow(f.app, f.item.id); await new Promise((r) => setImmediate(r)); f.app.db.close(); rmSync(f.app.home, { recursive: true, force: true }); }
});
describe("课题登记范围内推送", () => {
  it("工具只临时给已授权的试验和重跑，默认 group 不授出", async () => {
    const f = await setup(); expect(expandTools(["group:study"])).not.toContain("study_push");
    const observed: string[][] = [];
    vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      observed.push(input.addTools ?? []);
      return { text: "假后端", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    const invoke = async (r = f.r) => __testHandlers.get(r.kind)!({ app: f.app, run: r, signal: new AbortController().signal, event() {}, output() {} });
    await invoke(); expect(observed.at(-1)).not.toContain("study_push");
    await expect(f.push()).rejects.toThrow("没有登记"); f.authorize(); await invoke(); expect(observed.at(-1)).toContain("study_push");
    await f.finishTrial(); await invoke(getRun(f.app, f.stage("summary").control.runId!)); expect(observed.at(-1)).not.toContain("study_push");
    f.finding(); await f.beginFix(); await f.approve(); await invoke(getRun(f.app, f.stage().control.runId!)); expect(observed.at(-1)).toContain("study_push");
    const rerun = getRun(f.app, f.stage().control.runId!);
    expect(await studyPush(f.app, { trial: f.stage().control.trialId!, name: "rerun", note: "核对改动" }, rerun.id, "owner")).toContain(`study/${f.item.id}/rerun`);
    putScope(f.app, f.item.id, { pushPrefix: "" }, "owner"); await invoke(getRun(f.app, f.stage().control.runId!)); expect(observed.at(-1)).not.toContain("study_push");
    await ownerAction(f.app, f.item.id, "fix", "skip", "本轮先停", "owner"); expect(f.stage().note).toContain(`study/${f.item.id}/rerun`);
  });
  it("只能推固定远端和前缀，成功有审计与视图，原仓库和别的分支保持原样", async () => {
    const f = await setup(); f.authorize();
    const original = await git(f.root, "rev-parse", "HEAD"), branch = `study/${f.item.id}/sample`;
    await git(f.root, "branch", "unrelated"); await git(f.root, "push", "origin", "main", "unrelated");
    writeFileSync(join(f.cwd, "entry.txt"), "checkpoint"); await git(f.cwd, "add", "."); await git(f.cwd, "commit", "-qm", "trial checkpoint");
    const head = await git(f.cwd, "rev-parse", "HEAD"); expect(await f.push()).toContain(head);
    expect(await git(f.remote, "rev-parse", `refs/heads/${branch}`)).toBe(head);
    expect(studyView(f.app, f.item.id).pushes).toMatchObject([{ trialId: f.trial, repo: "repo", remote: "origin", branch, commit: head, note: "核对登记流水线" }]);
    expect(JSON.parse(all<{ detail: string }>(f.app.db, "select detail from audit_events where action='study.push'")[0].detail)).toMatchObject({ success: true, trial: f.trial, repo: "repo", remote: "origin", branch, commit: head, run: f.r.id });
    expect(await git(f.root, "rev-parse", "HEAD")).toBe(original); expect(readFileSync(join(f.root, "entry.txt"), "utf8")).toBe("before");
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(original); expect(await git(f.remote, "rev-parse", "refs/heads/unrelated")).toBe(original);
    expect(await git(f.root, "status", "--porcelain")).toBe("");
    await f.finishTrial(); await f.beginFix(); expect(f.stage("summary").note).toContain(branch); expect(f.stage().note).toContain(branch);
  });
  it("未提交、非快进和远端错误均拒绝并审计，工作区 HEAD 不被改变", async () => {
    const f = await setup(); f.authorize();
    writeFileSync(join(f.cwd, "dirty.txt"), "untracked"); await expect(f.push()).rejects.toThrow("未提交"); rmSync(join(f.cwd, "dirty.txt"));
    await f.push(); const base = await git(f.cwd, "rev-parse", "HEAD");
    writeFileSync(join(f.cwd, "entry.txt"), "remote version"); await git(f.cwd, "add", "."); await git(f.cwd, "commit", "-qm", "remote checkpoint"); await f.push();
    await git(f.cwd, "checkout", "--detach", base);
    writeFileSync(join(f.cwd, "entry.txt"), "diverged version"); await git(f.cwd, "add", "."); await git(f.cwd, "commit", "-qm", "diverged");
    const head = await git(f.cwd, "rev-parse", "HEAD"); await expect(f.push()).rejects.toThrow(/rejected|fast-forward/);
    await git(f.root, "remote", "remove", "origin"); await expect(f.push()).rejects.toThrow("远端");
    const audit = all<{ detail: string }>(f.app.db, "select detail from audit_events where action='study.push'").map((r) => JSON.parse(r.detail));
    expect(audit.filter((r) => !r.success)).toHaveLength(3); expect(audit.filter((r) => r.success)).toHaveLength(2);
    expect(await git(f.cwd, "rev-parse", "HEAD")).toBe(head); expect(studyView(f.app, f.item.id).pushes).toHaveLength(2);
  });
  it("拒绝非法前缀、远端和名字；范围默认空，部分填写没有授权", async () => {
    const f = await setup(); expect(studyScope(f.app, f.item.id)).toMatchObject({ pushRemote: "", pushPrefix: "" });
    for (const pushPrefix of ["study", "../", "a b/", "a:b/", "a//", "/", "a@{/", "a\\b/"]) expect(() => putScope(f.app, f.item.id, { pushPrefix }, "owner")).toThrow();
    for (const pushRemote of ["missing", "--all", "a b", "origin:main", "../origin"]) expect(() => putScope(f.app, f.item.id, { pushRemote }, "owner")).toThrow();
    putScope(f.app, f.item.id, { pushRemote: "origin" }, "owner"); await expect(f.push()).rejects.toThrow("没有登记");
    for (const name of ["", "UPPER", "../main", "a b", "origin:main", "a/b", "a".repeat(41)]) expect(studyPushSchema.safeParse({ trial: f.trial, name, note: "测试" }).success).toBe(false);
    expect(() => putScope(f.app, f.item.id, { pushPrefix: "study/" }, "stranger")).toThrow("只有事项本人");
  });
  it("校验自己的运行、工作区和范围；工具不接受完整分支或远端", async () => {
    const f = await setup(); f.authorize();
    const args = { trial: f.trial, name: "sample", note: "测试" };
    await expect(studyPush(f.app, args, null, "owner")).rejects.toThrow("自己的试验");
    await expect(studyPush(f.app, args, f.r.id, "stranger")).rejects.toThrow("自己的试验");
    const ctx: ToolContext = { app: f.app, actor: "agent", role: "assistant", userId: "owner", runId: f.r.id, spaceId: "project", spaces: ["project", "repo"], tools: new Set(["study_push"]) };
    expect((await callTool(ctx, "study_push", { ...args, remote: "other", branch: "main" })).isError).toBe(true);
    run(f.app.db, "update runs set input=? where id=?", JSON.stringify({ ...f.r.input, cwd: f.root }), f.r.id); await expect(f.push()).rejects.toThrow("试验工作区");
    run(f.app.db, "update runs set input=? where id=?", JSON.stringify(f.r.input), f.r.id);
    putScope(f.app, f.item.id, { repos: [], pushRemote: "", pushPrefix: "" }, "owner"); await expect(f.push()).rejects.toThrow("没有登记");
  });
  it("HTTP 返回新范围字段，只有事项本人能改", async () => {
    const f = await setup(), server = await startServer(f.app, { port: 0, quiet: true });
    try {
      const url = `/api/items/${f.item.id}/study/scope`;
      expect((await server.inject({ method: "PUT", url, payload: { pushRemote: "origin", pushPrefix: "study/" } })).json()).toMatchObject({ pushRemote: "origin", pushPrefix: "study/" });
      const member = createUser(f.app, { name: "成员甲" }); addMember(f.app, "project", member.id, "editor"); const token = createApiToken(f.app, member.id);
      expect((await server.inject({ method: "PUT", url, payload: { pushPrefix: "other/" }, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
      expect((await server.inject({ url })).json()).toMatchObject({ pushRemote: "origin", pushPrefix: "study/" });
    } finally { await server.close(); }
  });
});
