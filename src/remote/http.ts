import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { can } from "../auth/permissions.ts";
import { changeGrant } from "./grants.ts";
import { ask } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { desktopControl } from "../core/tools.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { attachRecording, getDemo, listDemos, requireDemo, startDemo, stopDemo } from "./demos.ts";
import { importRecording, importSchema } from "./import.ts";
import { fromExtension, getRecording, listRecordings, markInterrupted, readRecording, updateRecording, type Recording } from "./recordings.ts";
import { browserProfiles, browserWindowAvailable, closeAll, closeSession, getSession, listSessions, navigate, openBrowser, openDesktop, restartViewer, screens, sessionView, startRecording, stopRecording, viewerAccess, viewerPath } from "./sessions.ts";
import { cachedProbe, probeRunning, probeVideo, readSettings, remoteSettingsSchema, saveSettings, viewerArgs } from "./settings.ts";

import { REMOTE_BASE, proxyHttp, viewerCookie } from "./proxy.ts";
export { REMOTE_BASE, attachRemoteUpgrade } from "./proxy.ts";

/** One person's long-lived profiles (sessions.ts profileDir): the owner's, or those under `@<user>`. */
const profiles = (app: App, userId: string) => {
  const dir = userId === OWNER ? join(app.home, "remote", "profiles") : join(app.home, "remote", "profiles", `@${userId}`);
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("@")).map((d) => d.name) : [];
};
/** This machine's own browsers carry the owner's logins: only the owner starts from a copy of them. */
const ownerOnly = (userId: string) => {
  if (userId !== OWNER) throw new HttpError(403, "只有本人能用这台机器上浏览器的登录");
};

/** The message that hands a finished recording to the assistant in the page's conversation. */
export function organizeText(r: Recording, about?: { item?: { id: string; title: string } }) {
  const s = r.summary;
  if (r.status === "failed") return `刚才的录制（${r.id}）没有完成：${String(s.error ?? "原因不明")}。`;
  const ext = fromExtension(r);
  const what = ext ? `我自己的 Chrome 里（从 ${r.target || "当前页面"} 开始）` : r.kind === "browser" ? `浏览器（${r.target || "页面"}）` : `窗口（${r.target}）`;
  return [
    `我录好了要教你的操作（录制 ${r.id}，在${what}）：${r.goal || "见对话里我说的"}。`,
    `一共 ${s.actions ?? 0} 个动作${s.marks ? `、${s.marks} 处我加的标记（说明那里看的是什么）` : ""}${s.requests ? `，记下 ${s.requests} 个请求` : ""}${ext && s.requests && !s.responseBodies ? "（没开 DevTools 面板，没有响应体）" : ""}。录的时候可能有试错和多余的操作，请只留下真正完成这件事的步骤和接口。`,
    about?.item ? `这次录的是事项「${about.item.title}」（${about.item.id}）里要做的事。` : "",
    "请按技能 skill-from-recording 看这次录制，先跟我确认流程、每次会变的值和成功的标志，再保存成技能。",
  ].filter(Boolean).join("\n");
}

async function organize(app: App, r: Recording, userId: string, conversationId?: string | null, about?: Parameters<typeof organizeText>[1]) {
  const sent = await ask(app, { text: organizeText(r, about), conversationId: conversationId ?? r.conversationId ?? undefined, userId });
  updateRecording(app, r.id, { conversationId: sent.conversationId });
  return sent;
}

