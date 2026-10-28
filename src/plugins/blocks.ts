import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, newId, now, truncate, webLink } from "../core/util.ts";
import type { HostTool, ToolContext } from "../agents/tools.ts";
import { pluginStore } from "./store.ts";
import type { BlockStatus, PluginBlock, PluginBlockState, PluginContext, PluginSettings } from "./types.ts";

/**
 * Content blocks (docs/v2/plugins.md): what a plugin's agent puts in front of the owner on the
 * plugin's page — a batch of questions, a form. The agent hands one in with a tool whose schema
 * the plugin declares; the stored block keeps everything (answers too), the page gets the
 * public view. The owner submits the whole block at once; the plugin grades what it can and the
 * result becomes the next message in the same session.
 */
type Row = { id: string; plugin: string; kind: string; conversation_id: string; run_id: string | null; user_id: string; data: string; status: BlockStatus; answers: string | null; result: string | null; created_at: string; submitted_at: string | null };

/** What the host knows about one plugin that block handling needs (src/plugins/registry.ts). */
export type PluginEnv = {
  id: string;
  /** The plugin's own block of this kind, else the host's (form, chart). */
  def(kind: string): PluginBlock | undefined;
  settings(app: App, userId: string): PluginSettings;
  /** Where a block handed in outside a plugin session goes: a new session with this agent. */
  sessionFor(spec: string | undefined): { agent: string; spaceId: string } | null;
  title: string;
};

const toState = (r: Row): PluginBlockState => ({
  id: r.id,
  kind: r.kind,
  data: json(r.data, {}),
  status: r.status,
  answers: r.answers ? json(r.answers, {}) : null,
  result: r.result ? json(r.result, null) : null,
  conversationId: r.conversation_id,
  createdAt: r.created_at,
});

/** The conversation a run is a turn of (plugin sessions are ordinary conversations). */
function runConversation(app: App, runId: string | null) {
  if (!runId) return null;
  const r = one<{ input: string }>(app.db, "select input from runs where id = ?", runId);
  return (r ? json<{ conversationId?: string }>(r.input, {}).conversationId : null) ?? null;
}

export const pluginChannel = (plugin: string) => `plugin:${plugin}`;

/** Where the owner opens a session: an absolute link when the web address is configured (it then works from Feishu). */
export function sessionLink(app: App, plugin: string, conversationId: string) {
  return webLink(app, `#/plugin/${plugin}?session=${conversationId}`);
}

function sessionThread(app: App, plugin: string, conversationId: string, userId: string) {
  const t = one<{ id: string; space_id: string; channel: string; user_id: string; title: string; settings: string; created_at: string; updated_at: string }>(app.db, "select * from conversations where id = ?", conversationId);
  if (!t || t.channel !== pluginChannel(plugin) || t.user_id !== userId) throw new HttpError(404, "没有这个会话");
  return t;
}

