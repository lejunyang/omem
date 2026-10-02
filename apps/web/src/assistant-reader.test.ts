import { expect, it } from "vitest";
import { readAssistantAnswer } from "./assistant-reader";

it("renders two fixed ranges of one stored fragment as separate readable references and preserves Markdown links", () => {
  const reference = {
    kind: "source" as const,
    key: "file:processor.ts",
    digest: "fixed",
    revisionId: "revision",
    fragmentIds: ["original"],
    startLine: 2,
    endLine: 4,
  };
  const reading = readAssistantAnswer(
    "**预订**。[e:original:2:4]\n\n释放。[[e:original:6:8]] [文档](https://example.com) [e:missing-id:2:4]",
    [
      {
        fragmentId: "original",
        citationId: "e:original:2:4",
        revisionTitle: "processor.ts",
        sectionTitle: "reserveParcel",
        sourceTarget: reference,
      },
      {
        fragmentId: "original",
        citationId: "e:original:6:8",
        revisionTitle: "processor.ts",
        sectionTitle: "releaseParcel",
        sourceTarget: { ...reference, startLine: 6, endLine: 8 },
      },
    ],
  );
  expect(reading.source).toContain("**预订**。[[answer_0]]");
  expect(reading.source).toContain("[[answer_1]] [文档](https://example.com)");
  expect(reading.source).toContain("引用不可用：本次回答未提供对应原文");
  expect(reading.citations.map((c) => c.label)).toEqual([
    "reserveParcel",
    "releaseParcel",
  ]);
  expect(reading.references[1]!.sourceTarget?.startLine).toBe(6);
  expect(reading.additional).toEqual([]);
});
