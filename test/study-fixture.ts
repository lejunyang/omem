import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testApp } from "./helpers.ts";
import { gitAsync } from "../src/core/git.ts";
import { now } from "../src/core/util.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow, type FlowStage } from "../src/flows/definitions.ts";
import { advance, startFlow, reportStage } from "../src/flows/engine.ts";
import { getStage } from "../src/flows/store.ts";
import { getRun, setRunOutput } from "../src/agents/runs.ts";
import { putScope } from "../src/studies/scope.ts";
import { chooseDirection, proposeDirections, reportTrial } from "../src/studies/service.ts";
import { directions, recordFinding, trials } from "../src/studies/store.ts";

export async function git(dir: string, ...args: string[]) {
  const r = await gitAsync(dir, args, { timeoutMs: 15000 });
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
}
export async function studyFixture(budget: FlowStage["budget"] = { fixes: 2, minutes: 240 }, count = 1) {
  const app = testApp(); app.config.flows.autoAdvance = 100;
  const root = join(app.home, "repo"); mkdirSync(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "test"); await git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "entry.txt"), "before"); await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");
  createSpace(app, { id: "project", name: "项目 A" });
  createSpace(app, { id: "repo", name: "仓库 A", kind: "repo", rootPath: root, parentId: "project" });
  const item = upsertItem(app, undefined, { spaceId: "project", kind: "watch", title: "示例课题" }, "user");
  putScope(app, item.id, { allowCode: true }, "owner");
  saveFlow(app, JSON.stringify({ id: "fix-study", name: "课题", repeat: { from: "plan", every: "manual" }, stages: [
    { id: "plan", name: "定方向", by: { run: {} }, tools: ["propose_directions"] },
    { id: "try", name: "试验", by: { object: "trials" }, ai: "cheap" },
    { id: "summary", name: "小结", by: { run: {} }, tools: ["read_ledger", "record_finding"] },
    { id: "fix", name: "改", by: { object: "fixes" }, ai: "standard", budget },
  ] }), "user");
  await startFlow(app, item.id, "fix-study", { actor: "owner", userId: "owner" });
  const stage = (id = "fix") => getStage(app, item.id, id);
  await proposeDirections(app, { item: item.id, directions: [{ goal: "核对退出码", approach: "运行示例", acceptance: "逐项通过", trials: Array.from({ length: count }, (_, i) => ({ object: `对象 ${i}`, check: "检查退出码" })) }] }, { actor: "assistant", userId: "owner", runId: stage("plan").control.runId });
  await chooseDirection(app, item.id, directions(app, item.id)[0].id, undefined, "owner", true);
  const finishTrial = async (result: "passed" | "failed" = "failed", id = "try") => {
    const s = stage(id);
    await reportTrial(app, { trial: s.control.trialId!, result, summary: "运行示例命令，退出码与预期对照" }, { actor: "assistant", userId: "owner", runId: s.control.runId });
    run(app.db, "update runs set status='done',started_at=coalesce(started_at,?),finished_at=? where id=?", now(), now(), s.control.runId!);
    await advance(app, item.id);
  };
  const finding = (n = 0) => recordFinding(app, { item: item.id, kind: "defect", title: `退出码错误 ${n}`, repro: "执行示例，预期失败退出，实际返回 0", trials: [trials(app, item.id)[n].id], distinct_from: [] });
  const beginFix = async () => { const s = stage("summary"); await reportStage(app, item.id, "summary", { state: "done", note: "小结已写", evidence: [s.control.runId!] }, { actor: "assistant", userId: "owner", runId: s.control.runId }); };
  const approve = async () => {
    const work = getRun(app, stage().control.fixWorkId!);
    const cwd = join(app.runsDir, work.id, "work", "repo"); mkdirSync(join(app.runsDir, work.id, "work"), { recursive: true });
    const branch = `fix-${work.id}`;
    await git(root, "worktree", "add", "-qb", branch, cwd);
    writeFileSync(join(cwd, "entry.txt"), "after"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "fix");
    setRunOutput(app, work.id, { worktrees: [{ space: "repo", path: cwd, branch, base: await git(root, "rev-parse", "HEAD") }], verdict: "approved" });
    run(app.db, "update runs set status='done',started_at=?,finished_at=? where id=?", now(), now(), work.id);
    await advance(app, item.id);
    return { work, cwd };
  };
  return { app, item, root, stage, finishTrial, finding, beginFix, approve };
}
