import { z } from "zod";
import { classIds } from "../agents/run-classes.ts";

export const classSchema = z.enum(classIds);
const refs = z.array(z.string().trim().min(1)).max(100);
export const specAiSchema = z.object({ use: refs.optional(), deny: refs.optional(), strict: z.boolean().optional() }).strict();
export const classPolicySchema = specAiSchema.extend({
  use: refs.default([]), deny: refs.default([]), strict: z.boolean().default(false),
  order: z.enum(["choose", "fixed"]).default("choose"),
  said: z.array(z.object({ text: z.string().min(1), at: z.string().min(1) })).default([]),
});
export const policySchema = z.object({ deny: refs.default([]), classes: z.partialRecord(classSchema, classPolicySchema).default({}) }).strict();
export type Policy = z.infer<typeof policySchema>;
const groupItemFields = {
  hours: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  note: z.string().max(2000).optional(),
};
const groupItem = z.object({
  profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional(), ...groupItemFields,
}).strict();
const writtenItem = z.object({ ai: z.string().min(1), ...groupItemFields }).strict().transform(({ ai, ...fields }): z.input<typeof groupItem> => {
  const [profile, model, effort] = ai.split("·").map(word => word.trim());
  return { ...fields, profile, model, effort };
}).pipe(groupItem);
export const groupsSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), name: z.string().trim().min(1),
  items: z.array(z.union([groupItem, writtenItem])).max(100),
}).strict()).max(100);
export type AiGroup = z.infer<typeof groupsSchema>[number];
export const builtinGroups = { strong: "强", standard: "标准", cheap: "省" } as const;
export const emptyGroups = (): AiGroup[] => Object.entries(builtinGroups).map(([id, name]) => ({ id, name, items: [] }));
