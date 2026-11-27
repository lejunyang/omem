/** 接口与网页共用的纯数据类型；不引入宿主或数据库模块。 */
/** `run`: the run a record belongs to when its link does not say (a notification, a replay); the breakdown reads its dimensions from it. */
export type RecordRef = { id: string; label: string; at: string; link: string; value?: number | string; run?: string };
export type Metric = { key: string; label: string; value: number | null; previous?: number | null; unit?: string; link: string; note?: string; samples?: number;
  /** This number is one cell of a small table of its section (the page lays such numbers out as a table, not as figures). */
  cell?: { table: string; row: string; col: string } };
export type Chart = { title: string; kind: "area" | "line" | "hbar"; labels: string[]; series: { name: string; values: number[] }[]; stack?: boolean; unit?: string; points?: Metric[] };
export type Section = { id: string; title: string; description: string; empty?: string; error?: string; metrics: Metric[]; charts: Chart[]; notes: string[] };
/** One record in a number's breakdown: who started it, how long it took and how it ended, when it is a run (or belongs to one). */
export type BreakdownRecord = RecordRef & { by?: string; seconds?: number; result?: string };
/** A way to split a number's records (scene, agent, space, model, who, conversation, how it ended): the largest groups first. */
export type BreakdownDim = { key: string; label: string; rows: { value: string; label: string; count: number }[]; more: number };
/** A number taken apart (GET /api/insights/breakdown): its course by day, its records split several ways, and the records themselves. */
export type Breakdown = {
  key: string; label: string; value: number | null; unit?: string; note?: string; previous?: number | null; from: string; to: string;
  /** Records counted before the picks, and after them (the list and the splits follow the picks). */
  all: number; total: number;
  /** Records per day of the period; null when the records carry no date in it. */
  daily: { labels: string[]; values: number[] } | null;
  dims: BreakdownDim[];
  picks: { dim: string; value: string; label: string }[];
  records: BreakdownRecord[];
};
export type Report = {
  from: string; to: string; timezone: string; owner: boolean; scenes: readonly string[]; sceneTable: Record<string, string>;
  sections: Section[]; options: { spaces: string[]; people: string[]; peopleNames?: Record<string, string>; profiles: string[]; models: string[]; bots: string[]; chats: string[] }; generatedAt: string;
};
