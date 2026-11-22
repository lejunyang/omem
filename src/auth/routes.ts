import { ownerControls } from "./settings-sections.ts";
import { requireMemberAction, type MemberAction } from "./member-management.ts";
import { capabilityAccess, spacesWithCapability, globalCapability, type Capability } from "./capabilities.ts";
import type { FastifyRequest } from "fastify";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { aliasTarget } from "../sources/duplicates.ts";
import { can, canAccessRun, runAudience, canReadRun, isOwner, requirePerm, type GlobalPerm, type SpacePerm } from "./permissions.ts";
import { requireReadable, sourceReadable } from "./visibility.ts";

/**
 * What each API route needs (docs/v2/multi-user.md, “在哪里检查”), checked in one place after the
 * body is parsed. Keyed by the route as registered (`GET /api/wiki/:space`). `test/route-perms.test.ts`
 * requires every /api route to be listed; one that is not is the owner's only.
 *
 * - `public`: no login (logging in itself, a share link, tool routes with a run's own token).
 * - `self`: anyone logged in and approved; the handler keeps to their own data and readable spaces.
 * - `owner`: the owner only (the owner's own learning, the start page).
 * - `{ g }`: a global permission.
 * - `{ member }`: a member-management action, optionally against the account or invite in :id.
 * - `{ s, at }`: a permission in the space found at `at`: `p.id` / `q.space` / `b.space` (route
 *   param, query, body) or through what the id names: `src:p.id` (a source), `mem:p.id` (a memory),
 *   `note:p.id` (a note on a source).
 * - `{ run }`: the run in `:id` must be one the user may read (permissions.ts canReadRun).
 */
export type RouteRule = "handler" | "public" | "self" | "owner" | { cap: Capability; at: string } | { member: MemberAction; target?: boolean } | { g: GlobalPerm } | { s: SpacePerm; at: string } | { run: "read" };

const g = (perm: GlobalPerm): RouteRule => ({ g: perm });
const s = (perm: SpacePerm, at: string): RouteRule => ({ s: perm, at });
const cap = (cap: Capability, at = "global"): RouteRule => ({ cap, at });
const RUN: RouteRule = { run: "read" };
const AGENTS = g("agents.manage");
const SETTINGS = g("settings.manage");
const CODE = g("code.delegate");
const USERS = g("users.manage");

