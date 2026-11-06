import type { FastifyRequest } from "fastify";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { aliasTarget } from "../sources/duplicates.ts";
import { can, canReadRun, isOwner, requirePerm, type GlobalPerm, type SpacePerm } from "./permissions.ts";
import { requireReadable } from "./visibility.ts";

/**
 * What each API route needs (docs/v2/multi-user.md, “在哪里检查”), checked in one place after the
 * body is parsed. Keyed by the route as registered (`GET /api/wiki/:space`). `test/route-perms.test.ts`
 * requires every /api route to be listed; one that is not is the owner's only.
 *
 * - `public`: no login (logging in itself, a share link, tool routes with a run's own token).
 * - `self`: anyone logged in and approved; the handler keeps to their own data and readable spaces.
 * - `owner`: the owner only (the owner's own learning, the start page).
 * - `{ g }`: a global permission.
 * - `{ s, at }`: a permission in the space found at `at`: `p.id` / `q.space` / `b.space` (route
 *   param, query, body) or through what the id names: `src:p.id` (a source), `mem:p.id` (a memory),
 *   `note:p.id` (a note on a source).
 * - `{ run }`: the run in `:id` must be one the user may read (permissions.ts canReadRun).
 */
export type RouteRule = "public" | "self" | "owner" | { g: GlobalPerm } | { s: SpacePerm; at: string } | { run: "read" };

const g = (perm: GlobalPerm): RouteRule => ({ g: perm });
const s = (perm: SpacePerm, at: string): RouteRule => ({ s: perm, at });
const RUN: RouteRule = { run: "read" };
const AGENTS = g("agents.manage");
const SETTINGS = g("settings.manage");
const CODE = g("code.delegate");
const PEERS = g("peers.manage");
const USERS = g("users.manage");