/** Store a block in one of the user's sessions of this plugin and tell the page. */
function presentBlock(app: App, env: PluginEnv, input: { kind: string; data: unknown; conversationId: string; runId: string | null; userId: string }) {
  sessionThread(app, env.id, input.conversationId, input.userId);
  const def = env.def(input.kind);
  if (!def) throw new HttpError(400, `插件 ${env.id} 没有 ${input.kind} 类型的内容块`);
  const parsed = def.schema.safeParse(input.data);
  if (!parsed.success) throw new HttpError(400, `内容块参数错误：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const data = def.prepare ? def.prepare(parsed.data) : parsed.data;
  const id = newId("pb");
  const at = now();
  run(
    app.db,
    "insert into plugin_blocks(id,plugin,kind,conversation_id,run_id,user_id,data,status,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)",
    id,
    env.id,
    def.kind,
    input.conversationId,
    input.runId,
    input.userId,
    JSON.stringify(data),
    def.display ? "shown" : "open",
    at,
    at,
  );
  app.emit({ type: "plugin", plugin: env.id, conversationId: input.conversationId, blockId: id });
  return { id, data, def };
}

export function pluginContext(app: App, env: PluginEnv, c: { userId: string; spaceId: string; runId: string | null; actor: "agent" | "user"; conversationId?: string | null }): PluginContext {
  const mine = (id: string) => one<Row>(app.db, "select * from plugin_blocks where id = ? and plugin = ? and user_id = ?", id, env.id, c.userId);
  return {
    app,
    plugin: env.id,
    userId: c.userId,
    spaceId: c.spaceId,
    runId: c.runId,
    actor: c.actor,
    conversationId: c.conversationId ?? runConversation(app, c.runId),
    store: pluginStore(app, env.id, c.userId, c.spaceId),
    settings: () => env.settings(app, c.userId),
    block: (id) => {
      const r = mine(id);
      return r ? toState(r) : null;
    },
    setBlockResult: (id, result) => {
      const r = mine(id);
      if (!r) throw new HttpError(404, `没有内容块 ${id}`);
      run(app.db, "update plugin_blocks set result = ?, updated_at = ? where id = ?", JSON.stringify(result ?? null), now(), id);
      app.emit({ type: "plugin", plugin: env.id, conversationId: r.conversation_id, blockId: id });
    },
    present: (kind, data, conversationId) => presentBlock(app, env, { kind, data, conversationId, runId: c.runId, userId: c.userId }).id,
  };
}

/**
 * The tool an agent hands a block in with: `<plugin>_<kind>`, or `plugin_<kind>` for the host's
 * blocks, which work for whichever plugin the run belongs to. Outside a session of that plugin (a
 * Feishu chat with its agent, say) the block opens a new session and the agent gets a link to send.
 */
export function blockTool(name: string, def: PluginBlock, envFor: (ctx: ToolContext) => PluginEnv | null): HostTool {
  return {
    name,
    description: def.description,
    schema: def.schema,
    write: true,
    handler: async (ctx, args) => {
      const env = envFor(ctx);
      if (!env) throw new HttpError(400, `${name} 只在插件的 Agent 运行里可用`);
      const userId = ctx.userId ?? OWNER;
      let conversationId = runConversation(ctx.app, ctx.runId);
      const conv = conversationId ? one<{ channel: string; user_id: string }>(ctx.app.db, "select channel, user_id from conversations where id = ?", conversationId) : undefined;
      let moved = false;
      if (!conv || conv.channel !== pluginChannel(env.id) || conv.user_id !== userId) {
        const target = env.sessionFor(ctx.spec);
        if (!target) throw new HttpError(400, `${name} 只能在插件 ${env.id} 的会话里用：这次运行不在那里，本人看不到它。`);
        const title = typeof (args as { title?: unknown }).title === "string" ? (args as { title: string }).title : env.title;
        conversationId = (await createSession(ctx.app, { plugin: env.id, agent: target.agent, spaceId: target.spaceId, userId, title })).id;
        moved = true;
      }
      const { id, data } = presentBlock(ctx.app, env, { kind: def.kind, data: args, conversationId: conversationId!, runId: moved ? null : ctx.runId, userId });
      if (moved)
        return `这里不是练习页，已在“${env.title}”里新开一个会话放上这一组（${id}）：${sessionLink(ctx.app, env.id, conversationId!)}\n把这个链接发给本人，请本人在那里做；提交以后的点评在那个会话里进行。`;
      return def.presented?.(data, id) ?? `已在页面上展示（${id}）。本人提交后，结果会作为下一条消息交给你；这一轮可以只说一句开场白，不要把内容再写一遍。`;
    },
  };
}

// ---------------------------------------------------------------- sessions

export function listSessions(app: App, plugin: string, userId: string) {
  return all<{ id: string; title: string; settings: string; created_at: string; updated_at: string }>(
    app.db,
    "select id, title, settings, created_at, updated_at from conversations where channel = ? and user_id = ? and status = 'active' order by updated_at desc limit 50",
    pluginChannel(plugin),
    userId,
  ).map((c) => ({ id: c.id, title: c.title, agent: json<{ spec?: string }>(c.settings, {}).spec ?? null, createdAt: c.created_at, updatedAt: c.updated_at }));
}

export async function createSession(app: App, input: { plugin: string; agent: string; spaceId: string; userId: string; title?: string }) {
  const { createThread } = await import("../agents/threads.ts");
  const t = createThread(app, { spaceId: input.spaceId, channel: pluginChannel(input.plugin), title: input.title ?? "", settings: { spec: input.agent }, userId: input.userId });
  return { id: t.id };
}

/** Everything the page shows: messages and blocks in order, and whether a turn is under way. */
export function sessionView(app: App, env: PluginEnv, conversationId: string, userId: string) {
  const t = sessionThread(app, env.id, conversationId, userId);
  const messages = all<{ id: string; role: string; text: string; meta: string; created_at: string; run_id: string | null }>(
    app.db,
    "select * from (select id, role, text, meta, created_at, run_id from messages where conversation_id = ? order by created_at desc limit 300) order by created_at",
    conversationId,
  ).map((m) => {
    const meta = json<Record<string, unknown>>(m.meta, {});
    return { id: m.id, role: m.role, text: m.text, runId: m.run_id, createdAt: m.created_at, submission: (meta.submission as string | undefined) ?? null };
  });
  const blocks = all<Row>(app.db, "select * from plugin_blocks where conversation_id = ? and plugin = ? order by created_at", conversationId, env.id).map((r) => {
    const s = toState(r);
    const d = env.def(r.kind);
    // Answers stay on the server until the block is handed in.
    const data = s.status === "open" && d?.publicView ? d.publicView(s.data) : s.data;
    return { id: s.id, kind: s.kind, status: s.status, data, answers: s.answers, result: s.result, runId: r.run_id, createdAt: s.createdAt };
  });
  const busy = one<{ status: string }>(app.db, "select status from runs where lane = ? and status in ('queued', 'running') order by created_at desc limit 1", conversationId);
  return { id: t.id, title: t.title, agent: json<{ spec?: string }>(t.settings, {}).spec ?? null, spaceId: t.space_id, messages, blocks, busy: busy?.status ?? null };
}

export async function sendMessage(app: App, input: { plugin: string; conversationId: string; userId: string; text: string; meta?: Record<string, unknown> }) {
  const t = sessionThread(app, input.plugin, input.conversationId, input.userId);
  const { receive } = await import("../agents/inbox.ts");
  const r = await receive(app, { conversationId: t.id, channel: t.channel, userId: input.userId, text: input.text, ...(input.meta ? { meta: input.meta } : {}) });
  return { messageId: r.messageId, runId: r.runId, reply: r.reply };
}

/** The owner hands a block in: grade, keep the answers and result, and tell the agent. */
export async function submitBlock(app: App, env: PluginEnv, input: { blockId: string; userId: string; answers: Record<string, unknown> }) {
  // Claim the block first, so a double click cannot grade it twice.
  const claimed = run(app.db, "update plugin_blocks set status = 'submitted', answers = ?, submitted_at = ?, updated_at = ? where id = ? and plugin = ? and user_id = ? and status = 'open'", JSON.stringify(input.answers), now(), now(), input.blockId, env.id, input.userId);
  const row = one<Row>(app.db, "select * from plugin_blocks where id = ? and plugin = ? and user_id = ?", input.blockId, env.id, input.userId);
  if (!row) throw new HttpError(404, `没有内容块 ${input.blockId}`);
  if (!claimed.changes) throw new HttpError(409, row.status === "shown" ? "这个内容块只用来展示，不用提交" : "这一组已经提交过了");
  const def = env.def(row.kind);
  if (!def?.grade) {
    run(app.db, "update plugin_blocks set status = 'open', answers = null, submitted_at = null, updated_at = ? where id = ?", now(), row.id);
    throw new HttpError(400, `插件已不再提供 ${row.kind} 类型的内容块`);
  }
  const space = one<{ space_id: string }>(app.db, "select space_id from conversations where id = ?", row.conversation_id)!.space_id;
  const ctx = { ...pluginContext(app, env, { userId: input.userId, spaceId: space, runId: null, actor: "user", conversationId: row.conversation_id }), blockId: row.id };
  let graded;
  try {
    graded = await def.grade(ctx, json(row.data, {}), input.answers);
  } catch (e) {
    run(app.db, "update plugin_blocks set status = 'open', answers = null, submitted_at = null, updated_at = ? where id = ?", now(), row.id);
    throw e;
  }
  run(app.db, "update plugin_blocks set result = ?, updated_at = ? where id = ?", JSON.stringify(graded.result ?? null), now(), row.id);
  app.emit({ type: "plugin", plugin: env.id, conversationId: row.conversation_id, blockId: row.id });
  const sent = await sendMessage(app, { plugin: env.id, conversationId: row.conversation_id, userId: input.userId, text: truncate(graded.message, 20_000), meta: { submission: row.id } });
  return { result: graded.result, runId: sent.runId };
}
