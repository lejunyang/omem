// 演示：本人把一件事做给助手看，不写说明（omem 的 src/remote/demos.ts，设计在仓库 docs/v2/remote.md「演示」）。
// 同一时间只有一个演示，状态只在 omem 那边：扩展、网页的关注页和事项页、飞书的 /演示 命令都能开始和结束，
// 所以扩展不把它存进 storage，每次从 GET /api/demos 读。演示进行中时，拾取发到演示的对话里（turn: false，不起一轮），
// 录制上传时带上 demoId（不单独整理）；演示结束时 omem 再把本人在飞书里发的消息和远程页的录制收进来，交给助手整理。
// 这里只放纯数据和规则（可单元测试），请求和界面在 sidepanel/use-demo.ts、DemoBar.vue。

export type DemoOrganize = "skill" | "lessons" | "none";

export interface DemoInfo {
  /** 演示的 id，也是它的对话 id */
  id: string;
  conversationId: string;
  goal: string;
  /** 拾取的截图存到哪个空间：演示所在的空间（关注或事项的空间） */
  spaceId: string;
  context: { id: string; name: string } | null;
  item: { id: string; title: string } | null;
  status: "active" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
  entries: { recording: number; pick: number; lark: number; remote: number };
}

export interface DemoList {
  current: DemoInfo | null;
  recent: DemoInfo[];
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** 服务端回来的一个演示；缺 id 或开始时间的当作没有（旧版 omem 没有这个接口时回的是别的东西）。 */
export function normalizeDemo(raw: unknown): DemoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const startedAt = text(r.startedAt);
  if (!id || !startedAt) return null;
  const context = r.context && typeof r.context === "object" ? (r.context as Record<string, unknown>) : null;
  const item = r.item && typeof r.item === "object" ? (r.item as Record<string, unknown>) : null;
  const entries = (r.entries && typeof r.entries === "object" ? r.entries : {}) as Record<string, unknown>;
  return {
    id,
    conversationId: text(r.conversationId) || id,
    goal: text(r.goal),
    spaceId: text(r.spaceId) || "personal",
    context: context && text(context.id) ? { id: text(context.id), name: text(context.name) || text(context.id) } : null,
    item: item && text(item.id) ? { id: text(item.id), title: text(item.title) || text(item.id) } : null,
    status: r.status === "stopped" || text(r.stoppedAt) ? "stopped" : "active",
    startedAt,
    stoppedAt: text(r.stoppedAt) || null,
    entries: { recording: count(entries.recording), pick: count(entries.pick), lark: count(entries.lark), remote: count(entries.remote) }
  };
}

/** GET /api/demos 的回答；current 必须是进行中的。 */
export function normalizeDemoList(raw: unknown): DemoList {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const current = normalizeDemo(r.current);
  const recent = Array.isArray(r.recent) ? r.recent.map(normalizeDemo).filter((d): d is DemoInfo => !!d) : [];
  return { current: current?.status === "active" ? current : null, recent };
}

/** 演示了多久：“03:15”，超过一小时“1:02:03”。 */
export function demoElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  const seconds = Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 演示连着哪件事，没有时为空。 */
export function demoAbout(demo: Pick<DemoInfo, "context" | "item">): string {
  return [demo.context ? `关注「${demo.context.name}」` : "", demo.item ? `事项「${demo.item.title}」` : ""].filter(Boolean).join(" · ");
}

/** 已经记进演示的：录制（含远程页）、拾取、飞书消息；飞书消息和远程录制在结束时才收。 */
export function demoCountsText(demo: Pick<DemoInfo, "entries">): string {
  const e = demo.entries;
  const parts = [e.recording + e.remote ? `录制 ${e.recording + e.remote}` : "", e.pick ? `拾取 ${e.pick}` : "", e.lark ? `飞书 ${e.lark} 段` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "还没有记下东西";
}

/** 结束时可选的整理方式：连着关注或事项时“整理成经验”排第一（服务端也要求经验挂在关注或事项上）。 */
export function organizeChoices(demo: Pick<DemoInfo, "context" | "item">): Array<{ value: DemoOrganize; label: string; title: string }> {
  const skill = { value: "skill" as const, label: "整理成技能", title: "固定的步骤：以后照着做就能做成" };
  const lessons = { value: "lessons" as const, label: "整理成经验", title: demo.context ? `这类情况怎么判断、怎么回，存进关注「${demo.context.name}」` : "这类情况怎么处理，挂在这件事项上" };
  const none = { value: "none" as const, label: "只结束", title: "先不整理，之后可以在对话里让助手整理" };
  return demo.context || demo.item ? [lessons, skill, none] : [skill, none];
}

/** 开始演示时选的“连着哪件事”：选择框的值 context:<id> / item:<id> / 空。 */
export function parseDemoTarget(value: string): { contextId?: string; itemId?: string } {
  const at = value.indexOf(":");
  const kind = at > 0 ? value.slice(0, at) : "";
  const id = at > 0 ? value.slice(at + 1) : "";
  if (!id) return {};
  return kind === "context" ? { contextId: id } : kind === "item" ? { itemId: id } : {};
}

/**
 * 演示中拾取篮的发送：发到演示的对话里，只记下、不起一轮（turn: false）；截图存进演示所在的空间。
 * 不在演示中时原样返回（问 omem / 存为原件照旧）。
 */
export function clipForDemo<T extends { mode: "ask" | "source"; space: string }>(clip: T, demo: Pick<DemoInfo, "conversationId" | "spaceId"> | null): T & { conversationId?: string; turn?: boolean } {
  if (!demo) return clip;
  return { ...clip, mode: "ask", space: demo.spaceId || clip.space, conversationId: demo.conversationId, turn: false };
}

/** 演示中上传录制：带上 demoId，不单独交给助手（演示结束时一起整理）。 */
export function importFieldsForDemo(demo: Pick<DemoInfo, "id"> | null, options: { organize: boolean; contextId?: string; itemId?: string }): { organize: boolean; contextId?: string; itemId?: string; demoId?: string } {
  if (!demo) return options;
  return { organize: false, demoId: demo.id };
}
