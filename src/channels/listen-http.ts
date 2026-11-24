import { registerSituationRoutes } from "../situations/http.ts";
import { deleteSituation, saveSituation, situationRuleId } from "../situations/settings.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now } from "../core/util.ts";
import { findThread } from "../agents/threads.ts";
import { playbookOf, playbookPath } from "./listen-cases.ts";
import { contextsOfChat, defaultContext, getContext, listContexts, removeContext, requireContext, saveContext, type ListenContext, type ListenKnobs } from "./listen.ts";
import { VERDICTS } from "./watch-trial.ts";

/**
 * The web side of 「关注」(连接 → 飞书会话): the list with the default “someone looks for you”, one 关注 in
 * full (settings, what its groups are talking about, lessons, cases, memories from its groups, recent
 * handling), a group's own view, and the owner's correction of a case. All owner only.
 */
const knobsSchema = z
  .object({
    listen: z.enum(["addressed", "relevant", "all"]).nullable(),
    pattern: z.string().max(200).nullable(),
    depth: z.enum(["answer", "investigate"]).nullable(),
    reply: z.enum(["none", "draft", "auto"]).nullable(),
    promoteAfter: z.number().int().min(1).max(50).nullable(),
    ownerAsks: z.enum(["notify", "draft", "answer"]).nullable(),
    othersAsks: z.enum(["leave", "handle"]).nullable(),
    backlog: z.enum(["off", "24h", "72h"]).nullable(),
    strictness: z.number().min(0.5).max(0.95).nullable(),
    perDay: z.number().int().min(1).max(500).nullable(),
    meetings: z.enum(["off", "ask", "listen"]).nullable(),
    seeOthers: z.boolean().nullable(),
    batchMinutes: z.number().min(0).max(24 * 60).nullable(),
    meetingSkip: z.array(z.string().trim().min(1).max(200)).max(50).nullable(),
    assist: z.enum(["off", "suggest", "act"]).nullable(),
    prefilter: z.boolean().nullable(),
    firstLook: z.boolean().nullable(),
    probes: z.array(z.string().trim().min(1).max(40)).max(8).nullable(),
    firstTo: z.enum(["chat", "dm", "ephemeral"]).nullable(),
  })
  .partial();
