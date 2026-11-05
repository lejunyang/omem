import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, now, truncate } from "../core/util.ts";

/**
 * Recordings made in remote sessions (docs/v2/remote.md): what someone did in a browser page or a
 * window, kept under the data directory as aad wrote it, plus the steps that replay it. An agent
 * reads them through read_recording and turns one into a skill (save_skill from_recording).
 */

export type Recording = {
  id: string;
  kind: "browser" | "desktop";
  goal: string;
  target: string;
  status: "recording" | "done" | "failed";
  dir: string;
  summary: Record<string, unknown>;
  replay: Record<string, unknown> | null;
  conversationId: string | null;
  skill: string | null;
  userId: string;
  createdAt: string;
  finishedAt: string | null;
};

type Row = { id: string; kind: string; goal: string; target: string; status: string; dir: string; summary: string; replay: string | null; conversation_id: string | null; skill: string | null; user_id: string; created_at: string; finished_at: string | null };

const toRecording = (r: Row): Recording => ({
  id: r.id,
  kind: r.kind as Recording["kind"],
  goal: r.goal,
  target: r.target,
  status: r.status as Recording["status"],
  dir: r.dir,
  summary: JSON.parse(r.summary || "{}"),
  replay: r.replay ? JSON.parse(r.replay) : null,
  conversationId: r.conversation_id,
  skill: r.skill,
  userId: r.user_id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export const recordingDir = (app: App, id: string) => join(app.home, "remote", "recordings", id);

export function createRecording(app: App, r: { id: string; kind: Recording["kind"]; goal: string; target: string; dir: string; conversationId: string | null; userId: string }) {
  run(app.db, "insert into remote_recordings(id, kind, goal, target, status, dir, conversation_id, user_id, created_at) values (?, ?, ?, ?, 'recording', ?, ?, ?, ?)", r.id, r.kind, r.goal, r.target, r.dir, r.conversationId, r.userId, now());
  return getRecording(app, r.id);
}

export function updateRecording(app: App, id: string, p: { status?: Recording["status"]; summary?: Record<string, unknown>; replay?: Record<string, unknown>; finishedAt?: string; conversationId?: string; skill?: string }) {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  const set = (col: string, v: string | null) => (sets.push(`${col} = ?`), args.push(v));
  if (p.status) set("status", p.status);
  if (p.summary) set("summary", JSON.stringify(p.summary));
  if (p.replay) set("replay", JSON.stringify(p.replay));
  if (p.finishedAt) set("finished_at", p.finishedAt);
  if (p.conversationId) set("conversation_id", p.conversationId);
  if (p.skill) set("skill", p.skill);
  if (sets.length) run(app.db, `update remote_recordings set ${sets.join(", ")} where id = ?`, ...args, id);
  return getRecording(app, id);
}

export function getRecording(app: App, id: string, userId?: string) {
  const r = one<Row>(app.db, "select * from remote_recordings where id = ?", id);
  if (!r || (userId && r.user_id !== userId)) throw new HttpError(404, `没有录制 ${id}`);
  return toRecording(r);
}

/** Sessions live in memory: a recording still marked as running when omem starts was cut off by its exit. */
export function markInterrupted(app: App) {
  run(app.db, "update remote_recordings set status = 'failed', summary = ?, finished_at = ? where status = 'recording'", JSON.stringify({ error: "omem 退出时录制还没停，录制中断" }), now());
}

export function listRecordings(app: App, userId: string, limit = 30) {
  return all<Row>(app.db, "select * from remote_recordings where user_id = ? order by created_at desc limit ?", userId, limit).map(toRecording);
}

// ------------------------------------------------------------------------------- reading the files

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : []);
const jsonLines = (file: string) =>
  lines(file).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
const readJson = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const files = (dir: string, ext: RegExp): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name), ext).map((f) => `${d.name}/${f}`) : ext.test(d.name) ? [d.name] : []))
    : [];

