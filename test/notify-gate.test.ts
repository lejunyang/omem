import { describe, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { keywords, learnMute, listMuteRules, muteMatch, recordMuteHit } from "../src/core/notify-lessons.ts";

describe("notify lessons", () => {
  it("extracts Chinese bigram and latin keywords", () => {
    const k = keywords("小王请求加入应用下载 schema 改造相关群");
    expect(k).toEqual(expect.arrayContaining(["请求", "加入", "schema"]));
  });
  it("learns a dismissal and matches a similar future nudge", () => {
    const app = testApp();
    const r = learnMute(app, { title: "小王请求加入应用下载 schema 改造相关群", body: "拉我下了" });
    expect(listMuteRules(app)).toHaveLength(1);
    expect(muteMatch(app, { title: "新同事请求加入应用下载 schema 改造相关群" })?.id).toBe(r.id);
    // Unrelated title must not match.
    expect(muteMatch(app, { title: "线上支付失败率突增，需要立即处理" })).toBeNull();
    recordMuteHit(app, r.id);
    expect(listMuteRules(app)[0].hits).toBe(1);
  });
});