/** A body that does not parse is the client's mistake (400), not the server's. */
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, `参数错误：${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}
const briefSchema = z.object({ handle: z.array(z.string().trim().min(1).max(200)).max(12), skip: z.array(z.string().trim().min(1).max(200)).max(12), valid: z.string().trim().max(600) });

function groupNames(app: App, chats: string[]) {
  return chats.map((id) => ({
    id,
    name: one<{ name: string }>(app.db, "select name from lark_cursors where chat_id = ?", id)?.name
      || one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null limit 1", `lark:${id}`)?.title
      || id,
  }));
}

function caseStats(app: App, c: ListenContext) {
  return one<{ cases: number; corrections: number; ownReplies: number; last: string | null }>(
    app.db,
    `select count(*) cases, sum(decision in ('dropped','edited','disliked') or verdict is not null) corrections, sum(owner_reply is not null) ownReplies, max(created_at) last
     from reply_samples where context_id = ?`,
    c.id,
  )!;
}

function view(app: App, c: ListenContext) {
  const t = c.conversationId ? findThread(app, c.conversationId) : null;
  const s = caseStats(app, c);
  return {
    ...c,
    ...(c.kind === "situation" ? { ruleId: situationRuleId(c.id) } : {}),
    groups: groupNames(app, c.chats),
    // A matter's line, and whether it launched and is being watched (items/lifecycle.ts): the page says so.
    item: c.itemId ? one<{ id: string; title: string; status: string; phase: "watching" | null; watchUntil: string | null }>(app.db, "select id, title, status, phase, watch_until watchUntil from items where id = ?", c.itemId) ?? null : null,
    summaryAt: t?.summaryAt ?? null,
    stats: { cases: s.cases ?? 0, corrections: s.corrections ?? 0, ownReplies: s.ownReplies ?? 0, lastCase: s.last },
  };
}

/** Cases of a 关注 (or of one group), newest first. */
function casesOf(app: App, where: { contextId?: string; chatId?: string }, limit = 80) {
  const rows = all<Record<string, unknown>>(
    app.db,
    `select id, context_id, source, chat_id, chat_name, chat_kind, asker_name, ask, draft, decision, final, reason, owner_reply, verdict, note, scene, checked, handle_run, created_at, decided_at, settled_at
     from reply_samples where ${where.contextId ? "context_id = ?" : "chat_id = ?"} order by created_at desc limit ?`,
    where.contextId ?? where.chatId!, limit,
  );
  return rows;
}

/** Memories drawn from these groups' messages (their sources cited in source_refs). The owner's are stored without a user (only preferences carry one). */
function memoriesFrom(app: App, chats: string[], limit = 30) {
  if (!chats.length) return [];
  const sources = all<{ id: string }>(app.db, `select id from sources where deleted_at is null and (${chats.map(() => "uri = ? or uri like ?").join(" or ")})`, ...chats.flatMap((c) => [`lark:${c}`, `lark:${c}@%`])).map((r) => r.id);
  if (!sources.length) return [];
  return all<{ id: string; kind: string; subject: string | null; content: string; created_at: string; status: string }>(
    app.db,
    `select id, kind, subject, content, created_at, status from memories where status = 'active' and (user_id is null or user_id = 'owner') and exists (select 1 from json_each(memories.source_refs) r where ${sources.map(() => "r.value like ?").join(" or ")}) order by created_at desc limit ?`,
    ...sources.map((id) => `src:${id}%`), limit,
  );
}

/** The handling of a 关注's batches lately: runs in its conversation, with why the quiet ones said nothing. */
function handlingOf(app: App, c: ListenContext, limit = 30) {
  if (!c.conversationId) return [];
  return all<{ id: string; status: string; title: string; created_at: string; output: string | null }>(
    app.db, "select id, status, title, created_at, output from runs where kind = 'ask' and lane = ? order by created_at desc limit ?", c.conversationId, limit,
  ).map((r) => {
    const o = json<{ prefiltered?: string; stayQuiet?: string; quiet?: boolean; answer?: string }>(r.output, {});
    return { id: r.id, status: r.status, title: r.title, at: r.created_at, outcome: o.prefiltered ? "screened" : o.stayQuiet || o.quiet ? "quiet" : "handled", reason: o.prefiltered ?? o.stayQuiet ?? null };
  });
}

export function registerListenRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const owner = (req: FastifyRequest) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有本人可以看和改关注");
  };

  registerSituationRoutes(server, app, who);
  server.get("/api/listen", async (req) => {
    owner(req);
    defaultContext(app);
    const { kind } = parse(z.object({ kind: z.enum(["default", "place", "item", "situation"]).optional() }), req.query);
    return listContexts(app, { kind }).filter(c => c.userId === OWNER).map((c) => view(app, c));
  });

  server.get("/api/listen/:id", async (req) => {
    owner(req);
    const c = requireContext(app, (req.params as { id: string }).id);
    const t = c.conversationId ? findThread(app, c.conversationId) : null;
    const path = playbookPath(c);
    const playbookSource = one<{ id: string; updated_at: string }>(app.db, "select id, updated_at from sources where uri = ? and deleted_at is null order by captured_at desc limit 1", `work/${path}`);
    return {
      context: view(app, c),
      summary: t?.summary ?? "",
      playbook: { text: playbookOf(app, c, 20000), path, sourceId: playbookSource?.id ?? null, updatedAt: playbookSource?.updated_at ?? null },
      cases: casesOf(app, { contextId: c.id }),
      memories: memoriesFrom(app, c.chats),
      handling: handlingOf(app, c),
      coaching: one<{ id: string; status: string }>(app.db, "select id, status from runs where lane = ? order by created_at desc limit 1", `listen-coach:${c.id}`) ?? null,
    };
  });

  server.post("/api/listen", async (req) => {
    owner(req);
    const b = parse(z.object({ kind: z.enum(["place", "situation"]).optional(), recognize: z.string().max(1000).optional(), status: z.enum(["active", "paused"]).optional(), name: z.string().trim().min(1).max(80).optional(), chats: z.array(z.string()).max(200).optional(), note: z.string().max(2000).optional(), spec: z.string().optional(), spaceId: z.string().optional(), brief: briefSchema.optional(), knobs: knobsSchema.optional(), expiresAt: z.string().nullable().optional() }), req.body);
    const knobs = cleanKnobs(b.knobs);
    if (b.kind === "situation") return view(app, (await saveSituation(app, OWNER, { ...b, knobs })).context);
    if ((knobs.reply ?? "draft") !== "none" && !b.brief?.handle.length) throw new HttpError(400, "要在群里回复的关注先写要处理哪些消息（或回复方式选“只看不回”）");
    const { groupName, seedContext } = await import("./lark-watch.ts");
    const c = saveContext(app, { kind: "place", name: b.name, chats: b.chats, note: b.note, spec: b.spec, spaceId: b.spaceId, brief: b.brief ? { ...b.brief, at: now(), confirmedAt: now() } : undefined, knobs, expiresAt: b.expiresAt ?? null }, (id) => groupName(app, id));
    await seedContext(app, c).catch(() => 0);
    return view(app, getContext(app, c.id)!);
  });

  server.put("/api/listen/:id", async (req) => {
    owner(req);
    const c = requireContext(app, (req.params as { id: string }).id);
    const b = parse(z.object({ recognize: z.string().max(1000).optional(), name: z.string().trim().min(1).max(80).optional(), chats: z.array(z.string()).max(200).optional(), note: z.string().max(2000).optional(), spec: z.string().optional(), spaceId: z.string().nullable().optional(), brief: briefSchema.optional(), knobs: knobsSchema.optional(), status: z.enum(["active", "paused"]).optional(), expiresAt: z.string().nullable().optional() }), req.body);
    if (c.kind === "situation") return view(app, (await saveSituation(app, OWNER, { ...b, id: c.id, knobs: cleanKnobs(b.knobs) })).context);
    // The owner writing the brief here is confirming it.
    const brief = b.brief ? { ...b.brief, at: c.brief?.at ?? now(), confirmedAt: now() } : undefined;
    // A matter's groups follow its items: the owner's choice is kept as added / taken out (listen-items.ts).
    const groups = b.chats && c.kind === "item" && c.itemId ? (await import("./listen-items.ts")).itemChatsPatch(app, c.itemId, b.chats) : { chats: b.chats };
    const next = saveContext(app, { id: c.id, kind: c.kind, name: b.name, ...groups, note: b.note, spec: b.spec, spaceId: b.spaceId, brief, knobs: cleanKnobs(b.knobs), status: b.status, expiresAt: b.expiresAt });
    return view(app, next);
  });

  server.delete("/api/listen/:id", async (req) => {
    owner(req);
    const c = requireContext(app, (req.params as { id: string }).id);
    if (c.kind === "situation") await deleteSituation(app, OWNER, c.id);
    else removeContext(app, c.id);
    return { ok: true };
  });

  server.post("/api/listen/:id/coach", async (req) => {
    owner(req);
    const { queueCoach } = await import("./listen-coach.ts");
    const r = queueCoach(app, (req.params as { id: string }).id);
    return r ? { runId: r.id } : { queued: false, message: "已经有一次整理在排队" };
  });

  // Learn from history: the owner's past answers in these chats become this 关注's cases (read-only).
  server.post("/api/listen/:id/learn", async (req) => {
    owner(req);
    const b = parse(z.object({ chats: z.array(z.string().regex(/^oc_[\w-]+$/)).min(1).max(300), days: z.number().int().min(1).max(60).default(30) }), req.body);
    const { learnFromHistory } = await import("./listen-coach.ts");
    return learnFromHistory(app, (req.params as { id: string }).id, b);
  });

  server.get("/api/lark/chats/:id/detail", async (req) => {
    owner(req);
    const chatId = (req.params as { id: string }).id;
    const contexts = contextsOfChat(app, chatId).map((c) => view(app, c));
    const paused = listContexts(app).filter((c) => c.status !== "active" && c.chats.includes(chatId)).map((c) => view(app, c));
    const [group] = groupNames(app, [chatId]);
    return { chat: group, contexts, paused, cases: casesOf(app, { chatId }, 50), memories: memoriesFrom(app, [chatId]) };
  });

  // A matter's 关注 on the item page (channels/listen-items.ts).
  server.post("/api/items/:id/listen", async (req) => {
    owner(req);
    const b = parse(z.object({ on: z.boolean(), knobs: knobsSchema.optional() }), req.body);
    const { setItemListening } = await import("./listen-items.ts");
    const c = setItemListening(app, (req.params as { id: string }).id, b.on, cleanKnobs(b.knobs));
    return c ? view(app, c) : { ok: true };
  });

  // A rule that watches groups with an Agent becomes a 关注 (rules/to-listen.ts).
  server.post("/api/rules/:id/to-listen", async (req) => {
    owner(req);
    const { ruleToContext } = await import("../rules/to-listen.ts");
    return ruleToContext(app, (req.params as { id: string }).id);
  });

  server.put("/api/cases/:id", async (req) => {
    owner(req);
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ verdict: z.enum(Object.keys(VERDICTS) as [keyof typeof VERDICTS, ...(keyof typeof VERDICTS)[]]).nullable(), note: z.string().max(1000).optional() }), req.body);
    const r = run(app.db, "update reply_samples set verdict = ?, note = ?, decided_at = coalesce(decided_at, ?) where id = ?", b.verdict, b.note?.trim() || null, now(), id);
    if (!r.changes) throw new HttpError(404, "没有这个案例");
    return one(app.db, "select id, verdict, note from reply_samples where id = ?", id);
  });
}

/**
 * The web form's knobs: null clears a setting back to its default. Choosing how replies go ends a
 * trial of direct replies (`wantsAuto`), as setting it through the assistant's tool does; otherwise a
 * 关注 set back to drafts on the web kept asking to go direct.
 */
function cleanKnobs(k: z.infer<typeof knobsSchema> | undefined): Partial<ListenKnobs> {
  if (!k) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(k)) out[key] = v === null ? undefined : v;
  if ("reply" in k) out.wantsAuto = undefined;
  return out as Partial<ListenKnobs>;
}
