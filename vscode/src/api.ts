
import type { Connection } from "./connection";

/** The omem HTTP API, as the web page uses it, at the omem the connection points to. */
export class Api {
  /** Whether the last request reached omem with access (false: no answer, or a token is missing). */
  reachable = false;

  constructor(readonly conn: Connection) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      const { base, token } = await this.conn.target();
      res = await fetch(base + path, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.reachable = false;
      throw new Error(`连不上 omem（${this.conn.describe()}）：${(e as Error).message}。运行“omem：连接 omem…”检查连接方式`);
    }
    this.reachable = res.status !== 401;
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? (typeof data === "string" ? data : res.statusText);
      throw new Error(res.status === 401 ? `${this.conn.describe()} 要访问令牌：运行“omem：连接 omem…”` : msg);
    }
    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }
}

// ---- shapes the extension reads -----------------------------------------------------------------

export type Run = { id: string; kind: string; title: string; status: string; spaceId: string | null; createdAt: string; finishedAt?: string | null; input: Record<string, unknown>; output: Record<string, unknown> };
export type RunAt = { id: string; rounds: string[]; title: string; status: string; space: string | null; folder: "work" | "applied" };
export type Folder = { space: string; path: string; kind: "work" | "applied"; branch: string | null };
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Decision = "fix" | "later" | "wontfix";
export type Finding = {
  id: number; review_id: string; severity: Severity; file_path: string | null; line: number | null; title: string; detail: string;
  suggestion: string; state: string; merged_into: number | null; triage_note: string; decision?: Decision | null; decision_note?: string;
};
export type Review = { id: string; code_run_id: string; round: number; check_name: string; verdict: string; summary: string; findings: Finding[] };
export type Reviews = { rounds: { runId: string; round: number; status: string; verdict: string | null }[]; reviews: Review[]; labels: Record<string, string> };
export type RunEvent = { seq: number; at: string; type: string; data: Record<string, unknown> };
export type Message = { id: string; role: "user" | "assistant"; text: string };
export type Space = { id: string; name: string; kind: string; rootPath: string | null };

export const SEVERITY: Record<Severity, string> = { blocker: "阻断", major: "严重", minor: "一般", nit: "提示" };
export const DECISION: Record<Decision, string> = { fix: "改", later: "暂不改", wontfix: "不改" };
export const STATUS: Record<string, string> = { queued: "排队中", running: "进行中", done: "完成", failed: "失败", cancelled: "已取消" };
