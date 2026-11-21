import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  carrierOf, carrierOptions, doneOf, doneOptions, evidenceTarget, gateStages, gatesFor, landing, orphanChecks, parseParams, putCheck,
  readStages, runnerOf, setParam, signalState, simpleFields, writeCarrier, writeDone,
} from "../web/src/lib/flow-hooks.ts";

const raw = `# 本机检查
id: local-check
name: 本机检查
stages:
  - id: mark
    name: 等待标记
    by: wait
  # 第二段由插件做
  - id: write
    name: 写检查文件
    by: { run: {} }
    budget: { minutes: 5 }
`;

describe("plugin hooks in a flow definition (web/src/lib/flow-hooks.ts)", () => {
  it("writes a plugin signal with its parameters into one stage and keeps the comments", () => {
    const [mark] = readStages(raw);
    const next = writeDone(raw, mark, { kind: "signal", id: "stagekit:mark", with: { file: "ready.txt" } });
    expect(next).toContain("# 第二段由插件做");
    expect(next).toContain("done: { signal: stagekit:mark, with: { file: ready.txt } }");
    expect(doneOf(readStages(next)[0])).toEqual({ kind: "signal", id: "stagekit:mark", with: { file: "ready.txt" } });
    expect(writeDone(next, readStages(next)[0], { kind: "default" })).not.toContain("done:");
  });
  it("makes a stage a plugin's job with a time limit, and drops a signal where it is not allowed", () => {
    const write = readStages(raw)[1];
    const next = writeCarrier(raw, write, { kind: "runner", id: "stagekit:write", with: { verified: false } }, 1);
    const stage = (YAML.parse(next) as { stages: { by: unknown; budget: unknown }[] }).stages[1];
    expect(stage).toMatchObject({ by: { runner: "stagekit:write", with: { verified: false } }, budget: { minutes: 1 } });
    expect(carrierOf(readStages(next)[1])).toEqual({ kind: "runner", id: "stagekit:write", with: { verified: false } });
    const signalled = writeDone(raw, readStages(raw)[0], { kind: "signal", id: "git.pushed", with: {} });
    const moved = writeCarrier(signalled, readStages(signalled)[0], { kind: "runner", id: "stagekit:write", with: {} });
    expect(readStages(moved)[0]).not.toHaveProperty("done");
    // Back to you: the time limit goes, the rest stays.
    const back = writeCarrier(next, readStages(next)[1], { kind: "owner" });
    expect(readStages(back)[1]).toMatchObject({ by: "owner" });
    expect(readStages(back)[1]).not.toHaveProperty("budget");
  });
  it("leaves the text alone for what it cannot write", () => {
    expect(writeCarrier(raw, readStages(raw)[1], { kind: "other" })).toBe(raw);
    expect(writeDone("stages: [", { id: "x" }, { kind: "confirm" })).toBe("stages: [");
    expect(readStages("stages: [")).toEqual([]);
  });
  it("lists choices by where they come from and keeps a saved one no plugin offers", () => {
    const signals = [{ id: "stagekit:mark", name: "文件标记", describe: "文件里的标记是 ready 就算完成" }];
    const opts = doneOptions(signals, { kind: "signal", id: "gone:ping", with: {} }, true, { stagekit: "本机阶段示例" });
    expect(opts.find((o) => o.value === "signal:stagekit:mark")).toMatchObject({ group: "插件 · 本机阶段示例" });
    expect(opts.find((o) => o.value === "signal:gone:ping")?.label).toContain("停用了");
    expect(doneOptions(signals, { kind: "default" }, false).some((o) => o.value.startsWith("signal:"))).toBe(false);
    expect(carrierOptions([], { kind: "runner", id: "stagekit:write", with: {} }).at(-1)?.label).toContain("停用了");
    expect(carrierOptions([], { kind: "other" })[0].value).toBe("other");
  });
  it("turns a flat schema into form rows and anything else into a JSON box", () => {
    const fields = simpleFields({ type: "object", properties: { file: { type: "string", pattern: "^[a-z]+\\.txt$" }, verified: { type: "boolean" }, mode: { enum: ["fast", "full"] } }, required: ["file"] })!;
    expect(fields.map((f) => [f.key, f.type, f.required])).toEqual([["file", "string", true], ["verified", "boolean", false], ["mode", "enum", false]]);
    expect(simpleFields({ type: "object", properties: { list: { type: "array" } } })).toBeNull();
    expect(simpleFields(undefined)).toEqual([]);
    expect(setParam({ verified: true }, fields[1], false)).toEqual({});
    expect(setParam({}, fields[0], " a.txt ")).toEqual({ file: "a.txt" });
    expect(parseParams("[1]")).toMatchObject({ ok: false });
    expect(parseParams('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it("saves checks as a whole list and scopes them by what the plugin declared", () => {
    const gates = [{ id: "stagekit:word", name: "结果验收词", describe: "", applies: { stages: ["write"] } }, { id: "other:only", name: "别处", describe: "", applies: { flows: ["delivery"] } }];
    expect(gatesFor(gates, "local-check").map((g) => g.id)).toEqual(["stagekit:word"]);
    expect(gateStages(gates[0], [{ id: "mark", name: "等待标记" }, { id: "write", name: "写检查文件" }]).map((s) => s.id)).toEqual(["write"]);
    const on = putCheck([], "stagekit:word", { stages: [], mandatory: true });
    expect(on).toEqual([{ id: "stagekit:word", mandatory: true }]);
    expect(putCheck(on, "stagekit:word", null)).toEqual([]);
    expect(orphanChecks([{ id: "gone:x" }, { id: "stagekit:word" }], gates)).toEqual([{ id: "gone:x" }]);
  });
  it("says a failing or ownerless signal apart from waiting, and where evidence opens", () => {
    expect(signalState({ type: "stagekit:mark", checkedAt: null, note: "等文件标记 ready", available: true, failures: 0 }, "文件标记").head).toBe("在等 文件标记");
    expect(signalState({ type: "stagekit:mark", checkedAt: null, note: "问不到：超时", failures: 2 }).tone).toBe("failing");
    expect(signalState({ type: "stagekit:mark", checkedAt: null, note: "", available: false }).tone).toBe("gone");
    expect(evidenceTarget("src:s0abc#L2-L4")).toEqual({ kind: "cite", ref: "src:s0abc#L2-L4" });
    expect(evidenceTarget("#/runs/r1")).toEqual({ kind: "route", path: "/runs/r1" });
    expect(evidenceTarget("https://example.org/a")).toMatchObject({ kind: "external" });
    expect(evidenceTarget("javascript:alert(1)")).toBeNull();
    expect(runnerOf("这个阶段会由插件 stagekit:write 执行：写检查文件")).toEqual({ id: "stagekit:write", describe: "写检查文件" });
    expect(runnerOf("助手来做")).toBeNull();
  });
  it("reads where the progress view lands and ignores the rest", () => {
    expect(landing({ task: "T3" })).toEqual({ kind: "task", seq: 3 });
    expect(landing({ stage: "write" })).toEqual({ kind: "stage", id: "write" });
    expect(landing({ task: "x" })).toBeNull();
    expect(landing({ tab: "flow" })).toBeNull();
  });
});
