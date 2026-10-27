import * as vscode from "vscode";

/**
 * The omem HTTP API, as the web page uses it. On the machine omem runs on (locally, or this
 * extension running remotely over Remote-SSH) loopback is trusted without a token; elsewhere the
 * owner's token (`omem user token`) is kept in SecretStorage.
 */
export class Api {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get base() {
    return (vscode.workspace.getConfiguration("omem").get<string>("url") || "http://127.0.0.1:4317").replace(/\/+$/, "");
  }

  web(hash: string) {
    return vscode.Uri.parse(`${this.base}/#${hash}`);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.secrets.get("omem.token");
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`连不上 omem（${this.base}）：${(e as Error).message}。设置里的 omem.url 对吗？`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? (typeof data === "string" ? data : res.statusText);
      throw new Error(res.status === 401 ? "omem 要访问令牌：运行“omem：设置访问令牌”" : msg);
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
