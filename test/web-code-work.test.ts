import { describe, expect, it } from "vitest";
import { artifactClass, classCounts, splitArtifacts } from "../web/src/lib/artifacts.ts";
import { fileGroups, reqPoints } from "../web/src/lib/designs.ts";
import { roundSegments, spanText, taskList } from "../web/src/lib/round-phases.ts";

describe("the coding work page (web/src/lib)", () => {
  it("tells artifacts worth opening from logs, scripts and data by kind and extension", () => {
    const a = (kind: "image" | "video" | "html" | "site" | "text" | "file", name: string) => ({ kind, name });
    expect(artifactClass(a("image", "T3/退款页-修改后.png"))).toBe("shot");
    expect(artifactClass(a("video", "下单到退款.webm"))).toBe("video");
    expect(artifactClass(a("site", "coverage/index.html"))).toBe("report");
    expect(artifactClass(a("text", "复验说明.md"))).toBe("report");
    expect(artifactClass(a("file", "results.junit.xml"))).toBe("test");
    expect(artifactClass(a("file", "run.trx"))).toBe("test");
    for (const name of ["构建.log", "接口回放.ndjson", "验收脚本.mjs", "exit.exit", "导出.json", "说明.txt", "Makefile"]) expect(artifactClass(a(name.endsWith(".log") || name.endsWith(".txt") || name.endsWith(".json") ? "text" : "file", name))).toBe("other");
    const list = [a("text", "a.log"), a("text", "报告.md"), a("image", "b.png"), a("file", "c.mjs"), a("image", "d.png")];
    const split = splitArtifacts(list);
    expect(split.worth.map((x) => x.name)).toEqual(["b.png", "d.png", "报告.md"]);
    expect(split.other.map((x) => x.name)).toEqual(["a.log", "c.mjs"]);
    expect(classCounts(list)).toBe("截图 2 · 报告 1");
  });

  it("names requirement points by their own titles, never by a bare id, and only counts the untouched ones", () => {
    const body = { decisions: [{ reqs: ["q0mvv50jyh711f6bc1cc"] }, { reqs: ["q0mvv50jyh711f6bc1cc", "q0mvv50jyk4bea5dca1d"] }, { reqs: ["退款按行计算这一句"] }] } as never;
    const reqs = [{ id: "q0mvv50jyg9bbf50f805", title: "售后改造", kind: "module" }, { id: "q0mvv72fyqa19f7d9151", title: "售后改造", kind: "module" }];
    // The page knows one of the two points the decisions name.
    const { list, idle } = reqPoints({ reqs, reqNodes: [{ id: "q0mvv50jyh711f6bc1cc", title: "只退已发货的行", kind: "feature", parentTitle: "售后改造" }], body });
    expect(list.map((r) => [r.title, r.n])).toEqual([["只退已发货的行", 2], ["售后改造 · 需求点 1", 1], ["退款按行计算这一句", 1]]);
    expect(list.find((r) => r.title === "退款按行计算这一句")!.link).toBeNull();
    expect(idle).toBe(2);
    expect(list.some((r) => /q0m/.test(r.title))).toBe(false);
    // The same title twice: the requirement above each tells them apart, else a number.
    const twice = reqPoints({ reqs: [], reqNodes: [{ id: "q0aaaaaaaaa0000000001", title: "导出", kind: "feature", parentTitle: "订单" }, { id: "q0aaaaaaaab0000000002", title: "导出", kind: "feature", parentTitle: "退款" }], body: { decisions: [{ reqs: ["q0aaaaaaaaa0000000001"] }, { reqs: ["q0aaaaaaaab0000000002"] }] } as never });
    expect(twice.list.map((r) => r.title)).toEqual(["订单 · 导出", "退款 · 导出"]);
    const same = reqPoints({ reqs: [], reqNodes: [{ id: "q0aaaaaaaaa0000000001", title: "导出", kind: "feature", parentTitle: null }, { id: "q0aaaaaaaab0000000002", title: "导出", kind: "feature", parentTitle: null }], body: { decisions: [{ reqs: ["q0aaaaaaaaa0000000001"] }, { reqs: ["q0aaaaaaaab0000000002"] }] } as never });
    expect(same.list.map((r) => r.title)).toEqual(["导出（1）", "导出（2）"]);
  });

  it("groups changes outside the design by directory, with images, data and logs in one group", () => {
    const f = (path: string, add = 1, del = 0) => ({ space: "shop", path, add, del });
    const { groups, other } = fileGroups([f("src/refund/a.ts", 3, 1), f("src/refund/b.ts"), f("src/order/c.ts"), f("README.md"), f("docs/img/shot.png", 0), f("exports/t1.ndjson", 7), f("run.log")]);
    expect(groups.map((g) => [g.dir, g.files.length, g.add])).toEqual([["src/refund", 2, 4], ["", 1, 1], ["src/order", 1, 1]]);
    expect(other?.files.map((x) => x.path)).toEqual(["docs/img/shot.png", "exports/t1.ndjson", "run.log"]);
  });

  it("splits a round into coding, the host's check and the stage review, with mid-round verification inside coding", () => {
    let seq = 0;
    const e = (type: string, data: Record<string, unknown>, min: number) => ({ seq: ++seq, at: new Date(Date.UTC(2026, 10, 25, 11, min)).toISOString(), type, data });
    const events = [
      e("prompt", { phase: "coder" }, 0),
      e("tool", { phase: "coder", id: "a", title: "edit" }, 1),
      e("tool", { phase: "coder", id: "a", status: "completed" }, 2),
      e("status", { text: "规范验证 T11（编码 Agent 接着做别的项）" }, 3),
      e("tool", { phase: "reviewer", check: "review-style", verify: true, id: "v", title: "read" }, 4),
      e("tool", { phase: "coder", id: "b", title: "test" }, 10),
      e("status", { text: "运行检查：npm test" }, 20),
      e("check", { command: "npm test", code: 0, ms: 4000, output: "ok" }, 30),
      e("status", { text: "检查点 9：完成 T12、T15" }, 30),
      e("status", { text: "评审负责人决定这次评审看什么" }, 31),
      e("session", { phase: "lead" }, 31),
      e("status", { phase: "reviewer", check: "review-business", text: "开始评审：业务" }, 33),
      e("tool", { phase: "reviewer", check: "review-business", id: "r", title: "read" }, 34),
      e("usage", { input: 10 }, 35),
    ];
    const segs = roundSegments(events);
    expect(segs.map((s) => s.kind)).toEqual(["coding", "checking", "review"]);
    expect(segs[0]).toMatchObject({ steps: 3, tasks: [11], sessions: ["coder", "verify:review-style"] });
    expect(segs[1]).toMatchObject({ tasks: [12, 15], checks: [{ command: "npm test", code: 0, ms: 4000 }] });
    expect(segs[2]).toMatchObject({ sessions: ["lead", "check:review-business"], steps: 1 });
    // Review feedback back to the coder within the round opens another coding stretch.
    const more = roundSegments([...events, e("status", { phase: "coder", text: "把评审的反馈交给编码 Agent，在这一轮接着改" }, 40)]);
    expect(more.map((s) => s.kind)).toEqual(["coding", "checking", "review", "coding"]);
    expect(spanText(segs[0].from, segs[0].to, (iso) => iso.slice(11, 16))).toBe("11:00–11:10 · 10 分钟");
    expect(taskList([1, 2, 3, 4, 5, 6, 7, 8])).toBe("T1、T2、T3、T4、T5、T6 等 8 项");
  });
});

