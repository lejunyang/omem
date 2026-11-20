import { describe, expect, it } from "vitest";
import { clipForDemo, demoAbout, demoCountsText, demoElapsed, importFieldsForDemo, normalizeDemo, normalizeDemoList, organizeChoices, parseDemoTarget } from "./demo";

const raw = {
  id: "c1",
  conversationId: "c1",
  goal: "值班群里有人报退款失败时怎么查",
  spaceId: "proj-a",
  context: { id: "ctx1", name: "值班群" },
  item: null,
  status: "active",
  startedAt: "2026-11-20T02:00:00.000Z",
  stoppedAt: null,
  entries: { recording: 1, pick: 2, lark: 0, remote: 1 }
};

describe("演示的状态", () => {
  it("读 GET /api/demos：current 只认进行中的，缺 id 或开始时间的丢掉", () => {
    const list = normalizeDemoList({ current: raw, recent: [raw, { id: "", startedAt: "x" }, null, { ...raw, id: "c0", status: "stopped", stoppedAt: "2026-11-19T00:00:00.000Z" }] });
    expect(list.current).toMatchObject({ id: "c1", spaceId: "proj-a", context: { id: "ctx1", name: "值班群" }, item: null, status: "active" });
    expect(list.recent.map((d) => [d.id, d.status])).toEqual([
      ["c1", "active"],
      ["c0", "stopped"]
    ]);
    // 结束了的不算当前；旧版 omem 回的不是这个形状时当作没有演示
    expect(normalizeDemoList({ current: { ...raw, stoppedAt: "2026-11-20T03:00:00.000Z" } }).current).toBeNull();
    expect(normalizeDemoList({ error: "Not Found" })).toEqual({ current: null, recent: [] });
    expect(normalizeDemoList(null)).toEqual({ current: null, recent: [] });
  });

  it("缺字段时补上：对话 id 用演示 id，空间默认个人空间，计数不认负数和非数字", () => {
    const demo = normalizeDemo({ id: "c2", startedAt: "2026-11-20T02:00:00.000Z", entries: { pick: -1, lark: "3" }, context: { id: "ctx9" } });
    expect(demo).toMatchObject({ conversationId: "c2", spaceId: "personal", goal: "", context: { id: "ctx9", name: "ctx9" }, entries: { recording: 0, pick: 0, lark: 0, remote: 0 } });
  });

  it("显示：计时、连着哪件事、记下了什么", () => {
    const start = Date.parse(raw.startedAt);
    expect(demoElapsed(raw.startedAt, start + 75_000)).toBe("01:15");
    expect(demoElapsed(raw.startedAt, start + 3_723_000)).toBe("1:02:03");
    expect(demoElapsed(raw.startedAt, start - 5000)).toBe("00:00");
    expect(demoElapsed("不是时间", start)).toBe("00:00");
    expect(demoAbout(normalizeDemo(raw)!)).toBe("关注「值班群」");
    expect(demoAbout({ context: null, item: { id: "i1", title: "商户 B 退款权限" } })).toBe("事项「商户 B 退款权限」");
    expect(demoCountsText(normalizeDemo(raw)!)).toBe("录制 2 · 拾取 2");
    expect(demoCountsText({ entries: { recording: 0, pick: 0, lark: 0, remote: 0 } })).toBe("还没有记下东西");
  });

  it("结束时的整理方式：连着关注或事项时经验在前，没有时只能整理成技能或只结束", () => {
    expect(organizeChoices({ context: { id: "ctx1", name: "值班群" }, item: null }).map((c) => c.value)).toEqual(["lessons", "skill", "none"]);
    expect(organizeChoices({ context: null, item: { id: "i1", title: "A" } }).map((c) => c.value)).toEqual(["lessons", "skill", "none"]);
    expect(organizeChoices({ context: null, item: null }).map((c) => c.value)).toEqual(["skill", "none"]);
  });

  it("开始时选的目标", () => {
    expect(parseDemoTarget("context:ctx1")).toEqual({ contextId: "ctx1" });
    expect(parseDemoTarget("item:i_1:x")).toEqual({ itemId: "i_1:x" });
    expect(parseDemoTarget("")).toEqual({});
    expect(parseDemoTarget("other:1")).toEqual({});
    expect(parseDemoTarget("context:")).toEqual({});
  });

  it("演示中拾取发到演示的对话、不起一轮，截图存进演示的空间；不在演示中原样发", () => {
    const clip = { mode: "source" as const, space: "personal", title: "t", text: "x", pageUrl: "", images: [] };
    expect(clipForDemo(clip, null)).toBe(clip);
    expect(clipForDemo(clip, { conversationId: "c1", spaceId: "proj-a" })).toEqual({ ...clip, mode: "ask", space: "proj-a", conversationId: "c1", turn: false });
  });

  it("演示中上传录制带 demoId、不单独整理，忽略选的关注和事项", () => {
    expect(importFieldsForDemo(null, { organize: true, contextId: "ctx1" })).toEqual({ organize: true, contextId: "ctx1" });
    expect(importFieldsForDemo({ id: "c1" }, { organize: true, itemId: "i1" })).toEqual({ organize: false, demoId: "c1" });
  });
});
