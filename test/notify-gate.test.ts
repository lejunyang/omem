import { describe, expect, it } from "vitest";
import { addIgnoreRule, listIgnoreRules, recordIgnoreHit } from "../src/core/notify-lessons.ts";
import { testApp } from "./helpers.ts";

describe("notify ignore rules", () => {
  it("stores, counts hits and removes a learned rule", () => {
    const app = testApp();
    const r = addIgnoreRule(app, "群里某人请求拉群/入群的打招呼消息，本人处理后不要再推送", "小王请求加入…");
    expect(listIgnoreRules(app).map((x) => x.id)).toContain(r.id);
    // Same rule text is not duplicated.
    expect(addIgnoreRule(app, r.rule, "另一条").id).toBe(r.id);
    recordIgnoreHit(app, r.id);
    expect(listIgnoreRules(app)[0].hits).toBe(1);
  });
});
