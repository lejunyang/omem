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

const citation = /^src:([\w-]+)#L([1-9]\d*)-L([1-9]\d*)$/;
export function checkMaterials(ctx: PluginContext, entries: { material?: Material }[], warnings: string[]) {
  const cited = entries.flatMap(entry => entry.material ? [{ entry, match: citation.exec(entry.material.ref) }] : []);
  if (!cited.length) return;
  const ids = [...new Set(cited.flatMap(c => c.match ? [c.match[1]] : []))];
  const sources = ctx.materialSources(ids);
  let dropped = 0;
  for (const { entry, match } of cited) {
    const source = match && sources.get(match[1]);
    if (match && source && Number(match[2]) <= Number(match[3]) && Number(match[3]) <= source.lines) {
      entry.material = { ...entry.material!, title: source.title };
    } else {
      delete entry.material;
      dropped++;
    }
  }
  if (dropped) warnings.push(`已去掉 ${dropped} 处无效或不在材料空间内的出处。`);
}

export type MaterialUse = Material & { sourceId: string; lastUsedAt: string };
export const recentMaterials = (store: PluginStore) => store.get<MaterialUse[]>("history", "materials") ?? [];
export function rememberMaterials(store: PluginStore, entries: { material?: Material }[], at: string) {
  const used = new Map<string, MaterialUse>();
  for (const { material } of entries) {
    if (!material) continue;
    const sourceId = material.ref.slice(4, material.ref.indexOf("#"));
    used.set(sourceId, { ...material, sourceId, lastUsedAt: at });
  }
  if (used.size) store.put("history", "materials", [...used.values(), ...recentMaterials(store).filter(r => !used.has(r.sourceId))].slice(0, 60));
}
