import type { ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { AadMcp, aadJson, finalJson, firstJsonLine, spawnAad } from "./aad.ts";
import { createRecording, getRecording, recordingDir, recordingSummary, updateRecording, type Recording } from "./recordings.ts";

/**
 * Remote sessions (docs/v2/remote.md): a browser page or the desktop of this machine, shown and driven
 * through `aad assist`, which omem forwards under /remote/<id>/ (http.ts). They live in memory and end
 * with omem, when closed, or after IDLE without anyone looking. Recordings are kept (recordings.ts).
 */

export type RemoteKind = "browser" | "desktop";

type Live = {
  id: string;
  kind: RemoteKind;
  title: string;
  userId: string;
  createdAt: string;
  /** `aad assist`: where it listens on loopback, and the token every request to it carries. */
  assist: { proc: ChildProcess; port: number; token: string };
  /** What assist shows (its arguments without the picture settings), to start it again with others. */
  source: string[];
  /** Browser sessions: the `aad mcp` that opened the browser, and records and replays on it. */
  mcp?: AadMcp;
  browser?: { name: string; port: number; pageId: string; url: string | null; profile: string | null };
  recording?: { id: string; done?: Promise<any>; proc?: ChildProcess };
  viewers: number;
  idleSince: number;
};

const IDLE_MS = 30 * 60_000;
const live = new Map<string, Live>();
let sweeper: NodeJS.Timeout | null = null;

export const sessionView = (s: Live) => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  createdAt: s.createdAt,
  browser: s.browser ? { name: s.browser.name, url: s.browser.url, profile: s.browser.profile } : null,
  recording: s.recording?.id ?? null,
  viewers: s.viewers,
});

export function listSessions(userId: string) {
  return [...live.values()].filter((s) => s.userId === userId).map(sessionView);
}

export function getSession(id: string, userId?: string): Live {
  const s = live.get(id);
  if (!s || (userId && s.userId !== userId)) throw new HttpError(404, "远程会话已经结束");
  return s;
}

/** What `aad assist` serves for this session, for the proxy. */
export function assistOf(id: string) {
  const s = live.get(id);
  return s ? { port: s.assist.port, token: s.assist.token } : null;
}

/** A viewer connected (+1) or left (-1): sessions nobody looks at end after a while. */
export function viewing(id: string, delta: number) {
  const s = live.get(id);
  if (!s) return;
  s.viewers = Math.max(0, s.viewers + delta);
  s.idleSince = Date.now();
}

/** The address the page should load: the viewer with its token. */
export const viewerPath = (s: Live) => `/remote/${s.id}/?token=${s.assist.token}`;

async function startAssist(args: string[]) {
  const proc = spawnAad(["assist", ...args]);
  const announced = await firstJsonLine(proc, 30_000).catch((e) => {
    proc.kill();
    throw e;
  });
  const port = Number(new URL(String(announced.websocket)).port);
  if (!port || !announced.token) {
    proc.kill();
    throw new HttpError(502, "aad assist 没有说明在哪里监听");
  }
  return { proc, port, token: String(announced.token) };
}

/** The screen going away (the browser closed, the desktop locked) ends the session; a replaced viewer does not. */
function watchAssist(app: App, s: Live) {
  const proc = s.assist.proc;
  proc.on("exit", () => {
    if (s.assist.proc === proc) void closeSession(app, s.id);
  });
}

function add(app: App, s: Omit<Live, "viewers" | "idleSince" | "createdAt" | "id">) {
  const session: Live = { ...s, id: newId("rs"), createdAt: now(), viewers: 0, idleSince: Date.now() };
  live.set(session.id, session);
  watchAssist(app, session);
  sweeper ??= setInterval(() => {
    for (const x of live.values()) if (!x.viewers && Date.now() - x.idleSince > IDLE_MS) void closeSession(app, x.id);
  }, 60_000);
  sweeper.unref();
  return session;
}

/** Long-lived browser profiles under the data directory: a login made once stays. */
export function profileDir(app: App, name: string) {
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(name)) throw new HttpError(400, "资料名只能用文字、数字、下划线和连字符（不超过 40 个字）");
  return join(app.home, "remote", "profiles", name);
}

