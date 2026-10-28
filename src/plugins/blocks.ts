import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import type { HostTool } from "../agents/tools.ts";
import { pluginStore } from "./store.ts";
import type { PluginBlock, PluginBlockState, PluginContext } from "./types.ts";

/**
 * Content blocks (docs/v2/plugins.md): what a plugin's agent puts in front of the owner on the
 * plugin's page — a batch of questions, a form. The agent hands one in with a tool whose schema
 * the plugin declares; the stored block keeps everything (answers too), the page gets the
 * public view. The owner submits the whole block at once; the plugin grades what it can and the
 * result becomes the next message in the same session.
 */
type Row = { id: string; plugin: string; kind: string; conversation_id: string; run_id: string | null; user_id: string; data: string; status: "open" | "submitted"; answers: string | null; result: string | null; created_at: string; submitted_at: string | null };

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

export function pluginContext(app: App, c: { plugin: string; userId: string; spaceId: string; runId: string | null; actor: "agent" | "user"; conversationId?: string | null }): PluginContext {
  const mine = (id: string) => one<Row>(app.db, "select * from plugin_blocks where id = ? and plugin = ? and user_id = ?", id, c.plugin, c.userId);
  return {
    app,
    plugin: c.plugin,
    userId: c.userId,
    spaceId: c.spaceId,
    runId: c.runId,
    actor: c.actor,
    conversationId: c.conversationId ?? runConversation(app, c.runId),
    store: pluginStore(app, c.plugin, c.userId, c.spaceId),
    block: (id) => {
      const r = mine(id);
      return r ? toState(r) : null;
    },
    setBlockResult: (id, result) => {
      const r = mine(id);
      if (!r) throw new HttpError(404, `没有内容块 ${id}`);
      run(app.db, "update plugin_blocks set result = ?, updated_at = ? where id = ?", JSON.stringify(result ?? null), now(), id);
      app.emit({ type: "plugin", plugin: c.plugin, conversationId: r.conversation_id, blockId: id });
    },
  };
}

/** The tool `<plugin>_<kind>` an agent hands a block in with. */
export function blockTool(plugin: string, name: string, def: PluginBlock): HostTool {
  return {
    name,
    description: def.description,
    schema: def.schema,
    write: true,
    handler: (ctx, args) => {
      const conversationId = runConversation(ctx.app, ctx.runId);
      const conv = conversationId ? one<{ channel: string }>(ctx.app.db, "select channel from conversations where id = ?", conversationId) : undefined;
      if (!conv || conv.channel !== `plugin:${plugin}`) throw new HttpError(400, `${name} 只能在插件页面的会话里用：这次运行不在 ${plugin} 的会话里，本人看不到它。`);
      const data = def.prepare ? def.prepare(args) : args;
      const id = newId("pb");
      const at = now();
      run(
        ctx.app.db,
        "insert into plugin_blocks(id,plugin,kind,conversation_id,run_id,user_id,data,status,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)",
        id,
        plugin,
        def.kind,
        conversationId!,
        ctx.runId,
        ctx.userId ?? OWNER,
        JSON.stringify(data),
        "open",
        at,
        at,
      );
      ctx.app.emit({ type: "plugin", plugin, conversationId: conversationId!, blockId: id });
      return def.presented?.(data, id) ?? `已在页面上展示（${id}）。本人提交后，结果会作为下一条消息交给你；这一轮可以只说一句开场白，不要把内容再写一遍。`;
    },
  };
}

// ---------------------------------------------------------------- sessions

export const pluginChannel = (plugin: string) => `plugin:${plugin}`;

function sessionThread(app: App, plugin: string, conversationId: string, userId: string) {
  const t = one<{ id: string; space_id: string; channel: string; user_id: string; title: string; settings: string; created_at: string; updated_at: string }>(app.db, "select * from conversations where id = ?", conversationId);
  if (!t || t.channel !== pluginChannel(plugin) || t.user_id !== userId) throw new HttpError(404, "没有这个会话");
  return t;
}

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
export function sessionView(app: App, plugin: string, def: (kind: string) => PluginBlock | undefined, conversationId: string, userId: string) {
  const t = sessionThread(app, plugin, conversationId, userId);
  const messages = all<{ id: string; role: string; text: string; meta: string; created_at: string; run_id: string | null }>(
    app.db,
    "select * from (select id, role, text, meta, created_at, run_id from messages where conversation_id = ? order by created_at desc limit 300) order by created_at",
    conversationId,
  ).map((m) => {
    const meta = json<Record<string, unknown>>(m.meta, {});
    return { id: m.id, role: m.role, text: m.text, runId: m.run_id, createdAt: m.created_at, submission: (meta.submission as string | undefined) ?? null };
  });
  const blocks = all<Row>(app.db, "select * from plugin_blocks where conversation_id = ? and plugin = ? order by created_at", conversationId, plugin).map((r) => {
    const s = toState(r);
    const d = def(r.kind);
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
export async function submitBlock(app: App, input: { plugin: string; def: (kind: string) => PluginBlock | undefined; blockId: string; userId: string; answers: Record<string, unknown> }) {
  // Claim the block first, so a double click cannot grade it twice.
  const claimed = run(app.db, "update plugin_blocks set status = 'submitted', answers = ?, submitted_at = ?, updated_at = ? where id = ? and plugin = ? and user_id = ? and status = 'open'", JSON.stringify(input.answers), now(), now(), input.blockId, input.plugin, input.userId);
  const row = one<Row>(app.db, "select * from plugin_blocks where id = ? and plugin = ? and user_id = ?", input.blockId, input.plugin, input.userId);
  if (!row) throw new HttpError(404, `没有内容块 ${input.blockId}`);
  if (!claimed.changes) throw new HttpError(409, "这一组已经提交过了");
  const def = input.def(row.kind);
  if (!def) throw new HttpError(400, `插件已不再提供 ${row.kind} 类型的内容块`);
  const space = one<{ space_id: string }>(app.db, "select space_id from conversations where id = ?", row.conversation_id)!.space_id;
  const ctx = { ...pluginContext(app, { plugin: input.plugin, userId: input.userId, spaceId: space, runId: null, actor: "user", conversationId: row.conversation_id }), blockId: row.id };
  let graded;
  try {
    graded = await def.grade(ctx, json(row.data, {}), input.answers);
  } catch (e) {
    run(app.db, "update plugin_blocks set status = 'open', answers = null, submitted_at = null, updated_at = ? where id = ?", now(), row.id);
    throw e;
  }
  run(app.db, "update plugin_blocks set result = ?, updated_at = ? where id = ?", JSON.stringify(graded.result ?? null), now(), row.id);
  app.emit({ type: "plugin", plugin: input.plugin, conversationId: row.conversation_id, blockId: row.id });
  const sent = await sendMessage(app, { plugin: input.plugin, conversationId: row.conversation_id, userId: input.userId, text: truncate(graded.message, 20_000), meta: { submission: row.id } });
  return { result: graded.result, runId: sent.runId };
}
