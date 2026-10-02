import { z } from "zod";

/** Reading and retrieval metadata. These labels do not make a source an applied fact. */
export const materialRoles = [
  "reference",
  "implementation",
  "plan",
  "research",
  "record",
  "example",
  "unknown",
] as const;
export const materialRoleLabels: Record<MaterialRole, string> = {
  reference: "说明与规范",
  implementation: "实现",
  plan: "计划与提案",
  research: "调研与验证",
  record: "事件记录",
  example: "示例与演示",
  unknown: "尚未分类",
};
export type MaterialRole = (typeof materialRoles)[number];
export const materialStatuses = [
  "current",
  "proposed",
  "historical",
  "superseded",
  "unknown",
] as const;
export const materialStatusLabels: Record<
  (typeof materialStatuses)[number],
  string
> = {
  current: "材料声明现行",
  proposed: "尚未实施",
  historical: "历史背景",
  superseded: "已被替代",
  unknown: "适用状态未明",
};
export const materialDescriptionSchema = z
  .object({
    role: z.enum(materialRoles),
    status: z.enum(materialStatuses),
    summary: z.string().max(1200),
    topics: z.array(z.string().min(1).max(100)).max(12),
    scope: z.string().max(500).nullable(),
    validFrom: z.iso.datetime({ offset: true }).nullable(),
    validUntil: z.iso.datetime({ offset: true }).nullable(),
    // Each concept describes a particular passage; never repeat a generic summary
    // on every function or use evaluation questions as generated search keywords.
    concepts: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            aliases: z.array(z.string().min(1).max(100)).max(8),
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
          })
          .strict(),
      )
      .max(40),
    basis: z.string().max(1200),
  })
  .strict();
export type MaterialDescription = z.infer<typeof materialDescriptionSchema>;
export type MaterialDescriptionRecord = {
  revisionId: string;
  version: number;
  author: "model" | "user";
  description: MaterialDescription;
  updatedAt: string;
};
export const materialDescriptionBatchSchema = z
  .object({
    descriptions: z
      .array(
        z
          .object({
            key: z.string().min(1),
            description: materialDescriptionSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
