import { describe, expect, it } from "vitest";
import {
  blockTone, compact, decisionText, doneCount, missingText, readProgress, orderTasks, outputHref, outputLabel, runIdsOf, taskHref,
  taskTone, usageText, waitLabel, whoLabel, type ProgressTask, type ProgressView,
} from "../web/src/lib/progress.ts";

const usage = (input = 0, output = 0, runs = 1, missing = 0) => ({ input, output, runs, missing });
const task = (id: string, state: ProgressTask["state"], extra: Partial<ProgressTask> = {}): ProgressTask =>
  ({ id, title: `任务 ${id}`, state, attempts: [], usage: usage(), ...extra });
const view = (kind: ProgressView["kind"], tasks: ProgressTask[], extra: Partial<ProgressView> = {}): ProgressView =>
  ({ kind, id: "r1", title: "核对差异", state: "running", tasks, usage: usage(), runId: "r1", ...extra });

describe("the progress overview (web/src/lib/progress.ts)", () => {
  it("counts what is done, leaving out what was cancelled", () => {
    expect(doneCount(view("board", [task("a", "accepted"), task("b", "running"), task("c", "cancelled")]))).toEqual({ done: 1, total: 2 });
  });

  it("writes token counts short and says which runs reported nothing", () => {
    expect([compact(950), compact(18_400), compact(138_100), compact(2_400_000)]).toEqual(["950", "18.4k", "138k", "2.4M"]);
    expect(usageText(usage(18_400, 2_150, 4, 3))).toBe("输入 18.4k · 输出 2.1k");
    expect(missingText(usage(18_400, 2_150, 4, 3))).toBe("有 3 个没有用量数据");
    expect(missingText(usage(0, 0, 2, 2))).toBe("没有用量数据");
    expect(usageText(usage())).toBe("");
  });

  it("makes only the owner's waits, failures and running work stand out", () => {
    expect(taskTone(task("a", "running", { waitingOn: "等本人确认" }))).toBe("owner");
    expect(taskTone(task("a", "blocked"))).toBe("danger");
    expect(taskTone(task("a", "running"))).toBe("running");
    expect(taskTone(task("a", "submitted", { waitingOn: "等协调助手验收" }))).toBe("quiet");
    expect(blockTone(view("code", [task("T1", "accepted")], { state: "waiting", waitingOn: "等本人确认交付" }))).toBe("owner");
    expect(blockTone(view("board", [task("a", "failed"), task("b", "running")]))).toBe("danger");
    expect(blockTone(view("review", [task("x", "accepted")], { state: "done" }))).toBe("ok");
  });

  it("says what a block waits on: its own wait, a task's, a dependency, the queue", () => {
    expect(waitLabel(view("code", [], { state: "waiting", waitingOn: "等本人确认交付" }))).toBe("等本人确认交付");
    expect(waitLabel(view("flow", [task("push", "running", { waitingOn: "等你" }), task("verify", "pending", { needs: ["push"] })]))).toBe("等你");
    expect(waitLabel(view("code", [task("T1", "running"), task("T2", "pending", { needs: ["T1"] })].slice(1)))).toBe("等 T1");
    expect(waitLabel(view("board", [task("a", "queued"), task("b", "queued")]))).toBe("排队");
    expect(waitLabel(view("review", [task("a", "accepted")], { state: "done", waitingOn: "等本人确认" }))).toBe("");
  });

  it("puts a study's trials under their direction", () => {
    const rows = orderTasks([task("d1", "running"), task("d2", "queued"), task("t1", "running", { parentId: "d1" }), task("t2", "queued", { parentId: "d2" })]);
    expect(rows.map((r) => `${r.task.id}:${r.depth}`)).toEqual(["d1:0", "t1:1", "d2:0", "t2:1"]);
  });

  it("names the model, and the device only when the server says it was not this machine", () => {
    expect(whoLabel(task("a", "running", { who: { model: "openai/gpt-6.2-sol", local: true, device: "home" } }))).toBe("gpt-6.2-sol");
    expect(whoLabel(task("t", "running", { who: { model: "m", local: false, device: "lab-2" } }))).toBe("m · 在 lab-2");
  });

  it("reads the page with its total, and an older server's bare list without one", () => {
    const total = usage(30, 4, 3, 1);
    expect(readProgress({ views: [view("board", [])], totalUsage: total })).toMatchObject({ total, views: [{ kind: "board" }] });
    expect(readProgress([view("code", [])])).toMatchObject({ total: null, views: [{ kind: "code" }] });
    expect(readProgress(null)).toEqual({ views: [], total: null });
  });

  it("reads verdicts and decisions as words, and links each task and output to its page", () => {
    expect(outputLabel({ kind: "report", ref: "rv1", label: "changes_requested · 1 个问题 · 少了两笔" })).toBe("要修改 · 1 个问题 · 少了两笔");
    expect(outputLabel({ kind: "evidence", ref: "design:dsg1", label: "退款方案", target: { kind: "design", id: "dsg1", title: "退款方案" } })).toBe("退款方案");
    expect(outputLabel({ kind: "evidence", ref: "object:o1", label: "", target: { kind: "object", id: "o1", title: "" } })).toBe("外部对象");
    expect(decisionText(task("a", "redo", { decision: { result: "redo" } }))).toBe("退回重做");
    expect(decisionText(task("a", "accepted", { decisions: [{ result: "fix" }, { result: "later" }] }))).toBe("2 条取舍");
    const b = view("board", [], { id: "w1", runId: "w1" });
    expect(taskHref(b, task("a", "running", { href: "#/runs/r9" }))).toBe("/runs/r9");
    expect(taskHref(view("code", [], { runId: "c1" }), task("T2", "running", { href: "#/runs/c1?task=T2" }))).toBe("/runs/c1?task=T2");
    expect(taskHref(view("flow", [], { itemId: "i1" }), task("push", "running"))).toBe("/items/i1/flow");
    expect(outputHref(b, { kind: "report", ref: "r9", label: "交了" })).toBe("/runs/r9");
    expect(outputHref(b, { kind: "commit", ref: "3f2a91c", label: "shop · 3f2a91c" })).toBeNull();
    expect(outputHref(b, { kind: "evidence", ref: "src:s1#L2-L3", label: "退款需求", target: { kind: "source", id: "s1", title: "退款需求" } })).toBe("/sources/s1");
    expect(outputHref(b, { kind: "evidence", ref: "object:o1", label: "合并请求", target: { kind: "object", id: "o1", title: "合并请求" } })).toBeNull();
  });

  it("knows every run the blocks name, for the events that refresh them", () => {
    const b = view("code", [task("T1", "accepted", { attempts: [{ runId: "r2", status: "done", usage: usage() }] })], { rounds: [{ runId: "r3", status: "done" }] });
    expect([...runIdsOf([b])].sort()).toEqual(["r1", "r2", "r3"]);
  });
});
