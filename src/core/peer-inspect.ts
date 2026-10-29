import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "./app.ts";
import type { AgentProfile } from "./config.ts";
import type { RoleName } from "./config.ts";
import { findSpace } from "./spaces.ts";
import { OWNER } from "./users.ts";
import { HttpError, truncate } from "./util.ts";
import { catalogEntry } from "../agents/catalog.ts";
import { cachedProbe } from "../agents/probe.ts";
import { lessonsForTask, listAgentProfiles, prepareRun, type Actor } from "../agents/runner.ts";
import { resolveCommand } from "../agents/spawn.ts";
import { findAgentSpec } from "../agents/specs.ts";
import { revokeToolToken } from "../agents/tools.ts";
import { search } from "../search/search.ts";

/**
 * Read-only views for the peer commands `agents`, `search` and `prompt` (peer-exec.ts): what the AI
 * backends on this machine are, what the agents' search returns, what a run would be told.
 */

/**
 * The npm package behind a backend's command and its installed version, read from the package.json
 * the command resolves into (a symlink in a global bin directory, or an npm .cmd shim on Windows).
 * Nothing is run. An npx profile has no installed copy: only the package it would fetch.
 */
export function adapterPackage(profile: Pick<AgentProfile, "command" | "args">): { name: string; version: string | null; via: "npx" | "installed" } | null {
  if (profile.command === "npx") {
    const spec = profile.args.find((a) => !a.startsWith("-"));
    return spec ? { name: spec.replace(/(?<=.)@[^@/]*$/, ""), version: null, via: "npx" } : null;
  }
  const found = resolveCommand(profile.command);
  if (!found) return null;
  let dir: string;
  try {
    dir = dirname(realpathSync(found.prefix.at(-1) && /\.[cm]?js$/.test(found.prefix.at(-1)!) ? found.prefix.at(-1)! : found.file));
  } catch {
    return null;
  }
  // Only a package inside node_modules: a native binary in some project's bin directory is not one.
  for (let i = 0; i < 8 && dirname(dir) !== dir; i++, dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (!existsSync(file) || !/[\\/]node_modules[\\/]/.test(dir + "/")) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name) return { name: pkg.name, version: pkg.version ?? null, via: "installed" };
    } catch {}
  }
  return null;
}

/** Every backend profile: availability, the adapter's installed version, configured model and effort, the cached probe. */
export function agentsReport(app: App) {
  return listAgentProfiles(app).map((p) => {
    const entry = catalogEntry(p.id);
    const found = p.transport === "doubao" ? null : resolveCommand(p.command);
    return {
      id: p.id,
      name: p.name ?? null,
      transport: p.transport,
      command: p.command,
      args: p.args,
      installed: p.installed,
      path: found ? found.prefix.at(-1) ?? found.file : null,
      adapter: p.transport === "acp" ? { expected: entry && entry.command === p.command ? entry.npm ?? null : null, ...(adapterPackage(p) ?? { name: null, version: null, via: null }) } : null,
      model: p.model ?? null,
      effort: p.effort ?? null,
      source: p.source ?? null,
      isDefault: app.config.agents.default === p.id,
      cachedProbe: cachedProbe(app, p.id),
    };
  });
}

export const SEARCH_PREVIEW_MAX = 30;

/** The retrieval behind the agents' `search` tool, as the owner: hits with where they come from and the snippet the tool shows. */
export async function searchPreview(app: App, a: { query: string; space?: string; limit?: number }) {
  if (a.space && a.space !== "*" && !findSpace(app, a.space)) throw new HttpError(400, `没有空间 ${a.space}`);
  const hits = await search(app, a.query, { spaces: a.space && a.space !== "*" ? [a.space] : undefined, limit: Math.min(a.limit ?? 12, SEARCH_PREVIEW_MAX) });
  return hits.map((h) => ({
    type: h.type,
    id: h.id,
    sourceId: h.sourceId ?? null,
    title: h.title,
    uri: h.uri ?? null,
    kind: h.sourceKind ?? null,
    space: h.spaceId,
    path: h.path,
    lines: h.lineStart ? [h.lineStart, h.lineEnd] : null,
    score: Number(h.score.toFixed(4)),
    via: h.via,
    attention: h.attention ?? null,
    snippet: truncate(h.snippet, 500),
  }));
}

export const PROMPT_PREVIEW_MAX = 30_000;

/**
 * The standing instructions a run would get for a role or an agent profile in a space (with a task:
 * the lessons closest to it, as a task run is told them). Its tool token is revoked at once and
 * neither it nor the MCP access appears in the result.
 */
export async function promptPreview(app: App, a: { role?: RoleName; agent?: string; space: string; task?: string }) {
  if (a.agent && a.role) throw new HttpError(400, "role 和 agent 只能给一个");
  const spec = a.agent ? findAgentSpec(app, a.agent) : null;
  if (a.agent && !spec) throw new HttpError(404, `没有名为 ${a.agent} 的 Agent 档案`);
  const role = a.role ?? "assistant";
  const actor: Actor = spec ? { spec } : { role };
  const lessons = a.task ? await lessonsForTask(app, { role, spec: spec ?? undefined, spaceId: a.space, task: a.task }) : undefined;
  const prepared = prepareRun(app, { actor, spaceId: a.space, runId: null, userId: OWNER, lessons });
  revokeToolToken(prepared.token);
  return {
    actor: spec ? { agent: spec.name } : { role },
    profile: { id: prepared.profile.id, model: prepared.profile.model ?? null, effort: prepared.profile.effort ?? null },
    parts: prepared.parts,
    systemChars: prepared.system.length,
    truncated: prepared.system.length > PROMPT_PREVIEW_MAX,
    system: prepared.system.slice(0, PROMPT_PREVIEW_MAX),
    now: prepared.now,
  };
}