export function registerRemoteRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  markInterrupted(app);
  const q = <T>(schema: z.ZodType<T>, v: unknown): T => {
    const r = schema.safeParse(v ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const view = (s: ReturnType<typeof getSession>, reply: FastifyReply, userId: string) => {
    const access = viewerAccess(app, s, userId);
    reply.header("set-cookie", viewerCookie(app, s.id, userId, access)).header("cache-control", "no-store");
    return { ...sessionView(s), src: access.grantId ? `/remote/${s.id}/?token=viewer&lang=zh` : viewerPath(s) };
  };

  // Whether the page is offered at all: aad installed on this machine.
  server.get("/api/remote", async (req) => {
    const status = desktopControl.status();
    return { available: status.installed, version: status.version, sessions: listSessions(app, who(req)), profiles: can(app, who(req), "desktop.control") ? profiles(app, who(req)) : [], windowAvailable: browserWindowAvailable() };
  });
  const grantFields = z.object({ mode: z.enum(["view", "operate"]), hours: z.number().positive().optional() });
  server.post("/api/remote/sessions/:id/grants", async req => {
    const { id } = req.params as { id: string };
    return changeGrant(app, getSession(id), who(req), q(grantFields.extend({ userId: z.string().min(1) }), req.body));
  });
  server.patch("/api/remote/sessions/:id/grants/:grantId", async req => {
    const { id, grantId } = req.params as { id: string; grantId: string };
    return changeGrant(app, getSession(id), who(req), q(grantFields.partial().strict().refine(b => b.mode || b.hours), req.body), grantId);
  });
  server.delete("/api/remote/sessions/:id/grants/:grantId", async req => {
    const { id, grantId } = req.params as { id: string; grantId: string };
    return changeGrant(app, getSession(id), who(req), null, grantId);
  });
  server.get("/api/remote/screens", async () => screens());
  // This machine's own browser profiles, whose logins a session can start from a copy of.
  server.get("/api/remote/browser-profiles", async (req) => (ownerOnly(who(req)), browserProfiles()));
  // How sessions are shown: each user's picture settings, and which video codecs work here.
  server.get("/api/remote/settings", async (req) => ({ settings: readSettings(app, who(req)), video: cachedProbe(app), probing: probeRunning() }));
  server.put("/api/remote/settings", async (req) => saveSettings(app, who(req), q(remoteSettingsSchema.partial(), req.body)));
  server.post("/api/remote/settings/probe", async () => probeVideo(app));
  server.post("/api/remote/sessions", async (req, reply) => {
    const b = q(z.object({
      kind: z.enum(["browser", "desktop"]),
      url: z.string().max(2048).optional(),
      browser: z.enum(["chrome", "edge", "brave"]).optional(),
      profile: z.string().max(40).optional(),
      copyFrom: z.object({ browser: z.enum(["chrome", "edge", "brave"]), id: z.string().min(1).max(100) }).optional(),
      closeRunning: z.boolean().optional(),
      visible: z.boolean().optional(),
      monitor: z.number().int().min(0).optional(),
      window: z.string().max(200).optional(),
      title: z.string().max(200).optional(),
    }), req.body);
    const userId = who(req);
    if (b.copyFrom) ownerOnly(userId);
    const settings = readSettings(app, userId);
    const viewer = viewerArgs(settings, b.kind, cachedProbe(app));
    const s = b.kind === "browser"
      ? await openBrowser(app, { url: b.url || undefined, browser: b.browser ?? (settings.browser || undefined), profile: b.profile || undefined, copyFrom: b.copyFrom, closeRunning: b.closeRunning, visible: b.visible, viewer, userId })
      : await openDesktop(app, { monitor: b.monitor, window: b.window, title: b.title?.slice(0, 60), viewer, userId });
    return view(s, reply, userId);
  });
  server.post("/api/remote/sessions/:id/view", async (req, reply) => view(getSession((req.params as { id: string }).id), reply, who(req)));
  // The session's viewer again, with the settings as they are now.
  server.post("/api/remote/sessions/:id/viewer", async (req, reply) => {
    const userId = who(req);
    const s = getSession((req.params as { id: string }).id, userId);
    return view(await restartViewer(app, s.id, userId, viewerArgs(readSettings(app, userId), s.kind, cachedProbe(app))), reply, userId);
  });
  server.post("/api/remote/sessions/:id/navigate", async (req) => navigate((req.params as { id: string }).id, q(z.object({ url: z.string().min(1).max(2048) }), req.body).url, who(req)));
  server.delete("/api/remote/sessions/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    getSession(id, who(req));
    await closeSession(app, id);
    return { ok: true };
  });
  server.post("/api/remote/sessions/:id/recording", async (req) => {
    const b = q(z.object({ goal: z.string().max(2000).default(""), window: z.string().max(200).optional(), conversationId: z.string().optional() }), req.body);
    return startRecording(app, (req.params as { id: string }).id, { ...b, userId: who(req) });
  });
  // Stopping hands the recording to the assistant in the page's conversation (organize).
  server.delete("/api/remote/sessions/:id/recording", async (req) => {
    const o = q(z.object({ conversationId: z.string().optional(), organize: z.enum(["0", "1"]).default("1") }), req.query);
    const userId = who(req);
    const r = await stopRecording(app, getSession((req.params as { id: string }).id, userId));
    if (o.organize === "0") return { recording: r, conversationId: r.conversationId };
    const sent = await organize(app, r, userId, o.conversationId);
    return { recording: getRecording(app, r.id), conversationId: sent.conversationId };
  });
  server.get("/api/remote/recordings", async (req) => listRecordings(app, who(req)));
  // A recording made in the owner's own Chrome by the omem extension (import.ts): kept, then handed to
  // the assistant like a stopped one, in a 关注's conversation when one is named.
  server.post("/api/remote/recordings/import", async (req) => {
    const b = q(importSchema, req.body);
    const userId = who(req);
    // Made during a demonstration: it goes on that timeline and waits for the demonstration's stop.
    if (b.demoId) {
      const demo = requireDemo(app, b.demoId, userId);
      const r = importRecording(app, userId, { ...b, conversationId: demo.conversationId });
      attachRecording(app, demo.id, r, b.startedAt ?? null, userId);
      return { recording: getRecording(app, r.id), conversationId: demo.conversationId, demoId: demo.id };
    }
    const context = b.contextId ? (await import("../channels/listen.ts")).requireContext(app, b.contextId) : null;
    const item = b.itemId ? (await import("../items/store.ts")).getItem(app, b.itemId) : null;
    const r = importRecording(app, userId, b);
    if (!b.organize) return { recording: r, conversationId: null };
    const sent = await organize(app, r, userId, b.conversationId ?? context?.conversationId, item ? { item: { id: item.id, title: item.title } } : undefined);
    return { recording: getRecording(app, r.id), conversationId: sent.conversationId };
  });
  // Demonstrations (demos.ts): the owner shows how a piece of work goes; one at a time.
  server.get("/api/demos", async (req) => listDemos(app, who(req)));
  server.post("/api/demos", async (req) => {
    const b = q(z.object({ goal: z.string().max(2000), contextId: z.string().max(100).nullable().optional(), itemId: z.string().max(100).nullable().optional() }), req.body);
    return startDemo(app, who(req), b);
  });
  server.get("/api/demos/:id", async (req) => getDemo(app, (req.params as { id: string }).id, who(req)));
  server.post("/api/demos/:id/stop", async (req) => {
    const b = q(z.object({ organize: z.enum(["skill", "lessons", "none"]).default("skill") }), req.body);
    return stopDemo(app, who(req), (req.params as { id: string }).id, b.organize);
  });
  server.get("/api/remote/recordings/:id", async (req) => {
    const r = getRecording(app, (req.params as { id: string }).id, who(req));
    return { ...r, text: readRecording(app, r.id, who(req), { part: "summary" }) };
  });
  server.post("/api/remote/recordings/:id/organize", async (req) => {
    const b = q(z.object({ conversationId: z.string().optional() }), req.body);
    const r = getRecording(app, (req.params as { id: string }).id, who(req));
    const sent = await organize(app, r, who(req), b.conversationId);
    return { conversationId: sent.conversationId };
  });

  // The viewer itself, raw: no body parsing, the check above instead of the /api auth hook.
  return server.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", (_req, _payload, done) => done(null));
    const pass = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      proxyHttp(app, req.raw, reply.raw);
    };
    raw.all(`${REMOTE_BASE}/:id`, pass);
    raw.all(`${REMOTE_BASE}/:id/*`, pass);
  });
}

export const closeRemote = closeAll;