export const ROUTE_RULES: Record<string, RouteRule> = {
  "GET /api/share/:token": "public",
  "GET /api/shares": "self",
  "DELETE /api/shares/:id": "self",
  "GET /api/me": "self",
  "GET /api/tools": "public",
  "POST /api/tools/:name": "public",
  "GET /api/events": "self",

  // spaces
  "GET /api/spaces": "self",
  "POST /api/spaces": g("spaces.create"),
  "GET /api/spaces/:id": s("space.read", "p.id"),
  "PATCH /api/spaces/:id": s("space.manage", "p.id"),
  "POST /api/spaces/:id/parent": s("space.manage", "p.id"),
  "GET /api/spaces/:id/repo-suggestions": s("space.manage", "p.id"),
  "POST /api/spaces/:id/related": s("space.manage", "p.id"),
  "DELETE /api/spaces/:id/related/:other": s("space.manage", "p.id"),
  "GET /api/spaces/:id/members": s("space.manage", "p.id"),
  "PUT /api/spaces/:id/members/:user": s("space.manage", "p.id"),
  "POST /api/spaces/:id/sync": s("source.write", "p.id"),
  "GET /api/spaces/:id/workspaces": CODE,
  "POST /api/spaces/:id/relink": CODE,
  "GET /api/spaces/:id/branches": s("space.read", "p.id"),
  "POST /api/spaces/:id/branches/index": s("source.write", "p.id"),
  "DELETE /api/spaces/:id/branches/index": s("source.write", "p.id"),

  // sources
  "GET /api/sources": s("space.read", "q.space"),
  "GET /api/sources/levels": "self",
  "GET /api/sources/review": "self",
  "GET /api/sources/tree": "self",
  "GET /api/sources/paths": s("space.read", "q.space"),
  "GET /api/sources/resolve": s("space.read", "q.space"),
  "PUT /api/sources/:id/attention": s("source.write", "src:p.id"),
  "POST /api/sources/attention": AGENTS,
  "GET /api/sources/:id/notes": s("space.read", "src:p.id"),
  "POST /api/sources/:id/notes": s("source.write", "src:p.id"),
  "POST /api/source-notes/:id/review": s("source.write", "note:p.id"),
  "DELETE /api/source-notes/:id": s("source.write", "note:p.id"),
  "POST /api/sources/node-level/review": s("source.write", "b.space"),
  "PUT /api/sources/node-level": s("source.write", "b.space"),
  "PUT /api/sources/wiki-space-name": SETTINGS,
  "GET /api/sources/:id": s("space.read", "src:p.id"),
  "GET /api/sources/:id/messages": s("space.read", "src:p.id"),
  "GET /api/sources/:id/relations": s("space.read", "src:p.id"),
  "GET /api/sources/:id/archive": s("space.read", "src:p.id"),
  "DELETE /api/sources/:id": s("source.write", "src:p.id"),
  "PUT /api/sources/:id/visibility": s("space.manage", "src:p.id"),
  "POST /api/sources/:id/move": AGENTS,
  "POST /api/sources/text": s("source.write", "b.space"),
  "POST /api/sources/url": s("source.write", "b.space"),
  "POST /api/sources/upload": s("source.write", "q.space"),
  "GET /api/lark/messages/:mid/resources/:key": SETTINGS,
  "GET /api/messages/:id": "self",
  // Stored originals are named by their content hash: knowing the name is having the file.
  "GET /api/files/:name": "self",
  "GET /api/lookup": "self",
  "GET /api/search": "self",
  "GET /api/graph": s("space.read", "q.space"),

  // asking and conversations (one's own)
  "POST /api/ask": "self",
  // voice (core/voice.ts): one's own conversations; tools run in the spaces the user can read
  "GET /api/voice": "self",
  "POST /api/voice/realtime/secret": "self",
  "POST /api/voice/live/sdp": "self",
  "POST /api/voice/transcribe": "self",
  "POST /api/voice/tool": "self",
  "GET /api/voice/sessions": "self",
  "POST /api/voice/sessions": "self",
  "GET /api/conversations": "self",
  "GET /api/conversations/:id": "self",
  "DELETE /api/conversations/:id": "self",
  "GET /api/asks": "self",
  "GET /api/asks/:id": "self",
  "POST /api/asks/:id/answer": "self",
  "GET /api/notifications": "self",
  "POST /api/notifications/read": "self",

  // wiki
  "GET /api/wiki/:space": s("space.read", "p.space"),
  "GET /api/wiki/:space/page/*": s("space.read", "p.space"),
  "PUT /api/wiki/:space/page/*": s("wiki.write", "p.space"),
  "DELETE /api/wiki/:space/page/*": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/plan": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/write": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/lint": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/move": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/organize": s("wiki.write", "p.space"),

  // memories
  // Without a space: what this person can read (the handler narrows it).
  "GET /api/memories": "self",
  "GET /api/memories/:id": s("space.read", "mem:p.id"),
  "POST /api/memories": s("memory.write", "b.space"),
  "POST /api/memories/:id/supersede": s("memory.write", "mem:p.id"),
  "PATCH /api/memories/:id": s("memory.write", "mem:p.id"),
  "DELETE /api/memories/:id": s("memory.write", "mem:p.id"),
  "GET /api/memory-folders": "self",
  "POST /api/memory-folders": s("memory.write", "b.space"),
  "PATCH /api/memory-folders": s("memory.write", "b.space"),
  "DELETE /api/memory-folders": s("memory.write", "q.space"),
  "POST /api/memory-folders/move": s("memory.write", "b.space"),
  "POST /api/memory-folders/organize": s("memory.write", "b.space"),
  "GET /api/memory-tags": "self",
  "GET /api/memory-recall-stats": AGENTS,
  "GET /api/shortcomings": AGENTS,
  "GET /api/dream/status": AGENTS,
  "GET /api/memory-quality": AGENTS,

  // items and requirements (the handlers check whose item it is)
  "GET /api/items": "self",
  "POST /api/items": "self",
  "GET /api/items/:id": "self",
  "PATCH /api/items/:id": "self",
  "POST /api/items/:id/keep": "self",
  "POST /api/items/:id/materials": "self",
  "DELETE /api/items/:id/materials/:mid": "self",
  "POST /api/items/:id/split-requirements": "self",
  "GET /api/items-expiry": "self",
  "POST /api/items-expiry/backlog": AGENTS,
  "POST /api/items-expiry/sweep": AGENTS,
  "GET /api/requirements": "self",
  "GET /api/requirements/:id": "self",
  "POST /api/requirements": s("memory.write", "b.space"),

  // runs
  "GET /api/runs": "self",
  "GET /api/runs/:id": RUN,
  "POST /api/runs/:id/cancel": RUN,
  "POST /api/runs/:id/retry": RUN,
  "GET /api/runs/:id/folders": CODE,
  "GET /api/code-runs/at": CODE,
  "GET /api/code-works": CODE,
  "GET /api/code-works/:id": CODE,
  "POST /api/delegate": CODE,
  "POST /api/review-branch": CODE,
  "GET /api/review-settings": CODE,
  "PUT /api/review-settings": CODE,
  "GET /api/review-options": CODE,
  "GET /api/ide/cli": CODE,
  "GET /api/ide/open": CODE,
  ...Object.fromEntries(
    [
      "POST code-here", "GET apply-targets", "POST apply", "GET branch", "POST branch", "POST sync", "GET git", "POST git", "POST move-to-target", "POST discard",
      "GET tasks", "POST tasks", "POST review-again", "POST tasks/:seq", "POST revert", "POST work", "GET file-at", "GET task-diff", "GET reviews", "GET latest-state",
      "PUT findings/:fid", "PUT findings/:fid/suggestion", "GET inherited-split", "PUT findings-fixed", "POST change-points", "GET same-branch", "POST fix", "POST notes",
      "PUT round-review", "GET file", "GET file/raw", "GET blob",
    ].map((r) => {
      const [m, p] = r.split(" ");
      return [`${m} /api/runs/:id/${p}`, CODE];
    }),
  ),

  // the owner's own learning, and the start page that gathers everything
  "GET /api/cards": "owner",
  "POST /api/cards": "owner",
  "POST /api/cards/:id/review": "owner",
  "PATCH /api/cards/:id": "owner",
  "GET /api/cards/export.txt": "owner",
  "POST /api/cards/import": "owner",
  "GET /api/learn/goals": "owner",
  "POST /api/learn/goals": "owner",
  "POST /api/learn/generate": "owner",
  "GET /api/home": "owner",

  // agents, skills, rules and schedules: shared by everyone, managed by a few
  ...Object.fromEntries(
    [
      "GET /api/agents", "GET /api/agents/:name", "PUT /api/agents/:name", "DELETE /api/agents/:name", "GET /api/agents/load", "DELETE /api/agents/quota/:source",
      "GET /api/roles", "GET /api/roles/:name", "PUT /api/roles/:name", "PUT /api/roles/:name/defaults", "POST /api/roles/:name/customize", "POST /api/roles/:name/reset", "POST /api/roles/:name/merge",
      "GET /api/profile-options", "PUT /api/profiles/:name/skills", "POST /api/profiles/:name/review", "POST /api/profile-proposals/:id/apply", "POST /api/profile-proposals/:id/reject",
      "GET /api/library-files/:kind/:name", "PUT /api/library-files/:kind/:name",
      "GET /api/skills", "GET /api/skills/:name", "PUT /api/skills/:name", "DELETE /api/skills/:name", "GET /api/skills/:name/files", "GET /api/skills/:name/file", "PUT /api/skills/:name/file", "DELETE /api/skills/:name/file",
      "GET /api/rules", "GET /api/rules/:id", "GET /api/rules/:id/permissions", "POST /api/rules", "PUT /api/rules/:id", "DELETE /api/rules/:id", "POST /api/rules/draft", "POST /api/rules/test",
      "GET /api/rule-options", "POST /api/rule-conversations", "GET /api/wakes", "DELETE /api/wakes/:id", "GET /api/watches", "DELETE /api/watches/:chatId",
      "GET /api/notify-ignore-rules", "POST /api/notify-ignore-rules/delete", "GET /api/schedules", "PUT /api/schedules/:id", "POST /api/schedules/:id/run",
      "GET /api/archive-rules", "GET /api/archive-options", "POST /api/archive-rules", "PUT /api/archive-rules/order", "PUT /api/archive-rules/:id", "DELETE /api/archive-rules/:id", "POST /api/archive-rules/draft",
      "GET /api/archive/folders", "POST /api/archive/folders", "POST /api/archive/preview", "POST /api/archive/apply", "POST /api/archive/classify",
      "GET /api/attention-rules", "PUT /api/attention-rules/:id", "DELETE /api/attention-rules/:id", "POST /api/attention-rules/apply",
      "GET /api/digest-jobs", "POST /api/digest-jobs", "POST /api/digest-jobs/:id/:action", "PUT /api/digest-jobs/:id",
      "GET /api/feedback/stats", "GET /api/replays", "POST /api/replays/run", "POST /api/replay-effects/:id/:action",
    ].map((r) => [r, AGENTS]),
  ),

  // channels, AI backends and this machine
  ...Object.fromEntries(
    [
      "GET /api/settings", "PUT /api/settings", "GET /api/ai", "PUT /api/ai/keys/:id", "POST /api/ai/providers/:id/test", "POST /api/ai/decision/test", "GET /api/lark/chats", "GET /api/lark/captured", "POST /api/lark/chats/:id/backfill", "POST /api/lark/fill-files", "GET /api/lark/fill-files",
      "PUT /api/lark/chats/:id/policy", "GET /api/lark/subscriptions", "PUT /api/lark/subscriptions", "POST /api/lark/poll", "GET /api/lark/user-permissions", "POST /api/lark/user-permissions",
      "GET /api/lark/bot-check", "POST /api/lark/bot-check/:ref/scan", "GET /api/lark/wiki-crawls", "POST /api/lark/wiki-crawls/:id/:op", "GET /api/lark/kb", "POST /api/lark/kb/discover",
      "POST /api/lark/kb/read", "PUT /api/lark/kb/settings", "POST /api/lark/kb/:id", "POST /api/agents/:id/probe", "PUT /api/agent-role-model", "GET /api/agent-registry", "POST /api/agent-registry/:id",
      "GET /api/diag", "GET /api/storage", "POST /api/storage/scan", "GET /api/media", "POST /api/media/ffmpeg/install", "POST /api/media/compress", "POST /api/media/stop", "POST /api/media/resume",
      "POST /api/media/delete-originals", "PUT /api/plugins/:id/settings", "PUT /api/plugins/:id/icon", "POST /api/plugins/:id/trust", "DELETE /api/plugins/:id/trust", "GET /api/plugins/:id/services",
      "POST /api/plugins/:id/services/:name/start", "POST /api/plugins/:id/services/:name/stop",
    ].map((r) => [r, SETTINGS]),
  ),
  "GET /api/desktop": g("desktop.control"),
  "POST /api/desktop/install": g("desktop.control"),
  // remote operation (docs/v2/remote.md): each person's own sessions and recordings
  "GET /api/remote": g("desktop.control"),
  "GET /api/remote/screens": g("desktop.control"),
  "GET /api/remote/browser-profiles": g("desktop.control"),
  "POST /api/remote/sessions": g("desktop.control"),
  "POST /api/remote/sessions/:id/view": g("desktop.control"),
  "POST /api/remote/sessions/:id/viewer": g("desktop.control"),
  "GET /api/remote/settings": g("desktop.control"),
  "PUT /api/remote/settings": g("desktop.control"),
  "POST /api/remote/settings/probe": g("desktop.control"),
  "POST /api/remote/sessions/:id/navigate": g("desktop.control"),
  "DELETE /api/remote/sessions/:id": g("desktop.control"),
  "POST /api/remote/sessions/:id/recording": g("desktop.control"),
  "DELETE /api/remote/sessions/:id/recording": g("desktop.control"),
  "GET /api/remote/recordings": g("desktop.control"),
  "GET /api/remote/recordings/:id": g("desktop.control"),
  "POST /api/remote/recordings/:id/organize": g("desktop.control"),
  "POST /api/remote/recordings/:id/replay": g("desktop.control"),

  // plugins: each person's own sessions and records
  "GET /api/plugins": "self",
  "GET /api/plugins/:id": "self",
  "GET /api/plugins/:id/sessions": "self",
  "POST /api/plugins/:id/sessions": "self",
  "GET /api/plugins/:id/sessions/:cid": "self",
  "POST /api/plugins/:id/sessions/:cid/messages": "self",
  "POST /api/plugins/:id/blocks/:bid/submit": "self",
  "GET /api/plugins/:id/settings": "self",
  "GET /api/plugins/:id/data/:collection": "self",
  "POST /api/plugins/:id/call/:tool": "self",

  // devices
  ...Object.fromEntries(
    [
      "GET /api/peer/commands", "POST /api/peer/exec", "GET /api/peer/tools", "POST /api/peer/tool", "GET /api/peer/snapshot", "GET /api/peer/files", "POST /api/peer/files", "GET /api/peers", "POST /api/peer/invite", "POST /api/peer/add",
      "PATCH /api/peers/:id", "DELETE /api/peers/:id", "GET /api/peers/:id/status", "POST /api/peer/agents", "POST /api/peer/unpair", "DELETE /api/peer/paired/:id", "GET /api/peers/:id/api/ide/open",
      // Forwarded to a device as they are, any method.
      "* /api/peers/:id/*", "* /api/peers/:id/ide", "* /api/peers/:id/ide/*", "* /api/peers/:id/remote/*",
      // Sharing with other servers (src/core/federation.ts): what this one shares, what it follows.
      "GET /api/peer/shares", "POST /api/peer/shares", "PUT /api/peer/shares/:user", "DELETE /api/peer/shares/:user",
      "GET /api/peer/subscriptions", "GET /api/peer/offers/:peer", "POST /api/peer/subscriptions", "DELETE /api/peer/subscriptions/:id", "POST /api/peer/subscriptions/:id/sync",
    ].map((r) => [r, PEERS]),
  ),
  // Another server reading what is shared with it: the handlers keep to the caller's grants.
  "GET /api/fed/info": "self",
  "POST /api/fed/search": "self",
  "GET /api/fed/source/:id": "self",
  "GET /api/fed/changes": "self",

  // logging in, one's account, and managing people
  "GET /api/auth/session": "public",
  "GET /api/auth/:provider/start": "public",
  "GET /api/auth/:provider/callback": "public",
  "GET /api/auth/link/:code": "public",
  "POST /api/auth/link/:code": "public",
  "POST /api/auth/logout": "public",
  "GET /api/auth/account": "self",
  "GET /api/auth/connections": "self",
  "DELETE /api/auth/connections/:provider": "self",
  "PUT /api/auth/connections/:provider/features/:feature": "self",
  "POST /api/auth/connections/:provider/credentials": "self",
  "DELETE /api/auth/sessions/:id": "self",
  "DELETE /api/auth/identities": "self",
  "GET /api/auth/providers": USERS,
  "PUT /api/auth/providers/:id/app": USERS,
  "GET /api/users": USERS,
  "PATCH /api/users/:id": USERS,
  "DELETE /api/users/:id/sessions": USERS,
  "DELETE /api/users/:id/identities": USERS,
  "PUT /api/users/:id/spaces": USERS,
  "GET /api/invites": USERS,
  "POST /api/invites": USERS,
  "DELETE /api/invites/:id": USERS,
  "GET /api/access/roles": "self",
  "POST /api/access/roles": USERS,
  "PUT /api/access/roles/:id": USERS,
  "DELETE /api/access/roles/:id": USERS,
  "GET /api/access/audit": USERS,
};