/** A browser for remote use, without a window on this machine unless asked: it is seen through the viewer. */
export async function openBrowser(app: App, opts: { url?: string; browser?: string; profile?: string; visible?: boolean; viewer?: string[]; userId: string }) {
  if (opts.url && !/^https?:\/\//.test(opts.url)) throw new HttpError(400, "网址要以 http:// 或 https:// 开头");
  const mcp = await new AadMcp(["--allow-input"]).start();
  try {
    const args: Record<string, unknown> = { headless: !opts.visible, ...(opts.url ? { url: opts.url } : {}) };
    if (opts.profile) {
      const dir = profileDir(app, opts.profile);
      mkdirSync(dir, { recursive: true });
      args.profile_dir = dir;
    }
    // The browser asked for, else the first one this machine has.
    let opened: any = null;
    let failure: Error | null = null;
    for (const browser of opts.browser ? [opts.browser] : ["chrome", "edge", "brave"]) {
      try {
        opened = { browser, ...(await mcp.call("browser_open", { ...args, browser }, 90_000)) };
        break;
      } catch (e) {
        failure = e as Error;
      }
    }
    if (!opened) throw failure ?? new HttpError(502, "没能打开浏览器");
    const source = ["--browser-port", String(opened.port), "--page", String(opened.page_id)];
    const assist = await startAssist([...source, ...(opts.viewer ?? [])]);
    const s = add(app, {
      kind: "browser",
      title: opts.url ? new URL(opts.url).host : "浏览器",
      userId: opts.userId,
      assist,
      source,
      mcp,
      browser: { name: opened.browser, port: Number(opened.port), pageId: String(opened.page_id), url: opts.url ?? null, profile: opts.profile ?? null },
    });
    mcp.proc.on("exit", () => void closeSession(app, s.id));
    return s;
  } catch (e) {
    mcp.close();
    throw e;
  }
}

export async function openDesktop(app: App, opts: { monitor?: number; window?: string; viewer?: string[]; userId: string }) {
  const source = ["--desktop", ...(opts.monitor !== undefined ? ["--monitor", String(opts.monitor)] : []), ...(opts.window ? ["--window", opts.window] : [])];
  const assist = await startAssist([...source, ...(opts.viewer ?? [])]);
  return add(app, { kind: "desktop", title: opts.window ? "窗口" : opts.monitor !== undefined ? `显示器 ${opts.monitor + 1}` : "桌面", userId: opts.userId, assist, source });
}

/**
 * Show a session with other picture settings: a new `aad assist` on the same browser page or screen,
 * then the old one stops. The browser, a recording in progress and the session itself carry on; the
 * page loads the new viewer address.
 */
export async function restartViewer(app: App, id: string, userId: string, viewer: string[]) {
  const s = getSession(id, userId);
  const next = await startAssist([...s.source, ...viewer]);
  if (live.get(id) !== s) {
    // The session ended while the new viewer started.
    next.proc.kill();
    throw new HttpError(404, "远程会话已经结束");
  }
  const old = s.assist.proc;
  s.assist = next;
  watchAssist(app, s);
  old.kill();
  return s;
}

export async function closeSession(app: App, id: string) {
  const s = live.get(id);
  if (!s) return;
  live.delete(id);
  if (s.recording) await stopRecording(app, s, { quiet: true }).catch(() => {});
  s.assist.proc.kill();
  // Closing the MCP connection closes the browser it opened (a temporary profile is deleted).
  s.mcp?.close();
}

export async function closeAll(app: App) {
  await Promise.all([...live.keys()].map((id) => closeSession(app, id)));
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/** Displays and windows the desktop can be shared by, and windows a recording can watch. */
export function screens() {
  const listed = aadJson(["assist", "--list-screens"]);
  const apps = aadJson(["apps"]);
  const resources: any[] = apps?.resources ?? [];
  return {
    monitors: listed.monitors ?? [],
    windows: (listed.windows ?? []).filter((w: { minimized?: boolean }) => !w.minimized),
    // What `aad record` can watch: windows and applications the accessibility tree lists.
    recordable: resources.filter((r) => String(r.provider).startsWith("desktop.")).map((r) => ({ resourceId: r.resource_id, name: r.name, process: r.metadata?.process_name ?? null })),
  };
}

// ------------------------------------------------------------------------------------- recording

const workflowName = (id: string) => `omem-${id}`;

export async function startRecording(app: App, sessionId: string, opts: { goal: string; window?: string; conversationId?: string | null; userId: string }): Promise<Recording> {
  const s = getSession(sessionId, opts.userId);
  if (s.recording) throw new HttpError(409, "这个会话正在录制");
  const id = newId("rec");
  const dir = recordingDir(app, id);
  mkdirSync(dir, { recursive: true });
  let target = "";
  if (s.kind === "browser") {
    // Requests are kept with cookies, tokens and passwords replaced: the recording is read by an agent.
    await s.mcp!.call("browser_record_start", { page_id: s.browser!.pageId, record: { redact_network: true, screenshots: true } });
    target = s.browser!.url ?? "";
    s.recording = { id };
  } else {
    if (!opts.window) throw new HttpError(400, "录桌面要选一个窗口：录制按窗口记下点了哪个元素");
    const proc = spawnAad(["record", opts.window, "--until-stdin-closes", "--save", workflowName(id), "--overwrite"]);
    const done = finalJson(proc, 3_700_000);
    // A recording that cannot start (the window closed) says so at once.
    const early = await Promise.race([done.then((v) => ({ v }), (e: Error) => ({ e })), new Promise<null>((r) => setTimeout(() => r(null), 1_500))]);
    if (early && "e" in early) throw early.e;
    target = opts.window;
    s.recording = { id, proc, done };
  }
  return createRecording(app, { id, kind: s.kind, goal: opts.goal, target, dir, conversationId: opts.conversationId ?? null, userId: opts.userId });
}

/** Stop the session's recording and gather it into its directory; the organizing message is the caller's. */
export async function stopRecording(app: App, s: Live, opts: { quiet?: boolean } = {}): Promise<Recording> {
  const rec = s.recording;
  if (!rec) throw new HttpError(409, "这个会话没有在录制");
  s.recording = undefined;
  const dir = recordingDir(app, rec.id);
  try {
    if (s.kind === "browser") {
      const stopped = await s.mcp!.call("browser_record_stop", {}, 120_000);
      if (stopped?.out && existsSync(stopped.out)) cpSync(stopped.out, dir, { recursive: true });
      const converted = aadJson(["browser-record", "steps", "--out", dir, "--save", workflowName(rec.id), "--overwrite"], 120_000);
      keepReplay(dir, converted);
    } else {
      rec.proc!.stdin!.end();
      const recorded = await rec.done!;
      keepReplay(dir, recorded);
    }
    return updateRecording(app, rec.id, { status: "done", summary: recordingSummary(dir), finishedAt: now() });
  } catch (e) {
    if (opts.quiet) rec.proc?.kill();
    return updateRecording(app, rec.id, { status: "failed", summary: { error: (e as Error).message }, finishedAt: now() });
  }
}

/** The replayable steps next to the recording: record.json, and workflow.yaml when any were saved. */
function keepReplay(dir: string, answer: any) {
  writeFileSync(join(dir, "record.json"), JSON.stringify({ steps: answer?.steps ?? [], skipped: answer?.skipped ?? [], count: answer?.count ?? 0 }, null, 2));
  const workflow = answer?.saved?.workflow_path;
  if (workflow && existsSync(workflow)) copyFileSync(workflow, join(dir, "workflow.yaml"));
}

/**
 * Run a recording's steps again. A browser recording runs in the session's browser, after taking its
 * page back to where the recording started; a desktop one runs on this machine's desktop.
 */
export async function replayRecording(app: App, recordingId: string, sessionId: string | null, userId: string) {
  const r = getRecording(app, recordingId, userId);
  const workflow = join(r.dir, "workflow.yaml");
  if (!existsSync(workflow)) throw new HttpError(409, "这次录制没有可回放的步骤");
  let result: any;
  try {
    if (r.kind === "browser") {
      const s = sessionId ? getSession(sessionId, userId) : [...live.values()].find((x) => x.kind === "browser" && x.userId === userId);
      if (!s?.mcp) throw new HttpError(409, "回放浏览器录制要先打开一个浏览器会话");
      const first = (r.summary.firstPage as string | undefined) ?? r.target;
      if (first) await goTo(s, first);
      result = await s.mcp.call("run_workflow", { name: workflowName(r.id) }, 300_000);
    } else {
      result = aadJson(["run", workflow, "--permission", "desktop.input", "--permission", "desktop.observe"], 300_000);
    }
    return updateRecording(app, r.id, { replay: { at: now(), ok: true, result } });
  } catch (e) {
    return updateRecording(app, r.id, { replay: { at: now(), ok: false, error: (e as Error).message } });
  }
}

/** The address bar the viewer does not have: take a browser session's page somewhere. */
export async function navigate(sessionId: string, url: string, userId: string) {
  const s = getSession(sessionId, userId);
  if (s.kind !== "browser") throw new HttpError(400, "只有浏览器会话有地址");
  if (!/^https?:\/\//.test(url)) throw new HttpError(400, "网址要以 http:// 或 https:// 开头");
  await goTo(s, url);
  s.browser!.url = url;
  s.title = new URL(url).host;
  return sessionView(s);
}

/** Take the session's page to `url` and wait until it has loaded. */
async function goTo(s: Live, url: string) {
  const mcp = s.mcp!;
  const targets = await mcp.call("control_targets", {});
  const page = (targets.resources ?? []).find((r: any) => r.metadata?.page_id === s.browser!.pageId && r.metadata?.main_frame === true);
  if (!page) throw new HttpError(409, "找不到会话里的页面");
  const observed = await mcp.call("control_observe", { resource_id: page.resource_id, max_nodes: 20 });
  const doc = (observed.nodes ?? []).find((n: any) => n.role === "document");
  if (!doc) throw new HttpError(409, "读不到页面");
  await mcp.call("control_act", { target: doc.target, action: { type: "navigate", url } }, 60_000);
}
