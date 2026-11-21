/**
 * A run as a settings card lists it (出网代理, 云端工具): the title its interface sends along, “运行” when the
 * run has none (or an older server sends no titles), or that the row belongs to no run. Pure.
 */
export const runName = (r: { runId: string | null; title?: string | null }) => (r.runId ? r.title?.trim() || "运行" : "不属于某个运行");