/** The space a rule's `at` points to for this request. */
function locate(app: App, req: FastifyRequest, at: string): string | null {
  const [through, where] = at.includes(":") ? at.split(":") : [null, at];
  const [from, key] = where.split(".");
  const bag = (from === "p" ? req.params : from === "q" ? req.query : req.body) as Record<string, unknown> | null;
  const value = bag?.[key];
  if (typeof value !== "string" || !value) return null;
  if (!through) return value;
  if (through === "src") return one<{ space_id: string }>(app.db, "select space_id from sources where id = ?", aliasTarget(app, value) ?? value)?.space_id ?? null;
  if (through === "mem") return one<{ space_id: string }>(app.db, "select space_id from memories where id = ?", value)?.space_id ?? null;
  if (through === "note") return one<{ space_id: string }>(app.db, "select s.space_id from source_notes n join sources s on s.id = n.source_id where n.id = ?", Number(value))?.space_id ?? null;
  return null;
}

export const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;

/**
 * Throws when this user may not use this route. The owner may use every one. A source a route names
 * must also be one this person may read (restricted ones, Feishu access: src/auth/visibility.ts).
 */
export async function checkRoute(app: App, req: FastifyRequest, userId: string) {
  if (isOwner(app, userId)) return;
  const rule = ROUTE_RULES[routeKey(req)] ?? ROUTE_RULES[`* ${req.routeOptions.url}`];
  if (!rule) throw new HttpError(403, "这个接口只对 omem 的主人开放");
  if (rule === "public" || rule === "self") return;
  if (rule === "owner") throw new HttpError(403, "这个接口只对 omem 的主人开放");
  if ("g" in rule) return requirePerm(app, userId, rule.g);
  if ("run" in rule) {
    if (!canReadRun(app, userId, String((req.params as { id?: string }).id ?? ""))) throw new HttpError(404, "运行不存在");
    return;
  }
  const space = locate(app, req, rule.at);
  if (!space) throw new HttpError(rule.at.includes(":") ? 404 : 400, rule.at.includes(":") ? "要找的内容不存在" : "要指定空间");
  if (!can(app, userId, rule.s, space)) requirePerm(app, userId, rule.s, space);
  if (rule.at.startsWith("src:")) {
    const id = String((req.params as { id?: string }).id ?? "");
    await requireReadable(app, userId, aliasTarget(app, id) ?? id);
  }
}
