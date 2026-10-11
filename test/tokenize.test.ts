import { describe, expect, it } from "vitest";
import { matchQuery, terms } from "../src/search/tokenize.ts";

describe("terms", () => {
  it("splits CJK into overlapping bigrams", () => {
    expect(terms("预算上限")).toEqual(["预算", "算上", "上限"]);
  });
  it("keeps a single CJK char", () => {
    expect(terms("猫")).toEqual(["猫"]);
  });
  it("splits identifiers into parts and keeps the whole", () => {
    expect(terms("parseVueFile")).toEqual(["parsevuefile", "parse", "vue", "file"]);
    expect(terms("snake_case_name")).toEqual(["snakecasename", "snake", "case", "name"]);
  });
  it("mixes scripts", () => {
    expect(terms("用 RRF 融合")).toEqual(["用", "rrf", "融合"]);
  });
});

describe("matchQuery", () => {
  it("drops question stop-bigrams but keeps content", () => {
    const q = matchQuery("预算是什么时候改的")!;
    expect(q).toContain('"预算"');
    expect(q).not.toContain('"什么"');
  });
  it("returns null for punctuation only", () => {
    expect(matchQuery("？？")).toBeNull();
  });
});
