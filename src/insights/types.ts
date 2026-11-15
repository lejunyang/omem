/** 接口与网页共用的纯数据类型；不引入宿主或数据库模块。 */
export type RecordRef = { id: string; label: string; at: string; link: string; value?: number | string };
export type Metric = { key: string; label: string; value: number | null; previous?: number | null; unit?: string; link: string; note?: string; samples?: number;
  /** This number is one cell of a small table of its section (the page lays such numbers out as a table, not as figures). */
  cell?: { table: string; row: string; col: string } };
export type Chart = { title: string; kind: "area" | "line" | "hbar"; labels: string[]; series: { name: string; values: number[] }[]; stack?: boolean; unit?: string; points?: Metric[] };
export type Section = { id: string; title: string; description: string; empty?: string; error?: string; metrics: Metric[]; charts: Chart[]; notes: string[] };
export type Report = {
  from: string; to: string; timezone: string; owner: boolean; scenes: readonly string[]; sceneTable: Record<string, string>;
  sections: Section[]; options: { spaces: string[]; people: string[]; profiles: string[]; models: string[]; bots: string[]; chats: string[] }; generatedAt: string;
};