/** Counts for the page and the organizing message, from what the recording directory holds. */
export function recordingSummary(dir: string): Record<string, unknown> {
  const replay = readJson(join(dir, "record.json")) ?? {};
  const steps: { app?: { url?: string } }[] = replay.steps ?? [];
  return {
    actions: jsonLines(join(dir, "steps.jsonl")).filter((s) => s.kind === "action").length || steps.length,
    replayable: steps.length,
    skipped: (replay.skipped ?? []).length,
    requests: lines(join(dir, "evidence", "network.jsonl")).length,
    screenshots: files(dir, /\.(png|jpe?g|webp)$/i).length,
    workflow: existsSync(join(dir, "workflow.yaml")),
    firstPage: steps.find((s) => s.app?.url)?.app?.url ?? null,
  };
}

/** One step as a line: what was done, to which element, and what it changed. */
function stepLine(s: any): string {
  const a = s.action ?? {};
  const what = a.kind === "input" ? `填写「${a.label ?? a.name ?? ""}」${a.protected ? "（受保护，内容未记录）" : `：${truncate(String(a.value ?? ""), 120)}`}` : a.kind === "click" ? `点击「${a.label ?? a.name ?? ""}」` : a.kind === "enter" ? `在「${a.label ?? a.name ?? ""}」按 Enter` : a.kind === "submit" ? `提交表单「${a.label ?? ""}」` : s.kind === "mark" ? `备注：${a.note ?? ""}` : s.kind;
  const role = a.control?.role ?? a.role;
  const changes = (s.changes ?? []).slice(0, 4).map((c: any) => truncate(typeof c === "string" ? c : JSON.stringify(c), 160));
  const net = (s.network ?? []).slice(0, 4).map((n: any) => `${n.method ?? ""} ${truncate(String(n.url ?? ""), 120)} → ${n.status ?? "?"}`);
  return [`#${s.id} ${what}${role ? `（${role}）` : ""}${a.url ? ` @ ${truncate(String(a.url), 100)}` : ""}`, ...changes.map((c: string) => `   变化：${c}`), ...net.map((n: string) => `   请求：${n}`)].join("\n");
}

/** A desktop step (control-steps) as a line. */
function replayLine(s: any, i: number): string {
  const action = s.action ? JSON.stringify(s.action) : s.check ? `检查${s.check.present ? "出现" : "消失"}` : "";
  return `#${i + 1} ${action} → ${s.locator?.role ?? ""}「${s.locator?.name ?? ""}」${s.input ? `（运行时输入 ${s.input.name}）` : ""}${s.app?.title ? ` @ ${s.app.title}` : s.app?.process ? ` @ ${s.app.process}` : ""}`;
}

