import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { HttpError } from "./util.ts";
import { nodeId, peerJson } from "./peers.ts";
import { upsertSchedule } from "./scheduler.ts";
import { fedAnswer, fedAsk, grantsFor, knownCards, nodeCard, refreshCards, setGrants } from "./mesh.ts";
import { fedChanges, fedSearch, fedSource, listShareAccounts, listSubscriptions, revokeShareAccount, setShares, shareInvite, sharesFor, subscribe, syncSubscription, unsubscribe } from "./federation.ts";

/**
 * Routes for sharing between servers (src/core/federation.ts). /api/fed/* is what another server calls
 * with its service account's token (only what its grants allow); /api/peer/shares and
 * /api/peer/subscriptions are the owner's (peers.manage, src/auth/routes.ts).
 */
export function registerFederationRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const shareSchema = z.object({ space: z.string(), mode: z.enum(["query", "sync"]).default("query"), kinds: z.array(z.string().regex(/^[a-z-]+$/)).max(20).optional() });

  // ------------------------------------------------ another server reading
  server.get("/api/fed/info", async (req) => ({ node: nodeId(app), shares: sharesFor(app, who(req)) }));
  server.post("/api/fed/search", async (req) => {
    const b = parse(z.object({ query: z.string().min(1).max(500), spaces: z.array(z.string()).max(50).optional(), limit: z.number().int().min(1).max(30).optional() }), req.body);
    return fedSearch(app, who(req), b);
  });
  server.get("/api/fed/source/:id", async (req) => fedSource(app, who(req), (req.params as { id: string }).id));
  server.get("/api/fed/changes", async (req) => {
    const o = parse(z.object({ space: z.string(), since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return fedChanges(app, who(req), o.space, o.since, o.limit);
  });

  // This node's card, and asking one of its Agents (mesh.ts): by what the caller is granted.
  server.get("/api/fed/card", async (req) => nodeCard(app, who(req)));
  server.post("/api/fed/ask", async (req) => {
    const b = parse(z.object({ agent: z.string().min(1).max(80), question: z.string().min(1).max(20_000), from: z.object({ run: z.string().max(40).optional(), asker: z.string().max(80).optional() }).optional() }), req.body);
    return fedAsk(app, who(req), b);
  });
  server.get("/api/fed/ask/:id", async (req) => fedAnswer(app, who(req), (req.params as { id: string }).id));

  // --------------------------------------------------- what this one shares
  server.get("/api/peer/shares", async () => listShareAccounts(app).map((a) => ({ ...a, grants: grantsFor(app, a.id) })));
  server.put("/api/peer/grants/:user", async (req) => {
    const b = parse(z.object({ grants: z.array(z.object({ kind: z.enum(["agent", "ai", "card"]), name: z.string().min(1).max(80), daily: z.number().int().min(1).max(100000).nullable().optional() })).max(100) }), req.body);
    return { grants: setGrants(app, (req.params as { user: string }).user, b.grants) };
  });
  // Copies of other devices' data kept here by themselves (peer-backup.ts).
  server.get("/api/peer/backups", async () => ({ backups: (await import("./peer-backup.ts")).listBackups(app) }));
  server.put("/api/peer/backups", async (req) => {
    const b = parse(z.object({ peer: z.string().min(1).max(80), to: z.string().min(1).max(500), everyHours: z.number().int().min(1).max(720).optional(), at: z.string().max(5).nullable().optional(), parts: z.array(z.enum(["library", "files", "repos", "runs"])).optional() }), req.body);
    const m = await import("./peer-backup.ts");
    m.setBackup(app, b);
    return { backups: m.listBackups(app) };
  });
  server.delete("/api/peer/backups/:peer", async (req) => {
    const m = await import("./peer-backup.ts");
    m.removeBackup(app, (req.params as { peer: string }).peer);
    return { backups: m.listBackups(app) };
  });
  // Starts in the background: a pull can take minutes; the list shows how it went.
  server.post("/api/peer/backups/:peer/run", async (req) => {
    const m = await import("./peer-backup.ts");
    void m.runBackup(app, (req.params as { peer: string }).peer).catch((e) => console.warn("[omem] 备份出错：", (e as Error).message));
    return { started: true };
  });
  // Writes into mirror spaces waiting for their home (mesh-write.ts): list, send now, drop one.
  server.get("/api/peer/outbox", async () => ({ entries: (await import("./mesh-write.ts")).listOutbox(app) }));
  server.post("/api/peer/outbox/flush", async () => (await import("./mesh-write.ts")).flushOutbox(app));
  server.delete("/api/peer/outbox/:id", async (req) => (await import("./mesh-write.ts")).dropOutbox(app, (req.params as { id: string }).id));
  // The cards of the paired nodes (settings → 设备); `refresh` asks them again now.
  server.get("/api/peer/cards", async (req) => ({ cards: (req.query as { refresh?: string }).refresh ? await refreshCards(app) : knownCards(app) }));
  server.post("/api/peer/shares", async (req) => {
    const b = parse(z.object({ label: z.string().min(1).max(40), shares: z.array(shareSchema).min(1).max(50), url: z.string().url().optional() }), req.body);
    const r = shareInvite(app, b);
    return { code: r.code, urls: r.urls, userId: r.userId };
  });
  server.put("/api/peer/shares/:user", async (req) => {
    const b = parse(z.object({ shares: z.array(shareSchema).max(50) }), req.body);
    setShares(app, (req.params as { user: string }).user, b.shares);
    return { ok: true };
  });
  server.delete("/api/peer/shares/:user", async (req) => {
    revokeShareAccount(app, (req.params as { user: string }).user);
    return { ok: true };
  });

  // ------------------------------------------- what this one follows elsewhere
  server.get("/api/peer/subscriptions", async () => listSubscriptions(app));
  // What a paired server shares with this one (to pick from when subscribing).
  server.get("/api/peer/offers/:peer", async (req) => peerJson<{ node: string; shares: unknown[] }>(app, (req.params as { peer: string }).peer, "/api/fed/info", undefined, 15_000));
  server.post("/api/peer/subscriptions", async (req) => {
    const b = parse(z.object({ peer: z.string().min(1), remoteSpace: z.string().min(1), localSpace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/).optional(), mode: z.enum(["query", "sync"]).optional() }), req.body);
    const s = await subscribe(app, b);
    if (s.mode === "sync") ensureSyncSchedule(app);
    return s;
  });
  server.delete("/api/peer/subscriptions/:id", async (req) => {
    unsubscribe(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  server.post("/api/peer/subscriptions/:id/sync", async (req) => syncSubscription(app, (req.params as { id: string }).id));
}

/** Sync subscriptions are followed every half hour (settings → 定时任务 can change it). */
export function ensureSyncSchedule(app: App) {
  const has = app.db.prepare("select 1 from schedules where kind = 'peer-sync'").get();
  if (!has) upsertSchedule(app, { id: "peer-sync", kind: "peer-sync", cron: "*/30 * * * *", enabled: true, config: {} });
}
