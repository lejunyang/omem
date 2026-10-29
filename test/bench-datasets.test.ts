import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locomoToLongMemEval } from "../scripts/bench/locomo.ts";

describe("public evaluation data", () => {
  it("lists every dataset with a licence, a converter and pinned hashes where the source publishes them", () => {
    const m = JSON.parse(readFileSync("scripts/bench/datasets.json", "utf8")) as Record<string, { license: string; commercial: boolean; convert: string; files: { url: string; sha256: string | null }[] }>;
    expect(Object.keys(m)).toEqual(expect.arrayContaining(["longmemeval_s", "t2retrieval", "duretrieval", "locomo"]));
    for (const d of Object.values(m)) {
      expect(d.license).toBeTruthy();
      expect(["longmemeval", "cmteb-retrieval", "locomo"]).toContain(d.convert);
      for (const f of d.files) {
        expect(f.url).toMatch(/^https:\/\//);
        if (f.sha256 !== null) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(m.locomo.commercial).toBe(false);
    expect(m.locomo.license).toMatch(/非商用/);
  });

  it("turns LoCoMo into LongMemEval's question shape with evidence sessions", () => {
    const items = locomoToLongMemEval([
      {
        sample_id: "conv-1",
        conversation: {
          speaker_a: "小王",
          speaker_b: "小李",
          session_1_date_time: "1:56 pm on 8 May, 2023",
          session_1: [{ speaker: "小王", dia_id: "D1:1", text: "我下周去杭州" }, { speaker: "小李", dia_id: "D1:2", text: "好", blip_caption: "a cat" }],
          session_2_date_time: "1:14 pm on 25 May, 2023",
          session_2: [{ speaker: "小王", dia_id: "D2:1", text: "杭州回来了" }],
        },
        qa: [
          { question: "小王去了哪里？", answer: "杭州", evidence: ["D1:1", "D2:1"], category: 4 },
          { question: "小李养了什么狗？", adversarial_answer: "没提到", evidence: [], category: 5 },
        ],
      },
    ]) as any[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ question_id: "conv-1-q1", question_type: "single-hop", answer: "杭州", haystack_key: "conv-1", haystack_session_ids: ["conv-1-s1", "conv-1-s2"], answer_session_ids: ["conv-1-s1", "conv-1-s2"], question_date: "1:14 pm on 25 May, 2023" });
    expect(items[0].haystack_sessions[0][1]).toEqual({ role: "小李", content: "好 [图片：a cat]" });
    expect(items[1]).toMatchObject({ question_id: "conv-1-q2_abs", question_type: "adversarial", answer_session_ids: [] });
  });
});
