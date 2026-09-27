import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import { stableDigest } from "../storage/digest.js";
import {
  QualityRepository,
  qualityLabelSchema,
  qualitySampleInputSchema,
  type QualityLabel,
  type QualitySampleInput,
} from "./repository.js";

const plainText = (value: string) =>
  value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function documentQualitySamples(
  document: CaptureInput,
  sourceUri: string,
  limit = 40,
) {
  const markdown = document.parts
    .filter(
      (
        part,
      ): part is Extract<CaptureInput["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n");
  const blocks = markdown.split(/\n\s*\n/);
  let section = "文档正文";
  const candidates: {
    input: QualitySampleInput;
    draftLabel: QualityLabel;
    score: number;
    sourceOrder: number;
  }[] = [];
  const seen = new Set<string>();
  for (const [blockIndex, raw] of blocks.entries()) {
    const heading = raw.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      section = plainText(heading[1]!);
      continue;
    }
    if (
      /<(?:whiteboard|grid|column|table)\b/i.test(raw) ||
      /^!\[/m.test(raw) ||
      /^\s*\|/m.test(raw) ||
      /\|-{1,}\|/.test(raw)
    )
      continue;
    const sentences = raw.split(/\n+/).flatMap((line) => {
      const cleaned = plainText(line).replace(/^[-+*]\s+/, "");
      return cleaned.length > 120
        ? (cleaned.match(/[^。！？；]+[。！？；]?/g) ?? [cleaned])
        : [cleaned];
    });
    for (const sentence of sentences) {
      const text = sentence.trim();
      if (text.length < 24 || text.length > 500) continue;
      const inputDigest = stableDigest({ section, text });
      if (seen.has(inputDigest)) continue;
      seen.add(inputDigest);
      const fragmentId = `quality-fragment-${inputDigest.slice(0, 40)}`;
      const input = qualitySampleInputSchema.parse({
        source: {
          uri: sourceUri,
          documentId: document.externalId,
          revisionId: document.upstreamVersion || "latest",
          fragmentId,
          section,
        },
        category: "explicit",
        text,
        provenance: {
          actorId: null,
          actorVerified: false,
          forwarded: false,
        },
      });
      const ruleMatches = text.match(
        /只能|仅能|最多|必须|不能|不支持|需要|允许|优先|限制|条件|规则/g,
      );
      candidates.push({
        input,
        draftLabel: qualityLabelSchema.parse({
          disposition: "extract",
          objects: [
            {
              kind: "claim",
              statement: text,
              evidenceQuote: text,
            },
          ],
          autoApply: true,
          forbiddenEffects: ["不得把文档描述解释为执行外部操作的授权"],
          notes:
            "待确认：事实是否准确且值得长期记住、关键限定是否完整、是否允许在此业务范围自动沉淀。",
        }),
        score:
          (ruleMatches?.length ?? 0) * 10 +
          (/仅能|只能/.test(text) ? 5 : 0) +
          (/不支持|不得|不能/.test(text) ? 5 : 0) +
          (/[0-9一二三四五六七八九十]/.test(text) ? 3 : 0),
        sourceOrder: blockIndex,
      });
    }
  }
  const samples = candidates
    .sort(
      (left, right) =>
        right.score - left.score || left.sourceOrder - right.sourceOrder,
    )
    .slice(0, limit)
    .map(({ input, draftLabel }) => ({ input, draftLabel }));
  if (samples.length < limit)
    throw Error(
      `QUALITY_SOURCE_TOO_SMALL: expected ${limit}, found ${samples.length}`,
    );
  return {
    sourceDigest: stableDigest({
      sourceUri,
      documentId: document.externalId,
      revisionId: document.upstreamVersion ?? null,
      markdown,
    }),
    samples,
  };
}

export function importDocumentDataset(input: {
  repository: QualityRepository;
  document: CaptureInput;
  sourceUri: string;
  name: string;
  split: "dev" | "holdout";
  targetCount: number;
}) {
  const generated = documentQualitySamples(
    input.document,
    input.sourceUri,
    input.targetCount,
  );
  const dataset = input.repository.createDataset({
    name: input.name,
    split: input.split,
    sourceUri: input.sourceUri,
    sourceRevisionId: input.document.upstreamVersion ?? null,
    sourceDigest: generated.sourceDigest,
    targetCount: input.targetCount,
  });
  const inserted = input.repository.addSamples(dataset.id, generated.samples);
  return { ...dataset, ...inserted, sampleCount: generated.samples.length };
}
