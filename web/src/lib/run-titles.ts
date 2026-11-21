import { reactive } from "vue";
import { get, type IdHit } from "../api";

/**
 * Titles for the runs a settings card lists by id only (出网代理, 云端工具: their interfaces carry no
 * titles), so rows read “运行：整理退款口径” instead of a raw id. Each id is asked once (`GET /api/lookup`);
 * one that cannot be found keeps the plain “运行”.
 */
export function useRunTitles() {
  const titles = reactive<Record<string, string>>({});
  const asked = new Set<string>();
  function want(ids: (string | null | undefined)[]) {
    for (const id of ids) {
      if (!id || asked.has(id)) continue;
      asked.add(id);
      void get<{ hits: IdHit[] }>(`/api/lookup?id=${encodeURIComponent(id)}`)
        .then((r) => {
          const hit = r.hits.find((h) => h.type === "run" && h.id === id);
          if (hit?.title) titles[id] = hit.title;
        })
        .catch(() => {});
    }
  }
  const title = (id: string | null) => (id ? titles[id] ?? "运行" : "不属于某个运行");
  return { title, want };
}
