import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTimeZone } from "../web/src/lib/time.ts";
import { byMonth, byWeek, changeTone, dayKeyLabel, dayLabel, endedLine, flatChildren, otherRefs, readableIds, refsMarkdown, shortDay, stageTone, waitsForOwner, weekColumns, weekLabel, type ChangeLite, type Child } from "../web/src/lib/work.ts";
import { evidenceLink, evidenceWord } from "../web/src/lib/flow.ts";

// 2026-11-20 is a Friday; 15:00 in Shanghai.
const now = Date.parse("2026-11-20T07:00:00Z");
const at = (iso: string) => new Date(iso).toISOString();
const change = (when: string, summary: string, type = "info"): ChangeLite => ({ id: summary, at: at(when), type, summary, detail: null, risk: null, next: null, refs: [], status: "noted", origin: "follow", noise: false, itemId: "i1", itemTitle: "线", lineId: "i1", lineTitle: "线" });
const child = (id: string, patch: Partial<Child> = {}): Child => ({ id, title: id, kind: "todo", status: "open", dueAt: null, parentId: null, waitingOn: null, flow: null, ...patch });

describe("工作页的呈现（web/src/lib/work）", () => {
  beforeAll(() => setTimeZone("Asia/Shanghai"));
  afterAll(() => setTimeZone(undefined));

  it("日期按本人的时区说今天、昨天，别的写几月几日，跨年带年份", () => {
    expect(dayLabel("2026-11-20T01:00:00Z", now)).toBe("今天");
    // 11-19 23:30 in Shanghai is yesterday even though it is 11-19 15:30 UTC.
    expect(dayLabel("2026-11-19T15:30:00Z", now)).toBe("昨天");
    expect(dayLabel("2026-11-19T16:30:00Z", now)).toBe("今天");
    expect(dayLabel("2026-11-09T04:00:00Z", now)).toBe("11 月 9 日");
    expect(dayLabel("2025-12-30T04:00:00Z", now)).toBe("2025 年 12 月 30 日");
    expect(dayLabel("2026-12-02T04:00:00Z", now)).toBe("12 月 2 日");
    expect(dayKeyLabel("2026-11-20", "2026-11-20")).toBe("11 月 20 日 · 今天");
    expect(dayKeyLabel("2026-11-19", "2026-11-20")).toBe("11 月 19 日 · 昨天");
  });

  it("按周分组从周一算起，本周写至今第几天", () => {
    expect(weekLabel(0, now)).toBe("本周 · 至今 5 天");
    expect(weekLabel(1, now)).toBe("上周");
    expect(weekLabel(3, now)).toBe("3 周前");
    const groups = byWeek([change("2026-11-20T01:00:00Z", "a"), change("2026-11-16T01:00:00Z", "b"), change("2026-11-15T12:00:00Z", "c"), change("2026-11-01T01:00:00Z", "d")], now);
    expect(groups.map((g) => [g.label, g.items.map((c) => c.id).join("")])).toEqual([["本周 · 至今 5 天", "ab"], ["上周", "c"], ["3 周前", "d"]]);
  });

  it("“最近忙这些”四栏先用整理写的，没写的用那周最新的变化，都没有就空着", () => {
    const cols = weekColumns({ text: "现在", people: [], weeks: [{ label: "本周", text: "本周写的" }, { label: "上周", text: "" }], at: at("2026-11-20T01:00:00Z"), runId: null }, [change("2026-11-17T01:00:00Z", "本周的变化"), change("2026-11-12T01:00:00Z", "上周较新的"), change("2026-11-10T01:00:00Z", "上周较早的")], now);
    expect(cols.map((c) => c.text)).toEqual(["本周写的", "上周较新的", "", ""]);
    expect(cols.map((c) => c.count)).toEqual([1, 2, 0, 0]);
  });

  it("变化的颜色：风险和改期暖色，定下的用强调色，结果和解除用绿色", () => {
    expect(["blocker", "deadline", "decision", "scope", "result", "resolved", "stage", "info"].map(changeTone)).toEqual(["warn", "warn", "accent", "accent", "ok", "ok", "quiet", "quiet"]);
  });

  it("工作项按层展开，缺陷跟在需求后面；默认不含已结束的；等本人的阶段看得出来", () => {
    const flow = { name: "需求交付", stages: [{ id: "code", name: "编码", state: "done", enteredAt: null, doneAt: null, waitingOn: null }, { id: "push", name: "推送", state: "doing", enteredAt: null, doneAt: null, waitingOn: "owner" }], current: { id: "push", name: "推送", state: "doing" } };
    const tree = [child("req", { flow, children: [child("bug", { parentId: "req" })] }), child("old", { status: "done" })];
    expect(flatChildren(tree).map((x) => `${x.child.id}:${x.depth}`)).toEqual(["req:0", "bug:1"]);
    expect(flatChildren(tree, true).map((x) => x.child.id)).toEqual(["req", "bug", "old"]);
    expect(waitsForOwner(tree[0])).toBe(true);
    expect(waitsForOwner(child("plain"))).toBe(false);
    expect(flow.stages.map((s) => stageTone(s, "push"))).toEqual(["ok", "warn"]);
  });

  it("来源只把 src / mem / msg 写成引用链接", () => {
    expect(refsMarkdown(["src:s1#L3-L9", "r0abc", "mem:m1"])).toBe("[原件 1](src:s1#L3-L9)　[记忆 2](mem:m1)");
  });

  it("其余的来源：事项和运行按服务端给的标题链接，方案链到方案，认不出的只写字", () => {
    const item = "i0mwabcdef0123456789", runId = "r0mwabcdef0123456789";
    const shown = otherRefs([item, `code-work:${runId}`, "design:d1", "i0mwzzzzzz9999999999", "github:pr:12", "src:s1"], {
      [item]: { kind: "item", id: item, title: "一个很长很长很长很长很长很长很长很长很长很长很长很长的事项标题" },
      [`code-work:${runId}`]: { kind: "run", id: runId, title: "编码交办" },
    });
    expect(shown.map((o) => o.link)).toEqual([`#/work/${item}`, `#/code/${runId}`, "#/code/designs/d1", null, null]);
    expect(shown[0].label.length).toBeLessThanOrEqual(43);
    expect(shown[0].title).toContain("事项标题");
    expect(shown[1].label).toBe("运行：编码交办");
    // The flow page's evidence: a run, a plan or an item opens; a platform object or a word is text.
    expect([runId, `run:${runId}`, `code-work:${runId}`, "design:d1", item, `item:${item}`, "github:pr:12", "编码阶段"].map(evidenceLink))
      .toEqual([`#/runs/${runId}`, `#/runs/${runId}`, `#/code/${runId}`, "#/code/designs/d1", `#/work/${item}`, `#/work/${item}`, null, null]);
    expect([runId, item, "design:d1"].map(evidenceWord)).toEqual(["运行", "事项", "方案"]);
  });

  it("现状里的长串：认得出的 id 换成名字的链接，其余写成行内代码，已有的引用和链接不动", () => {
    const run = "r0mwaaaaaaaa11112222";
    const text = `原交办第7轮${run}已done，提交ab12cd34推到origin/feat/x-y；接口/api/a/b-c报错，见ask0mwbbbbbbbb3333444和src:s0mwcccccccc55556666，[文档](https://tenant.larkoffice.com/a/b/c)，PC/H5 不动，20261113 不动`;
    const out = readableIds(text, { [run]: { kind: "run", id: run, title: "编码交办" } });
    expect(out).toContain(`[运行：编码交办](#/runs/${run})`);
    expect(out).toContain("`ab12cd34`");
    expect(out).toContain("`origin/feat/x-y`");
    expect(out).toContain("`/api/a/b-c`");
    expect(out).toContain("`ask0mwbbbbbbbb3333444`");
    expect(out).toContain("src:s0mwcccccccc55556666");
    expect(out).not.toContain("[原件](src:");
    expect(out).toContain("[文档](https://tenant.larkoffice.com/a/b/c)");
    expect(out).toContain("PC/H5 不动，20261113 不动");
    expect(readableIds("编号 s0mwdddddddd77778888 的原件")).toBe("编号 [原件](src:s0mwdddddddd77778888) 的原件");
  });

  it("已结束的线按本人时区的月份分组，一行写小结的第一句，没有就写原因", () => {
    const rows = [
      { id: "a", closedAt: "2026-11-30T17:00:00Z", summary: "## 做成了什么\n按已发货行退款，12 月 2 日全量。", reason: "自动结束：观察了 14 天", status: "done" },
      { id: "b", closedAt: "2026-11-10T04:00:00Z", summary: null, reason: "本人结束了这条线", status: "done" },
      { id: "c", closedAt: "2026-10-31T17:30:00Z", summary: null, reason: null, status: "cancelled" },
    ];
    // 11-30 17:00 UTC is 12-01 01:00 in Shanghai.
    expect(byMonth(rows).map((g) => [g.label, g.items.map((x) => x.id)])).toEqual([["2026 年 12 月", ["a"]], ["2026 年 11 月", ["b", "c"]]]);
    expect(rows.map(endedLine)).toEqual(["按已发货行退款，12 月 2 日全量。", "本人结束了这条线", "放弃了"]);
    expect(shortDay("2026-12-05T04:00:00Z", now)).toBe("12/05");
    expect(shortDay("2027-01-05T04:00:00Z", now)).toBe("2027/01/05");
  });
});
