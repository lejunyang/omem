import { z } from "zod";
import type { PluginContext, PluginStore } from "../../src/plugins/types.ts";

export const material = z.object({
  ref: z.string().max(200).describe("read_source 给出的 src:<原件id>#L起-L止"),
  title: z.string().max(300).describe("原件标题，宿主按原件校正"),
  summary: z.string().trim().min(1).max(180).describe("用一句中文概括这几行，省略人名、数字和私密细节"),
}).catch({ ref: "", title: "", summary: "" }).optional();
export type Material = NonNullable<z.infer<typeof material>>;
export const expression = z.object({
  zh: z.string().trim().min(1).max(100).describe("这个说法的中文意思"),
  en: z.string().trim().min(1).max(120).describe("这个场合地道的英文说法"),
});
export type Expression = z.infer<typeof expression>;
export type LearnedExpression = Expression & { material: Material };

export type MaterialUse = Material & { sourceId: string; lastUsedAt: string };
export const recentMaterials = (store: PluginStore) => store.get<MaterialUse[]>("history", "materials") ?? [];

const citation = /^src:([\w-]+)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;
export function useMaterials(ctx: PluginContext, entries: { material?: Material }[], warnings: string[], at: string) {
  const cited = entries.flatMap(entry => entry.material ? [{ entry, match: citation.exec(entry.material.ref) }] : []);
  if (!cited.length) return;
  const ids = [...new Set(cited.flatMap(c => c.match ? [c.match[1]] : []))];
  const sources = ctx.materialSources(ids);
  const used = new Map<string, MaterialUse>();
  let dropped = 0;
  for (const { entry, match } of cited) {
    const [, sourceId, start, end = start] = match ?? [];
    const source = sources.get(sourceId);
    if (source && Number(start) <= Number(end) && Number(end) <= source.lines) {
      entry.material = { ...entry.material!, ref: `src:${sourceId}#L${start}-L${end}`, title: source.title };
      used.set(sourceId, { ...entry.material, sourceId, lastUsedAt: at });
    } else {
      delete entry.material;
      dropped++;
    }
  }
  if (dropped) warnings.push(`已去掉 ${dropped} 处无效或不在材料空间内的出处。`);
  if (used.size) ctx.store.put("history", "materials", [...used.values(), ...recentMaterials(ctx.store).filter(r => !used.has(r.sourceId))].slice(0, 60));
}
