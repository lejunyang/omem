import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { getSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, newId, now, truncate } from "../core/util.ts";
import { ROLE_TOOLS, TOOL_GROUPS } from "./tool-help.ts";
import { addRunEvent, createRun, flushRunText, getRun, setRunOutput } from "./runs.ts";
import { callTool, mcpTools, toolList, type ToolContext } from "./tools.ts";

/**
 * An outside Agent working on this instance's data from another device: the Claude Code on a
 * laptop organizing the always-on server's sources, memories, wiki and items with the laptop's own
 * model (`omem tool --peer <id>`, `omem mcp --peer <id>`; docs/v2/architecture.md, 多台设备).
 *
 * The paired device calls `POST /api/peer/tool` with the owner token it was paired with, so the
 * caller is the owner, like `omem mcp` on this machine. What differs is the tool set and the
 * audit: no tool that sends or acts outward (Feishu, notifications, delegating work, wake-ups,
 * configuration), and every call belongs to a run of this instance, so the owner sees in the run
 * list what an outside Agent did.
 */

/**
 * Tools an outside Agent on another device does not get: they post to Feishu or notify people,
 * hand work to this machine's code workers or start its batch jobs (run_agent / ask_agent are the
 * exception: queued as runs the device reads with read_run, see tools.ts peerDispatch),
 * wake or schedule later, wait for the owner, or change what runs here (profiles, skills, rules,
 * capture settings, repositories). Reading them (list_agents, list_rules, list_lark_chats…) stays.
 * test/peer-tools.test.ts fails when a new tool is in neither this list nor PEER_ALLOWED.
 */
export const PEER_DENY = new Set([
  "lark_send", "lark_react", "meeting_send", "lark_card", "lark_update_card", "lark_send_file", "lark_doc_create", "lark_doc_update", "lark_doc_move", "lark_wiki_crawl",
  "set_chat_watch", "set_lark_backfill", "set_lark_capture_policy", "set_lark_subscription", "refresh_item_notification", "notify",
  "ask_owner", "wait_answer", "suggest_next", "wake_later", "wake_on_message", "cancel_wake",
  "continue_agent_work", "switch_run_ai", "generate_wiki", "digest_sources",
  "continue_code_run", "fix_review", "message_code_run", "set_code_review", "stop_code_run", "resplit_change_points", "retry_code_progress",
  "apply_code_run", "code_branch", "clean_code_runs", "set_code_workspaces", "code_git_action",
  "connect_repository", "save_agent", "save_skill", "save_rule", "ignore_notification_rule",
]);

/**
 * Role hand-ins an outside Agent does get: review_branch from another device makes that Agent the
 * reviewer (no model here is asked), and it reads and hands in the review through these;
 * delegate_code from another device makes it the coder, working through code_workspace.
 */
export const PEER_REVIEW_TOOLS = ["review_task", "submit_review", "submit_change_points", "code_workspace"];

/** Tools that only read (the same list `omem mcp --read-only` offers). */
export const READ_ONLY_TOOLS = new Set(["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_pages", "read_page", "recall", "list_items", "list_runs", "read_run"]);

/** Tool names an outside Agent may use: built-in tools of the groups, minus role hand-ins, plugin tools and PEER_DENY. */
export function peerToolNames(opts: { readOnly?: boolean } = {}) {
  const builtin = new Set(TOOL_GROUPS.filter((g) => g.id !== "plugins").flatMap((g) => g.tools));
  return new Set(
    toolList()
      .map((t) => t.name)
      .filter((n) => builtin.has(n) && (!ROLE_TOOLS.includes(n) || PEER_REVIEW_TOOLS.includes(n)) && !PEER_DENY.has(n) && (!opts.readOnly || READ_ONLY_TOOLS.has(n))),
  );
}

export type PeerAgentScope = {
  /** The calling device's node id (self-reported; the token only proves it is the owner's). */
  caller?: string;
  /** One outside Agent session = one run. */
  session: string;
  space?: string;
  /** Narrow what may be read and written to these spaces (all by default). */
  spaces?: string[];
  readOnly?: boolean;
  /** The Agent, model and effort on the other side, for the run's provenance (run page, memories). */
  agent?: string;
  model?: string;
  effort?: string;
};

const clean = (s: string | undefined, max: number, fallback: string) => (s ?? "").replace(/[\x00-\x1f]/g, " ").trim().slice(0, max) || fallback;

/** The context of an outside Agent's calls: the owner, every space unless narrowed, the peer tool set. */
export function peerToolContext(app: App, scope: PeerAgentScope, runId: string | null): ToolContext {
  const spaces = scope.spaces?.length ? [...new Set(scope.spaces.map((s) => getSpace(app, s).id))] : null;
  const spaceId = scope.space ? getSpace(app, scope.space).id : spaces ? (spaces.includes("personal") ? "personal" : spaces[0]) : "personal";
  if (spaces && !spaces.includes(spaceId)) throw new HttpError(400, `默认空间 ${spaceId} 不在限定的空间里`);
  const caller = clean(scope.caller, 40, "peer");
  return {
    app,
    runId,
    spaceId,
    spaces,
    tools: peerToolNames({ readOnly: scope.readOnly }),
    actor: "agent",
    userId: OWNER,
    agentProfile: `peer:${caller}`,
    peer: { caller, session: clean(scope.session, 80, "session") },
    model: scope.model ? clean(scope.model, 80, "") || null : null,
    effort: scope.effort ? clean(scope.effort, 40, "") || null : null,
  };
}

/** The tools to list for an outside Agent (what `omem mcp` lists, for this scope). */
export function peerTools(app: App, scope: Omit<PeerAgentScope, "session">) {
  return mcpTools(peerToolContext(app, { ...scope, session: "-" }, null).tools);
}