export const ROUTE_RULES: Record<string, RouteRule> = {
  "GET /api/tools/turn/:key": "public",
  "GET /api/tools/turn/:key/:name": "public",
  "POST /api/cloud-tools/challenge/:nonce": "public",
  "GET /api/cloud-tools/challenge/:nonce": "public",
  "GET /api/agents/session-cleanup/failures": "owner",
  "POST /api/agents/session-cleanup/retry": "owner",
  "GET /api/ai/decision/report": "owner",
  "GET /api/code/:id/improve": RUN,
  "GET /api/quality": "owner",
  "GET /api/insights": "self",
  "GET /api/insights/export": "self",
  "GET /api/insights/records": "self",
  "GET /api/insights/breakdown": "self",
  "POST /api/quality/audit": "owner",
  "GET /api/plugins/pack": "owner",
  "POST /api/plugins/pack": "owner",
  "PUT /api/roles/:name/tools": "owner",
  "GET /api/share/:token": "public",
  "GET /api/shares": "self",
  "DELETE /api/shares/:id": "self",
  "GET /api/capabilities": { member: "read" },
  "GET /api/members/:id/capabilities": { member: "read", target: true },
  "PUT /api/members/:id/capabilities": { member: "manage", target: true },
  "GET /api/credentials": "self",
  "POST /api/credentials/:kind/login": "self",
  "PUT /api/credentials/:kind/sharing": "self",
  "DELETE /api/credentials/:kind": "self",
  "GET /api/me": "self",
  // Each person's own AI accounts (docs/v2/agent-accounts.md): the handlers act on the caller's own only.
  "GET /api/me/agent-accounts": "self",
  "POST /api/me/agent-accounts/:backend/login": "self",
  "POST /api/me/agent-accounts/:backend/token": "self",
  "POST /api/me/agent-accounts/:backend/check": "self",
  "POST /api/me/agent-accounts/:backend/quota": "self",
  "DELETE /api/me/agent-accounts/:backend": "self",
  // Everyone's logins (no tokens), the per-backend rule, removing a member's login: the owner's.
  "GET /api/tools": "public",
  "POST /api/tools/:name": "public",
  // Checks a run's token and that the request comes from this machine itself (agents/command-gate.ts).
  "POST /api/command-gate": "public",
  "POST /api/remote/agent-browser": "public", // Local agent run token in the handler.
  "GET /api/operation-gate/http": "public",
  "POST /api/operation-gate/http": "public",
  "GET /api/events": "self",

  // spaces
  "GET /api/spaces/:id/lessons": "owner",
  "POST /api/spaces/:id/lessons": "owner",
  "PUT /api/spaces/:id/lessons/:lesson": "owner",
  "DELETE /api/spaces/:id/lessons/:lesson": "owner",
  "GET /api/spaces": "self",
  "POST /api/spaces": g("spaces.create"),
  "GET /api/spaces/:id": s("space.read", "p.id"),
  "PATCH /api/spaces/:id": s("space.manage", "p.id"),
  // Deleting an empty space: the owner's (core/spaces.ts deleteSpace).
  "DELETE /api/spaces/:id": "owner",
  "POST /api/spaces/:id/parent": s("space.manage", "p.id"),
  "GET /api/spaces/:id/repo-suggestions": s("space.manage", "p.id"),
  "POST /api/spaces/:id/related": s("space.manage", "p.id"),
  "DELETE /api/spaces/:id/related/:other": s("space.manage", "p.id"),
  "GET /api/spaces/:id/members": s("space.manage", "p.id"),
  "PUT /api/spaces/:id/members/:user": s("space.manage", "p.id"),
  "POST /api/spaces/:id/sync": cap("sources.edit", "p.id"),
  "GET /api/spaces/:id/citation-reach": s("space.read", "p.id"),
  "POST /api/spaces/:id/citation-reach/recheck": cap("sources.edit", "p.id"),
  "GET /api/spaces/:id/workspaces": CODE,
  "POST /api/spaces/:id/relink": CODE,
  "GET /api/spaces/:id/branches": s("space.read", "p.id"),
  // Switching the branch the repository's own directory has checked out.
  "PUT /api/spaces/:id/branches": CODE,
  "POST /api/spaces/:id/branches/index": cap("sources.edit", "p.id"),
  "DELETE /api/spaces/:id/branches/index": cap("sources.edit", "p.id"),
  // code indexes (sources/code-index-http.ts): baseline and followed branches; the notification checks its own hook token
  "GET /api/spaces/:id/code-index": s("space.read", "p.id"),
  "PUT /api/spaces/:id/code-index": s("space.manage", "p.id"),
  "POST /api/spaces/:id/code-index/refresh": cap("sources.edit", "p.id"),
  "GET /api/code-index/hook": "owner",
  "POST /api/code-index/hook": "owner",
  "DELETE /api/code-index/hook": "owner",
  "POST /api/code-index/notify": "public",
  // A plugin's callback from outside: its secret is in the path (src/plugins/hooks.ts).
  "POST /api/hooks/:plugin/:name/:secret": "public",

  // sources
  "GET /api/sources": cap("sources.view", "q.space"),
  "GET /api/sources/parsers": cap("sources.view", "list"),
  "GET /api/sources/levels": cap("sources.view", "list"),
  "GET /api/sources/review": cap("sources.view", "q.space"),
  "GET /api/sources/tree": cap("sources.view", "q.space"),
  "GET /api/sources/paths": cap("sources.view", "q.space"),
  "GET /api/sources/resolve": cap("sources.view", "q.space"),
  "PUT /api/sources/:id/attention": cap("sources.edit", "src:p.id"),
  "POST /api/sources/attention": "owner",
  "GET /api/sources/:id/notes": cap("sources.view", "src:p.id"),
  "POST /api/sources/:id/notes": cap("sources.edit", "src:p.id"),
  "POST /api/source-notes/:id/review": cap("sources.edit", "note:p.id"),
  "DELETE /api/source-notes/:id": cap("sources.edit", "note:p.id"),
  "POST /api/sources/node-level/review": "owner",
  "POST /api/sources/level-audit/review": "owner",
  "PUT /api/sources/node-level": "owner",
  "GET /api/sources/:id": cap("sources.view", "src:p.id"),
  "GET /api/sources/:id/messages": cap("sources.view", "src:p.id"),
  "GET /api/sources/:id/relations": cap("sources.view", "src:p.id"),
  "GET /api/sources/:id/archive": cap("sources.view", "src:p.id"),
  "DELETE /api/sources/:id": cap("sources.edit", "src:p.id"),
  "PUT /api/sources/:id/visibility": s("space.manage", "src:p.id"),
  "POST /api/sources/:id/move": AGENTS,
  "POST /api/sources/text": cap("sources.edit", "b.space"),
  "POST /api/sources/url": cap("sources.edit", "b.space"),
  "POST /api/sources/upload": cap("sources.edit", "q.space"),
  // The extension's clips: screenshots become originals in the space either way (sources/clips.ts).
  "POST /api/clips": cap("sources.edit", "b.space"),
  "GET /api/lark/messages/:mid/resources/:key": SETTINGS,
  "GET /api/messages/:id": cap("conversations.view", "global"),
  // Stored originals are named by their content hash: knowing the name is having the file.
  "GET /api/files/:name": "self",
  "GET /api/lookup": cap("search.use", "list"),
  "GET /api/search": cap("search.use", "list"),
  "GET /api/graph": cap("search.use", "q.space"),

  // asking and conversations (one's own)
  "POST /api/ask": cap("ask.send", "global"),
  "POST /api/ask/attachments": cap("ask.send", "global"),
  // voice (core/voice.ts): one's own conversations; tools run in the spaces the user can read
  "GET /api/voice": "self",
  "POST /api/voice/realtime/secret": "self",
  "POST /api/voice/live/sdp": "self",
  "POST /api/voice/transcribe": "self",
  "POST /api/voice/tool": "self",
  "GET /api/voice/sessions": "self",
  "POST /api/voice/sessions": "self",
  "GET /api/conversations": cap("conversations.view", "global"),
  "GET /api/conversations/:id": cap("conversations.view", "global"),
  "DELETE /api/conversations/:id": "self",
  "GET /api/asks": "self",
  "GET /api/asks/:id": "self",
  "POST /api/asks/:id/answer": "self",
  "POST /api/asks/:id/dismiss": "self",
  "POST /api/asks/:id/question": "self",
  "GET /api/ui/views": "self",
  "GET /api/ui/pages/:id": "self",
  "POST /api/asks/:id/draft": "self",
  "GET /api/ui/:id": "self",
  "GET /api/notify/outlets": "self",
  "PUT /api/notify/outlets": "self",
  "POST /api/notify/outlets/:id/test": "self",
  "GET /api/notifications": cap("notifications.view", "global"),
  "GET /api/notifications/outcomes": "owner",
  "POST /api/notifications/outcomes/ignore": "owner",
  "GET /api/approvals/ladder": "owner",
  "POST /api/notifications/read": "self",

  // wiki
  "GET /api/wiki/kinds": cap("wiki.view", "list"),
  "GET /api/wiki/:space": cap("wiki.view", "p.space"),
  "GET /api/wiki/:space/page/*": cap("wiki.view", "p.space"),
  "PUT /api/wiki/:space/page/*": s("wiki.write", "p.space"),
  "DELETE /api/wiki/:space/page/*": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/plan": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/write": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/lint": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/move": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/organize": s("wiki.write", "p.space"),
  "GET /api/wiki/:space/questions": s("wiki.write", "p.space"),
  "GET /api/wiki/:space/coverage": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/coverage/run": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/questions/:id/answer": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/questions/:id/drop": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/questions/:id/reopen": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/questions/resolve": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/recheck": s("wiki.write", "p.space"),
  "GET /api/wiki/:space/corrections": s("wiki.write", "p.space"),
  "POST /api/wiki/:space/corrections": s("wiki.write", "p.space"),

  // memories
  // Without a space: what this person can read (the handler narrows it).
  "GET /api/memories": cap("memories.view", "list"),
  "GET /api/memories/:id": cap("memories.view", "mem:p.id"),
  "POST /api/memories": s("memory.write", "b.space"),
  "POST /api/memories/:id/supersede": s("memory.write", "mem:p.id"),
  "PATCH /api/memories/:id": s("memory.write", "mem:p.id"),
  "DELETE /api/memories/:id": s("memory.write", "mem:p.id"),
  "GET /api/memory-folders": cap("memories.view", "list"),
  "POST /api/memory-folders": s("memory.write", "b.space"),
  "PATCH /api/memory-folders": s("memory.write", "b.space"),
  "DELETE /api/memory-folders": s("memory.write", "q.space"),
  "POST /api/memory-folders/move": s("memory.write", "b.space"),
  "POST /api/memory-folders/organize": s("memory.write", "b.space"),
  "GET /api/memory-tags": cap("memories.view", "list"),
  "GET /api/memory-recall-stats": AGENTS,
  "GET /api/shortcomings": AGENTS,
  "GET /api/dream/status": AGENTS,
  "GET /api/memory-quality": AGENTS,

  // items and requirements (the handlers check whose item it is)
  // metrics (src/data/http.ts): readable spaces only; editing needs write access to the metric's space
  "GET /api/metrics": cap("metrics.view", "list"),
  "GET /api/metrics/providers": cap("metrics.view", "list"),
  "GET /api/metrics/files": cap("metrics.view", "list"),
  "GET /api/metrics/:id": cap("metrics.view", "metric:p.id"),
  "PUT /api/metrics/:id": "self",
  "POST /api/metrics/decide": "self",
  "GET /api/flows": cap("flows.view", "list"),
  "GET /api/flows/board": cap("flows.view", "list"),
  "PUT /api/flows/:id/checks": "owner",
  "DELETE /api/flows/:id/gates/:stage": "self",
  "POST /api/flows/validate": "owner",
  "PUT /api/flows/:id": "owner",
  "DELETE /api/flows/:id": "owner",
  "GET /api/items/:id/flow": cap("flows.view", "item:p.id"),
  "GET /api/items/:id/study": "self",
  "GET /api/items/:id/study/scope": "self",
  "PUT /api/items/:id/study/scope": "self",
  "POST /api/items/:id/study/findings/:finding/fix": CODE,
  "POST /api/items/:id/flow/changes/:change": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/study/choose": "self",
  "POST /api/items/:id/study/findings/:finding": "self",
  "POST /api/items/:id/study/directions/:direction/close": "self",
  "POST /api/items/:id/flow": cap("flows.operate", "item:p.id"),
  "DELETE /api/items/:id/flow": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/confirm": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/hold": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/skip": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/done": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/reopen": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/record": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/tests/:test": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/round": cap("flows.operate", "item:p.id"),
  "POST /api/items/:id/flow/stages/:stage/budget": cap("flows.operate", "item:p.id"),
  "GET /api/rules": cap("rules.view"),
  "GET /api/rules/:id": cap("rules.view"),
  "POST /api/rules": cap("rules.edit"),
  "PUT /api/rules/:id": cap("rules.edit"),
  "DELETE /api/rules/:id": cap("rules.edit"),
  "POST /api/rules/draft": cap("rules.edit"),
  "POST /api/rules/test": cap("rules.edit"),
  // Work lines (items/work-http.ts, docs/v2/status.md “工作线”): the owner's own page for now.
  "GET /api/pending": "self",
  "GET /api/work": cap("work.view", "list"),
  "GET /api/work/activities": cap("work.view", "list"),
  "GET /api/work/:id": cap("work.view", "list"),
  // A member's own lines (items/member-work.ts): only their own items; the handlers check the item again.
  "POST /api/work/:id/refresh": cap("items.operate", "item:p.id"),
  // A line's lifecycle (items/lifecycle.ts): its phase, and the lines that ended.
  "GET /api/work/ended": cap("work.view", "list"),
  "PUT /api/work/:id/phase": cap("items.operate", "item:p.id"),
  "PUT /api/items/:id/parent": cap("items.edit", "item:p.id"),
  "PUT /api/item-next/:id": "self",
  "PUT /api/item-changes/:id/noise": "self",
  "POST /api/work/:id/next": cap("items.edit", "item:p.id"),
  // “今天” as it reads for the person, and the routine work on their own lines (items/member-routine.ts).
  "GET /api/work/today": "self",
  "GET /api/work/routine": "self",
  "PUT /api/work/routine": "self",
  "GET /api/item-sync": g("connector.use"),
  "PUT /api/item-sync": g("connector.use"),
  "POST /api/item-sync/:id/pull": g("connector.use"),
  "POST /api/items/:id/writeback": g("connector.use"),
  "GET /api/items": cap("items.view", "own-list"),
  "POST /api/items": cap("items.edit", "item-new"),
  "GET /api/items/:id": cap("items.view", "item:p.id"),
  "GET /api/items/:id/chain": cap("items.view", "item:p.id"),
  "PATCH /api/items/:id": cap("items.edit", "item-update"),
  "POST /api/items/:id/keep": cap("items.operate", "item:p.id"),
  "POST /api/items/:id/candidate": cap("items.operate", "item:p.id"),
  "POST /api/items/:id/materials": cap("items.edit", "item:p.id"),
  "GET /api/items/:id/objects": "self",
  "POST /api/items/:id/objects": cap("items.edit", "item:p.id"),
  "DELETE /api/items/:id/objects/:object": cap("items.edit", "item:p.id"),
  "POST /api/items/:id/objects/:object/actions/:action": cap("items.edit", "item:p.id"),
  "DELETE /api/items/:id/materials/:mid": cap("items.edit", "item:p.id"),
  "POST /api/items/:id/split-requirements": cap("items.edit", "item:p.id"),
  "GET /api/items-expiry": "self",
  "POST /api/items-expiry/backlog": AGENTS,
  "POST /api/items-expiry/sweep": AGENTS,
  "GET /api/requirements": cap("requirements.view", "q.space"),
  "GET /api/requirements/:id": cap("requirements.view", "req:p.id"),
  "POST /api/requirements": s("memory.write", "b.space"),
  // designs (src/designs): the handlers keep to the spaces the person may read, and writers confirm
  "GET /api/designs": cap("designs.view", "list"),
  "GET /api/designs/:id": cap("designs.view", "design:p.id"),
  "GET /api/designs/:id/diff": cap("designs.view", "design:p.id"),
  "POST /api/designs": "self",
  "POST /api/designs/:id/decide": "self",
  "POST /api/designs/:id/concerns/:cid": "self",

  // runs
  "GET /api/runs": cap("runs.view", "own-list"),
  "GET /api/runs/triggerers": "self",
  // Assistants (agents/assistants.ts): everyone sees who is here; each manages their own, the owner all.
  "GET /api/assistants": "self",
  "POST /api/assistants": "self",
  "POST /api/assistants/scan": "self",
  "PATCH /api/assistants/:id": "self",
  "DELETE /api/assistants/:id": "self",
  "GET /api/runs/:id/progress": cap("runs.view", "run:p.id"),
  "GET /api/items/:id/progress": cap("items.view", "item:p.id"),
  "GET /api/runs/:id": cap("runs.view", "run:p.id"),
  "GET /api/agent-work/:id/board": RUN,
  "POST /api/runs/:id/share-review": RUN,
  "POST /api/runs/:id/cancel": cap("runs.operate", "run:p.id"),
  "POST /api/runs/:id/retry": cap("runs.operate", "run:p.id"),
  "POST /api/runs/:id/reply-outcome": "owner",
  "GET /api/runs/:id/folders": CODE,
  "GET /api/code-runs/at": CODE,
  "GET /api/code-works": cap("code.work.view", "list"),
  "GET /api/code-works/:id": cap("code.work.view", "run:p.id"),
  "POST /api/delegate": CODE,
  "POST /api/review-branch": CODE,
  "GET /api/review-tiers": CODE,
  "GET /api/review-settings": cap("settings.assistant.view"),
  "PUT /api/review-settings": cap("settings.assistant.edit"),
  "GET /api/review-options": cap("settings.assistant.view"),
  "GET /api/ide/cli": CODE,
  "GET /api/ide/open": CODE,
  // Previews of a delegation's workspace (docs/v2/preview.md): the owner's commands and servers.
  "GET /api/runs/:id/previews": "owner",
  "GET /api/runs/:id/artifacts": RUN,
  "DELETE /api/runs/:id/artifacts/:artifact": cap("runs.operate", "run:p.id"),
  // The key in the path is the capability (agents/artifacts.ts): a report's own files load without a cookie.
  "GET /api/artifacts/:token/*": "public",
  "GET /api/previews": "owner",
  "POST /api/previews": "owner",
  "GET /api/previews/:id": "owner",
  "DELETE /api/previews/:id": "owner",
  // Nothing to forward here: `omem peer open` answers this path itself on the owner's machine.
  "GET /api/local/forwards": "self",
  ...Object.fromEntries(
    [
      "POST code-here", "GET review-sync", "POST review-sync/publish", "POST review-sync/resolve", "POST review-sync/refresh", "GET apply-targets", "POST apply", "GET branch", "POST branch", "POST sync", "GET git", "POST git", "POST move-to-target", "POST discard",
      "GET tasks", "POST tasks", "POST review-again", "POST tasks/:seq", "POST revert", "POST work", "GET file-at", "GET task-diff", "GET reviews", "GET latest-state",
      "PUT findings/:fid", "PUT findings/:fid/suggestion", "PUT findings/:fid/external", "POST rereview", "GET prior", "GET inherited-split", "PUT findings-fixed", "POST change-points", "GET same-branch", "POST fix", "POST notes",
      "PUT round-review", "GET file", "GET file/raw", "GET blob",
    ].map((r) => {
      const [m, p] = r.split(" ");
      const read = m === "GET" && (p === "tasks" ? "code.work.view" : ["reviews", "task-diff"].includes(p) ? "code.review.view" : null);
      return [`${m} /api/runs/:id/${p}`, read ? cap(read, "run:p.id") : CODE];
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
  // Skill groups and the agents' own skill folders (agents/agent-skills.ts): the owner's machine.
  "PUT /api/skill-groups": "owner", "PUT /api/skill-groups/:id": "owner",
  "PUT /api/agent-skills/settings": "owner", "POST /api/agent-skills/sweep": "owner", "POST /api/agent-skills/restore": "owner", "POST /api/agent-skills/organize": "owner",

  // agents, skills, rules and schedules: shared by everyone, managed by a few
  ...Object.fromEntries(
    [
      "GET /api/agents/:name", "PUT /api/agents/:name", "DELETE /api/agents/:name", "DELETE /api/agents/quota/:source", "POST /api/agents/quota/refresh",
      "GET /api/roles", "GET /api/roles/:name", "PUT /api/roles/:name", "PUT /api/roles/:name/defaults", "PUT /api/roles/:name/full-access", "POST /api/roles/:name/customize", "POST /api/roles/:name/follow-source", "POST /api/roles/:name/reset", "POST /api/roles/:name/merge",
      "GET /api/profile-options", "PUT /api/profiles/:name/skills", "POST /api/profiles/:name/review", "POST /api/profile-proposals/:id/apply", "POST /api/profile-proposals/:id/reject",
      "GET /api/library-files/skill/:name", "PUT /api/library-files/skill/:name",
      "GET /api/skills", "GET /api/skill-groups", "GET /api/skill-groups/:id", "GET /api/skills/:name", "PUT /api/skills/:name", "PUT /api/skills/:name/status", "DELETE /api/skills/:name", "GET /api/skills/:name/files", "GET /api/skills/:name/file", "PUT /api/skills/:name/file", "DELETE /api/skills/:name/file",
      "GET /api/rules/:id/permissions",
      "GET /api/rule-options", "POST /api/rule-conversations", "GET /api/wakes", "DELETE /api/wakes/:id", "GET /api/watches", "DELETE /api/watches/:chatId",
      "GET /api/listen", "GET /api/listen/:id", "POST /api/listen", "PUT /api/listen/:id", "DELETE /api/listen/:id", "POST /api/listen/:id/coach", "POST /api/listen/:id/learn", "GET /api/lark/chats/:id/detail", "PUT /api/cases/:id", "POST /api/items/:id/listen", "POST /api/rules/:id/to-listen",
      "GET /api/notify-ignore-rules", "POST /api/notify-ignore-rules/delete", "POST /api/schedules/:id/run",
      "GET /api/archive-rules", "GET /api/archive-options", "POST /api/archive-rules", "PUT /api/archive-rules/order", "PUT /api/archive-rules/:id", "DELETE /api/archive-rules/:id", "POST /api/archive-rules/draft",
      "GET /api/archive/folders", "POST /api/archive/folders", "POST /api/archive/preview", "POST /api/archive/apply", "POST /api/archive/classify",
      "GET /api/archive/homing", "POST /api/archive/homing/return", "POST /api/archive/homing/assign", "POST /api/archive/homing/sweep",
      "GET /api/attention-rules", "PUT /api/attention-rules/:id", "DELETE /api/attention-rules/:id", "POST /api/attention-rules/apply",
      "GET /api/digest-jobs", "POST /api/digest-jobs", "POST /api/digest-jobs/:id/:action", "PUT /api/digest-jobs/:id",
      "GET /api/feedback/stats", "POST /api/replays/run", "POST /api/replay-effects/:id/:action",
    ].map((r) => [r, AGENTS]),
  ),

  ...Object.fromEntries(Object.values(ownerControls).flat().map(route => [route, "owner" as const])),
  "GET /api/ai": cap("settings.ai.view"),
  "POST /api/agents/:id/probe": "handler",
  "GET /api/agents/:id/adapter": cap("settings.ai.view"),
  "GET /api/agent-registry": cap("settings.ai.view"),
  "GET /api/agents/load": cap("settings.ai.view"),
  "PUT /api/plugins/:id/settings": cap("settings.ai.edit"),
  "PUT /api/plugins/:id/icon": cap("settings.ai.edit"),
  "GET /api/agents": cap("agents.view"),
  "GET /api/skills": cap("agents.view"),
  "GET /api/mentions": cap("settings.assistant.view"),
  "GET /api/schedules": cap("settings.assistant.view"),
  "GET /api/replays": cap("settings.assistant.view"),
  "PUT /api/schedules/:id": cap("settings.assistant.edit"),
  "GET /api/lark/bot-check": cap("settings.channels.view"),
  "GET /api/lark/captured": cap("settings.knowledge.view"),
  "GET /api/lark/wiki-crawls": cap("settings.knowledge.view"),
  "GET /api/search/providers": cap("settings.knowledge.view"),
  "GET /api/storage": cap("settings.knowledge.view"),
  "GET /api/media": cap("settings.knowledge.view"),
  "POST /api/storage/scan": cap("settings.knowledge.edit"),
  "PUT /api/sources/wiki-space-name": "owner",
  "PUT /api/agent-role-model": cap("settings.ai.edit"),
  "GET /api/settings": "handler",
  "GET /api/settings/sections": "handler",
  "PUT /api/settings": "handler",

  // channels, AI backends and this machine
  ...Object.fromEntries(
    [
      "POST /api/ai/decision/test", "GET /api/lark/chats", "POST /api/lark/chats/:id/backfill", "POST /api/lark/fill-files", "GET /api/lark/fill-files",
      "PUT /api/lark/chats/:id/policy", "PUT /api/lark/chats/:id/subscription", "PUT /api/lark/chats/:id/space", "POST /api/lark/poll", "GET /api/lark/user-permissions",
      "POST /api/lark/wiki-crawls/:id/:op", "GET /api/lark/kb", "POST /api/lark/kb/discover",
      "POST /api/lark/kb/read", "PUT /api/lark/kb/settings", "POST /api/lark/kb/:id", "GET /api/lark/kb-home", "POST /api/lark/kb-home", "PUT /api/lark/kb-home/dir",
      "POST /api/media/ffmpeg/install", "POST /api/media/compress", "POST /api/media/stop", "POST /api/media/resume",
      "POST /api/media/delete-originals", "GET /api/plugins/:id/services",

    ].map((r) => [r, SETTINGS]),
  ),
  "GET /api/desktop": cap("settings.channels.view"),
  "POST /api/desktop/install": g("desktop.control"),
  // remote operation (docs/v2/remote.md): each person's own sessions and recordings
  "GET /api/remote": "self",
  "GET /api/remote/grant-candidates": "self",
  "GET /api/remote/screens": g("desktop.control"),
  "GET /api/remote/browser-profiles": g("desktop.control"),
  "POST /api/remote/sessions": g("desktop.control"),
  "POST /api/remote/sessions/:id/view": "handler",
  "POST /api/remote/sessions/:id/grants": "self",
  "PATCH /api/remote/sessions/:id/grants/:grantId": "self",
  "DELETE /api/remote/sessions/:id/grants/:grantId": "self",
  "POST /api/remote/sessions/:id/viewer": g("desktop.control"),
  "GET /api/remote/settings": g("desktop.control"),
  "PUT /api/remote/settings": g("desktop.control"),
  "POST /api/remote/settings/probe": g("desktop.control"),
  "POST /api/remote/sessions/:id/navigate": "handler",
  "DELETE /api/remote/sessions/:id": g("desktop.control"),
  "POST /api/remote/sessions/:id/recording": g("desktop.control"),
  "DELETE /api/remote/sessions/:id/recording": g("desktop.control"),
  "GET /api/remote/recordings": g("desktop.control"),
  "GET /api/remote/recordings/:id": g("desktop.control"),
  "POST /api/remote/recordings/:id/organize": g("desktop.control"),
  // A recording from the owner's own Chrome (the extension's 录制, remote/import.ts).
  "POST /api/remote/recordings/import": "owner",
  // Demonstrations (remote/demos.ts): the owner shows how a piece of work goes, one at a time.
  "GET /api/demos": "owner",
  "POST /api/demos": "owner",
  "GET /api/demos/:id": "owner",
  "POST /api/demos/:id/stop": "owner",

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
  // Plugin blocks on omem's own pages: the handler checks the item is readable and reads as this person.
  "GET /api/slots": "self",
  "GET /api/slots/:plugin/:block": "self",
  "POST /api/plugins/:id/call/:tool": "self",
  // A plugin page's voice conversation (the shell asks for it): like /api/voice, anyone who may use the plugin.
  "GET /api/plugins/:id/voice": "self",
  "POST /api/plugins/:id/voice/realtime/secret": "self",
  "POST /api/plugins/:id/voice/live/sdp": "self",

  // devices
  // Another server reading what is shared with it: the handlers keep to the caller's grants.
  "GET /api/fed/info": "self",
  "GET /api/fed/card": "self",
  "POST /api/fed/ask": "self",
  "GET /api/fed/ask/:id": "self",
  "POST /api/fed/search": "self",
  "GET /api/fed/source/:id": "self",
  "GET /api/fed/changes": "self",

  // logging in, one's account, and managing people
  "GET /api/auth/session": "public",
  "GET /api/auth/:provider/start": "public",
  "GET /api/auth/:provider/callback": "public",
  "GET /api/auth/lark/grant/:ticket": "public",
  "GET /api/auth/link/:code": "public",
  "POST /api/auth/link/:code": "public",
  "POST /api/auth/lark/app": "public",
  "POST /api/auth/logout": "public",
  "POST /api/auth/cli/start": "public",
  "POST /api/auth/cli/poll": "public",
  "GET /api/auth/cli/info": "self",
  "POST /api/auth/cli/approve": "self",
  "POST /api/auth/cli/deny": "self",
  "POST /api/auth/open": "self",
  "GET /api/auth/tokens": "self",
  "DELETE /api/auth/tokens/:id": "self",
  "GET /api/auth/account": "self",
  "GET /api/auth/connections": "self",
  "DELETE /api/auth/connections/:provider": "self",
  "PUT /api/auth/connections/:provider/features/:feature": "self",
  "PUT /api/auth/connections/lark/capture": "self",
  "POST /api/auth/connections/:provider/credentials": "self",
  "GET /api/auth/watches": "self",
  "DELETE /api/auth/watches/:id": "self",
  "POST /api/auth/watches/:id/sync": "self",
  "DELETE /api/auth/sessions/:id": "self",
  "DELETE /api/auth/identities": "self",
  "GET /api/auth/providers": cap("settings.members.view"),
  "GET /api/users": { member: "read" },
  "POST /api/users": { member: "manage" },
  "PATCH /api/users/:id": { member: "manage", target: true },
  "DELETE /api/users/:id/sessions": { member: "identity", target: true },
  "DELETE /api/users/:id/identities": { member: "identity", target: true },
  "PUT /api/users/:id/spaces": { member: "manage", target: true },
  "GET /api/invites": { member: "read" },
  "POST /api/invites": { member: "manage" },
  "DELETE /api/invites/:id": { member: "revokeInvite", target: true },
  "GET /api/access/roles": "self",
  "POST /api/access/roles": USERS,
  "PUT /api/access/roles/:id": USERS,
  "DELETE /api/access/roles/:id": USERS,
  "GET /api/access/audit": USERS,
  "GET /api/security/audit": USERS,
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
  if (through === "metric") return one<{space_id:string}>(app.db,"select space_id from metrics where id=? or name=? order by created_at limit 1",value,value)?.space_id ?? null;
  const table = { req: "req_nodes", design: "designs", item: "items" }[through as "req" | "design" | "item"];
  if (table) return one<{ space_id: string }>(app.db, `select space_id from ${table} where id=?`, value)?.space_id ?? null;
  if (through === "note") return one<{ space_id: string }>(app.db, "select s.space_id from source_notes n join sources s on s.id = n.source_id where n.id = ?", Number(value))?.space_id ?? null;
  return null;
}

const reviewAudiences = new WeakMap<FastifyRequest, ReturnType<typeof runAudience>>();
export function requestReviewAudience(app: App, req: FastifyRequest, userId: string) {
  if (!reviewAudiences.has(req)) reviewAudiences.set(req, runAudience(app, userId, "code.review.view"));
  return reviewAudiences.get(req);
}

export const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;

/**
 * Throws when this user may not use this route. The owner may use every one. A source a route names
 * must also be one this person may read (restricted ones, Feishu access: src/auth/visibility.ts).
 */
export function requireAskAccess(app: App, userId: string, id: string) {
  if (one<{role:string}>(app.db, "select role from users where id=?", userId)?.role !== "observer") return;
  requirePerm(app, userId, "ask.send");
  const ordinary = one(app.db, `select 1 from asks a join conversations c on c.id=a.conversation_id
    join runs r on r.id=a.run_id and r.kind='ask' and coalesce(json_extract(r.input,'$.conversationId'),json_extract(r.input,'$.threadId'))=c.id
    where a.id=? and a.kind='question' and a.tool is null and a.args is null
    and json_extract(a.context,'$.handler') is null
    and json_extract(a.context,'$.askedBy') is null
    and json_extract(a.context,'$.operationApproval') is null
    and a.user_id=? and c.user_id=a.user_id and r.user_id=a.user_id`, id, userId);
  if (ordinary) return;
  throw new HttpError(403, "观察者不能回答这项提问");
}

export async function checkRoute(app: App, req: FastifyRequest, userId: string) {
  if (isOwner(app, userId)) return;
  const rule = ROUTE_RULES[routeKey(req)] ?? ROUTE_RULES[`* ${req.routeOptions.url}`];
  if (!rule) throw new HttpError(403, "这个接口只对 omem 的主人开放");
  if (rule === "handler") return; // The handler checks individual settings keys or the live session grant.
  if (rule === "self" && !["GET", "HEAD", "OPTIONS"].includes(req.method) && one<{ role: string }>(app.db, "select role from users where id=?", userId)?.role === "observer") {
    const path = routeKey(req);
    if (path === "POST /api/asks/:id/answer" || path === "POST /api/asks/:id/dismiss") {
      return requireAskAccess(app, userId, (req.params as {id:string}).id);
    }
    throw new HttpError(403, "观察者不能执行这项操作");
  }
  if (rule === "public" || rule === "self") return;
  if (rule === "owner") throw new HttpError(403, "这个接口只对 omem 的主人开放");
  if ("member" in rule) return requireMemberAction(app, userId, rule.member, rule.target ? (req.params as { id: string }).id : undefined);
  if ("g" in rule) return requirePerm(app, userId, rule.g);
  if ("run" in rule) {
    if (!canReadRun(app, userId, String((req.params as { id?: string }).id ?? ""))) throw new HttpError(404, "运行不存在");
    return;
  }
  if ("cap" in rule && globalCapability(rule.cap)) return requirePerm(app, userId, rule.cap);
  if ("cap" in rule && rule.at === "own-list") {
    if (capabilityAccess(app,userId).range(rule.cap,true)?.length === 0) throw new HttpError(403,"没有可查看的空间");
    return;
  }
  if ("cap" in rule && rule.at === "list") {
    if (spacesWithCapability(app, userId, rule.cap)?.length === 0) throw new HttpError(403, "没有可查看的空间");
    return;
  }
  if ("cap" in rule && rule.at === "run:p.id") {
    const id = (req.params as { id: string }).id;
    const audience = rule.cap === "code.review.view" ? requestReviewAudience(app, req, userId) : runAudience(app, userId, rule.cap);
    if (!canAccessRun(app, userId, id, rule.cap, audience)) throw new HttpError(rule.cap === "runs.operate" ? 403 : 404, "没有这次运行的权限");
    return;
  }
  if ("cap" in rule && rule.at === "item-new") return requirePerm(app, userId, "items.edit", (req.body as { space?: string })?.space ?? `personal-${userId}`);
  // The handler checks every requested change and the item's ownership together.
  if ("cap" in rule && rule.at === "item-update") return;
  if ("cap" in rule && rule.at === "item:p.id" && rule.cap.startsWith("items.")) {
    if (!can(app, userId, rule.cap, { kind: "item", id: String((req.params as { id: string }).id) })) throw new HttpError(req.method === "GET" ? 404 : 403, "事项不可访问");
    return;
  }
  const space = locate(app, req, rule.at);
  if ("cap" in rule && rule.cap === "flows.view" && rule.at === "item:p.id") {
    if (!space || !can(app, userId, rule.cap, space)) throw new HttpError(404, "事项不存在");
    return;
  }
  // A detail lookup must give the same response for an unknown ID and a hidden one.
  if (req.method === "GET" && "cap" in rule && rule.at.includes(":")) {
    if (!space || !can(app, userId, rule.cap, space)) throw new HttpError(404, "要找的内容不存在");
    if (rule.at.startsWith("src:")) {
      const id = (req.params as { id: string }).id;
      if (!await sourceReadable(app, userId, aliasTarget(app, id) ?? id)) throw new HttpError(404, "要找的内容不存在");
    }
    return;
  }
  if (!space) throw new HttpError(rule.at.includes(":") ? 404 : 400, rule.at.includes(":") ? "要找的内容不存在" : "要指定空间");
  requirePerm(app, userId, "cap" in rule ? rule.cap : rule.s, space);
  if (rule.at === "note:p.id") {
    const note = one<{ source_id: string }>(app.db, "select source_id from source_notes where id=?", (req.params as { id: string }).id);
    if (!note) throw new HttpError(404, "标注不存在");
    await requireReadable(app, userId, note.source_id);
  }
  if (rule.at.startsWith("src:")) {
    const id = String((req.params as { id?: string }).id ?? "");
    await requireReadable(app, userId, aliasTarget(app, id) ?? id);
  }
}
