import { describe, expect, it } from "vitest";
import * as host from "../src/designs/types.ts";
import { changeLine, concernTally, countLine, DECISION_FIELDS, hasChange, KIND_LABELS, LEVEL_LABELS, ORIGIN_LABELS } from "../web/src/lib/designs.ts";

describe("web/src/lib/designs", () => {
  it("keeps the kinds, their fields and the labels in step with src/designs/types.ts", () => {
    for (const kind of host.DECISION_KINDS) expect(DECISION_FIELDS[kind]).toEqual(host.DECISION_FIELDS[kind].map((f) => ({ key: f.key, label: f.label })));
    expect(KIND_LABELS).toEqual(host.KIND_LABELS);
    expect(LEVEL_LABELS).toEqual(host.LEVEL_LABELS);
    expect(ORIGIN_LABELS).toEqual(host.ORIGIN_LABELS);
  });

  it("says the counts in one line, only the levels with open concerns", () => {
    expect(countLine({ decisions: 3, questions: 1, concerns: { problem: 0, risk: 0, improve: 0, question: 0 } })).toBe("3 个决定，1 个要你定");
    expect(countLine({ decisions: 4, questions: 0, concerns: { problem: 1, risk: 2, improve: 0, question: 3 } })).toBe("4 个决定 · 问题 1 风险 2 要问 3");
  });

  it("tallies a decision's open concerns by level", () => {
    const t = concernTally({ concerns: [
      { id: "C1", level: "problem", text: "a", state: "open" },
      { id: "C2", level: "problem", text: "b", state: "resolved" },
      { id: "C3", level: "question", text: "c", state: "open" },
    ] });
    expect(t.map((x) => `${x.label} ${x.n}`)).toEqual(["问题 1", "要问 1"]);
  });

  it("describes where a decision landed", () => {
    const c = { decision: "D1", tasks: [{ seq: 1, title: "x", state: "done" }, { seq: 2, title: "y", state: "done" }], commits: 3, files: [{ space: "shop", path: "a.js", add: 100, del: 30 }, { space: "shop", path: "b.js", add: 20, del: 10 }], findings: { open: 0, total: 0 } };
    expect(changeLine(c)).toBe("T1 T2 · 3 次提交 · 2 个文件 +120 −40");
    expect(changeLine({ ...c, tasks: [], commits: 0, files: [{ space: "shop", path: "a.js", add: 0, del: 0 }] })).toBe("1 个文件");
    expect(hasChange({ decision: "D2", tasks: [], commits: 0, files: [], findings: { open: 0, total: 0 } })).toBe(false);
    expect(hasChange(undefined)).toBe(false);
  });
});