/** What read_recording shows: the summary, steps, requests, or the walkthrough aad wrote. */
export function readRecording(app: App, id: string, userId: string, o: { part?: "summary" | "steps" | "requests" | "replay"; from?: number; limit?: number; filter?: string; bodies?: boolean }) {
  const r = getRecording(app, id, userId);
  const part = o.part ?? "summary";
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100);
  const from = Math.max(o.from ?? 1, 1);
  if (part === "summary") {
    const s = r.summary;
    const walkthrough = existsSync(join(r.dir, "walkthrough.md")) ? readFileSync(join(r.dir, "walkthrough.md"), "utf8") : "";
    const replay = readJson(join(r.dir, "record.json"));
    return [
      `录制 ${r.id}（${r.kind === "browser" ? "浏览器" : "桌面窗口"}，${r.status}）`,
      `要做的事：${r.goal || "（没写）"}`,
      `对象：${r.target || "（未知）"}`,
      `动作 ${s.actions ?? 0} 个，可回放 ${s.replayable ?? 0} 步，跳过 ${s.skipped ?? 0} 个，请求 ${s.requests ?? 0} 个，截图 ${s.screenshots ?? 0} 张${s.workflow ? "；有 workflow.yaml" : ""}`,
      r.skill ? `已整理成技能：${r.skill}` : "",
      walkthrough ? `\n## aad 写的操作说明\n\n${truncate(walkthrough, 12_000)}` : replay?.steps?.length ? `\n## 步骤\n\n${replay.steps.slice(0, 60).map(replayLine).join("\n")}` : "",
      replay?.skipped?.length ? `\n## 没能成为步骤的操作\n\n${replay.skipped.slice(0, 20).map((x: any) => `- ${x.reason ?? ""}${x.summary ? `：${typeof x.summary === "string" ? x.summary : JSON.stringify(x.summary)}` : ""}`).join("\n")}` : "",
      "\n用 part=steps 看每一步（带引起的变化和请求），part=requests 看请求，part=replay 看可回放的步骤。",
    ].filter(Boolean).join("\n");
  }
  if (part === "replay") {
    const replay = readJson(join(r.dir, "record.json"));
    const steps: any[] = replay?.steps ?? [];
    if (!steps.length) return "这次录制没有可回放的步骤。";
    return steps.slice(from - 1, from - 1 + limit).map((s, i) => replayLine(s, from - 1 + i)).join("\n") + (steps.length > from - 1 + limit ? `\n……共 ${steps.length} 步，from=${from + limit} 接着看` : "");
  }
  if (part === "steps") {
    const steps = jsonLines(join(r.dir, "steps.jsonl"));
    if (!steps.length) return readRecording(app, id, userId, { part: "replay", from, limit });
    const page = steps.filter((s) => s.id >= from).slice(0, limit);
    return page.map(stepLine).join("\n") + (steps.some((s) => s.id > (page.at(-1)?.id ?? 0)) ? `\n……from=${(page.at(-1)?.id ?? 0) + 1} 接着看` : "");
  }
  const want = (o.filter ?? "").toLowerCase();
  const requests = jsonLines(join(r.dir, "evidence", "network.jsonl")).filter((q) => !want || `${q.method ?? q.request?.method ?? ""} ${q.url ?? q.request?.url ?? ""}`.toLowerCase().includes(want));
  if (!requests.length) return want ? `没有地址或方法包含“${o.filter}”的请求。` : "这次录制没有记下请求。";
  const page = requests.slice(from - 1, from - 1 + limit);
  return page
    .map((q, i) => {
      const req = q.request ?? q;
      const res = q.response ?? q;
      const head = `${from + i}. ${req.method ?? ""} ${truncate(String(req.url ?? ""), 200)} → ${res.status ?? q.status ?? "?"}${q.count > 1 ? ` ×${q.count}` : ""}${q.step_id ? `（第 ${q.step_id} 步）` : ""}${q.id ? ` [${q.id}]` : ""}`;
      if (!o.bodies) return head;
      const body = (v: unknown) => (v == null ? "" : truncate(typeof v === "string" ? v : JSON.stringify(v), 1_500));
      const sent = body(req.body ?? req.post_data ?? req.postData);
      // aad keeps the response body beside request and response.
      const got = body(q.body ?? res.body);
      return [head, sent ? `   请求体：${sent}` : "", got ? `   响应体：${got}` : ""].filter(Boolean).join("\n");
    })
    .join("\n") + (requests.length > from - 1 + limit ? `\n……共 ${requests.length} 个，from=${from + limit} 接着看` : "");
}

/**
 * The files a skill made from this recording carries: the steps that replay it, and the requests it
 * made in a form someone writing an API call can read.
 */
export function skillFilesOf(app: App, id: string, userId: string): Record<string, string> {
  const r = getRecording(app, id, userId);
  const out: Record<string, string> = {};
  const workflow = join(r.dir, "workflow.yaml");
  if (existsSync(workflow)) out["recording/workflow.yaml"] = readFileSync(workflow, "utf8");
  if (existsSync(join(r.dir, "evidence", "network.jsonl"))) {
    const text = readRecording(app, id, userId, { part: "requests", limit: 100, bodies: true });
    out["recording/requests.md"] = `# 录制时的请求\n\n录制 ${r.id}（${r.createdAt.slice(0, 10)}）。cookie、令牌、密码等敏感值已由 aad 替换；请求体和响应体只保留开头。\n\n${text}\n`;
  }
  const walkthrough = join(r.dir, "walkthrough.md");
  if (existsSync(walkthrough) && statSync(walkthrough).size < 200_000) out["recording/walkthrough.md"] = readFileSync(walkthrough, "utf8");
  return out;
}