const IDLE_MS = 15 * 60_000;
const idle = new Map<string, NodeJS.Timeout>();

function finish(app: App, runId: string) {
  idle.delete(runId);
  if (run(app.db, "update runs set status = 'done', finished_at = ? where id = ? and status = 'running'", now(), runId).changes) app.emit({ type: "run", runId, status: "done" });
}

/** The run of a session (made on first use; a run that went idle is reopened by its next call). */
function sessionRun(app: App, scope: PeerAgentScope, spaceId: string) {
  const caller = clean(scope.caller, 40, "peer");
  const session = clean(scope.session, 80, "session");
  let r = one<{ id: string; status: string }>(app.db, "select id, status from runs where kind = 'peer-agent' and json_extract(input, '$.caller') = ? and json_extract(input, '$.session') = ? order by created_at desc limit 1", caller, session);
  if (!r) {
    const created = createRun(app, {
      kind: "peer-agent",
      spaceId,
      title: truncate(`设备 ${caller} 的外部 Agent（${session}）`, 80),
      input: { caller, session, agent: scope.agent ? clean(scope.agent, 60, "") : undefined, model: scope.model ? clean(scope.model, 80, "") : undefined, effort: scope.effort ? clean(scope.effort, 40, "") : undefined, readOnly: scope.readOnly || undefined, spaces: scope.spaces },
    });
    // Claimed before the worker's next look (it runs on a microtask after this synchronous step);
    // a run left over from a restart is finished by the handler in jobs.ts.
    run(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), created.id);
    app.emit({ type: "run", runId: created.id, status: "running" });
    r = { id: created.id, status: "running" };
  } else if (r.status !== "running") {
    run(app.db, "update runs set status = 'running', finished_at = null, error = null where id = ?", r.id);
    app.emit({ type: "run", runId: r.id, status: "running" });
  }
  // What ran on the other side, shown like any run's AI (profile · model · effort); a later call that
  // names a different model or effort replaces it.
  const agent = scope.agent ? clean(scope.agent, 60, "") : "";
  const model = scope.model ? clean(scope.model, 80, "") : "";
  const effort = scope.effort ? clean(scope.effort, 40, "") : "";
  if (agent || model || effort) {
    const profile = agent ? `peer:${caller}:${agent}` : `peer:${caller}`;
    run(app.db, "update runs set ai = ?, profile_id = ? where id = ?", JSON.stringify({ profile, model: model || undefined, effort: effort || undefined }), profile, r.id);
  }
  clearTimeout(idle.get(r.id));
  idle.set(r.id, setTimeout(() => finish(app, r!.id), IDLE_MS).unref());
  return r.id;
}

/** Long arguments (a page body) are kept in the run's events only in part. */
const clip = (args: unknown) => {
  const s = JSON.stringify(args ?? {});
  return s.length <= 4000 ? args : truncate(s, 4000);
};

const REFUSED = (name: string) => `工具 ${name} 不对设备的外部 Agent 开放：它会对外发消息、交办这台机器上的 Agent 或改动这里运行的配置。需要时请本人在这台机器上（或网页上）做。`;

/**
 * One tool call of an outside Agent, as the owner, recorded in the session's run: a `tool` event
 * for every call (refused ones too) and, for writes, the `tool-write` event the tools themselves
 * add. `omem_help` only reads the tool descriptions: it joins a run that exists, never makes one.
 */
export async function peerToolCall(app: App, scope: PeerAgentScope, name: string, args: unknown) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new HttpError(400, `工具名不合法：${truncate(String(name), 40)}`);
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) throw new HttpError(400, "args 要是 JSON 对象");
  const input = (args ?? {}) as Record<string, unknown>;
  const help = name === "omem_help";
  const base = peerToolContext(app, scope, null);
  const caller = clean(scope.caller, 40, "peer");
  const existing = help
    ? one<{ id: string; status: string }>(app.db, "select id, status from runs where kind = 'peer-agent' and json_extract(input, '$.caller') = ? and json_extract(input, '$.session') = ? order by created_at desc limit 1", caller, clean(scope.session, 80, "session"))
    : undefined;
  if (help) {
    // A run that is not open stays closed for a help request.
    const ctx = { ...base, runId: existing?.status === "running" ? existing.id : null };
    return { runId: ctx.runId, ...(await callTool(ctx, name, input)) };
  }
  const runId = sessionRun(app, scope, base.spaceId);
  const ctx = { ...base, runId };
  // Through omem_call the real tool is the one that counts.
  const target = name === "omem_call" && typeof input.tool === "string" ? input.tool : name;
  const known = toolList().some((t) => t.name === target);
  const refused = known && PEER_DENY.has(target);
  const result = refused ? { text: REFUSED(target), isError: true } : await callTool(ctx, name, input);
  flushRunText(app, runId);
  addRunEvent(app, runId, "tool", { id: newId("t"), title: `omem · ${target}`, kind: "other", status: result.isError ? "failed" : "completed", input: clip(name === "omem_call" ? (input.args ?? {}) : input), ...(refused ? { refused: true } : {}), ...(result.isError ? { error: truncate(result.text, 300) } : {}) });
  setRunOutput(app, runId, { calls: ((getRun(app, runId).output.calls as number) ?? 0) + 1, last: target, lastAt: now() });
  return { runId, ...result };
}

/** Test and shutdown helper: close the idle timers of runs (the runs themselves stay as they are). */
export function stopPeerAgentTimers() {
  for (const t of idle.values()) clearTimeout(t);
  idle.clear();
}