describe("a stage review's checks (web/src/lib/reviews.ts)", async () => {
  const { checkRows } = await import("../web/src/lib/review-checks.ts");
  it("shows each planned check as queued, running or its result", () => {
    const review = (check_name: string, verdict: "approved" | "changes_requested", n: number) => ({ id: check_name, round: 9, check_name, verdict, summary: "", profile_id: "codex", model: "gpt-6.2-sol", effort: null, created_at: "", findings: Array.from({ length: n }, (_, i) => ({ id: i, severity: "minor", state: "open" })), change_points: [] }) as never;
    const plan = { tier: "ai", tierName: "按改动定", checks: ["review-simplify", "review-business", "reviewer"], reasons: [] };
    const rows = checkRows({ plan, stage: "checks", live: { "review-business": { startedAt: "2026-11-25T13:10:37Z", ai: "codex · gpt-6.2-sol · high" } } }, [review("review-simplify", "approved", 2)]);
    expect(rows.map((r) => [r.name, r.state, r.findings, r.ai])).toEqual([
      ["review-simplify", "approved", 2, "codex · gpt-6.2-sol"],
      ["review-business", "running", 0, "codex · gpt-6.2-sol · high"],
      ["reviewer", "queued", 0, ""],
    ]);
    expect(checkRows({ plan, stage: "plan" }, []).every((r) => r.state === "queued")).toBe(true);
    expect(checkRows({ plan, stage: "done" }, [review("reviewer", "changes_requested", 1)]).map((r) => r.state)).toEqual(["missing", "missing", "changes_requested"]);
  });
});
