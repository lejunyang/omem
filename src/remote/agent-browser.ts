import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { addRunEvent } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { attachAgentPage, closeSession } from "./sessions.ts";

/** Read Chrome's announcement from the profile chosen by the host for this run.
 * Verify the live target's own launch directory over CDP before attaching assist. */
export async function registerAgentBrowser(app: App, opts: {
  root: string; profile: string; pageId: string; userId: string; runId: string; spaceId: string;
}) {
  const dir = join(opts.root, opts.profile);
  const file = join(dir, "DevToolsActivePort");
  if (await realpath(file) !== join(await realpath(opts.root), opts.profile, "DevToolsActivePort"))
    throw new HttpError(403, "浏览器资料必须属于这次运行");
  const f = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  const buf = Buffer.alloc(512);
  try {
    if (!(await f.stat()).isFile()) throw new HttpError(409, "浏览器端口记录无效");
    await f.read(buf);
  } finally { await f.close(); }
  const port = Number(buf.toString().split("\n")[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new HttpError(409, "浏览器没有公布调试端口");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${opts.pageId}`, { handshakeTimeout: 5000, maxPayload: 1 << 20 });
  let sessionId: string | undefined;
  const ended = () => { if (sessionId) void closeSession(app, sessionId); };
  socket.on("error", ended).on("close", ended);
  try {
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => done(false), 5000);
      const done = (valid: boolean) => {
        clearTimeout(timer);
        socket.off("message", message).off("close", closed);
        if (valid) ok(); else fail(new HttpError(409, "页面已关闭或浏览器的资料目录不匹配"));
      };
      const closed = () => done(false);
      const message = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === 1) done(response.result?.arguments?.includes("--user-data-dir=" + resolve(dir)) === true);
        } catch { done(false); }
      };
      socket.on("message", message).once("close", closed).once("open", () =>
        socket.send(JSON.stringify({ id: 1, method: "Browser.getBrowserCommandLine" })));
    });
    const { session, added } = await attachAgentPage(app, { ...opts, port, detach: () => socket.terminate() });
    if (added) {
      sessionId = session.id;
      if (socket.readyState !== WebSocket.OPEN) {
        await closeSession(app, session.id);
        throw new HttpError(409, "浏览器页面已经关闭");
      }
      addRunEvent(app, opts.runId, "status", { text: "已打开远程浏览器", sessionId, link: `#/remote/${sessionId}` });
    }
    return { id: session.id };
  } catch (e) {
    socket.terminate();
    throw e;
  }
}
