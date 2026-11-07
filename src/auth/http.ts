import type { TLSSocket } from "node:tls";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { addMember, findUser, getUser, identitiesOf, listUsers, OWNER, removeMember, setUserRole, unlinkIdentity, updateUser, userForToken } from "../core/users.ts";
import { audit, auditLog, can, deleteRole, findRole, GLOBAL_PERMS, listRoles, requirePerm, saveRole, SPACE_PERMS } from "./permissions.ts";
import { connectionsOf, connectWithCredentials, disconnect, setFeatureOff } from "./connections.ts";
import { appView, setAppConfig } from "./apps.ts";
import { listWatches, removeWatch, syncWatches } from "../plugins/platforms.ts";
import { featuresOf, scopesFor } from "./features.ts";
import { sameOrigin, trustedLocal } from "../server/origin.ts";
import { approveUser, beginLogin, completeLogin, consumeLoginLink, larkAppLogin, createInvite, hasPrimary, listInvites, peekLoginLink, revokeInvite, validInvite } from "./login.ts";
import { canLogIn, enabledProviders, loginProvider, loginProviders, offeredConnectors } from "./providers.ts";
import { clearSessionCookie, cookies, createSession, lastSeen, liftRestriction, listSessions, revokeSession, revokeSessionHash, revokeUserSessions, SESSION_COOKIE, sessionCookie, sessionFor } from "./sessions.ts";

/**
 * Who a request is (docs/v2/multi-user.md): a bearer token (CLI, paired devices, outside agents), a
 * login session cookie (a browser on another machine), or this machine itself (the owner, unless a
 * token is configured). With logging in on, a request a reverse proxy forwarded is not this machine.
 */
export type RequestAuth = { userId: string; via: "token" | "session" | "local"; restricted: boolean; sessionHash: string | null };

export function bearerToken(req: FastifyRequest) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  // In the query only for what the browser loads itself (images, downloads, the event stream).
  return req.method === "GET" || req.method === "HEAD" ? ((req.query as { token?: string })?.token ?? "") : "";
}

export function resolveAuth(app: App, req: FastifyRequest): RequestAuth | null {
  const token = bearerToken(req);
  if (token) {
    const userId = userForToken(app, token);
    return userId ? { userId, via: "token", restricted: false, sessionHash: null } : null;
  }
  const s = sessionFor(app, cookies(req.raw)[SESSION_COOKIE]);
  if (s) {
    // The cookie goes along with another site's form too: a write must come from this page.
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req.raw)) return null;
    return { userId: s.userId, via: "session", restricted: s.restricted, sessionHash: s.idHash };
  }
  if (!app.config.token && trustedLocal(req.raw, req.ip ?? "", { refuseProxied: app.config.auth.enabled })) return { userId: OWNER, via: "local", restricted: false, sessionHash: null };
  return null;
}

/** Routes that find out who is asking themselves (logging in has to work before there is anyone). */
export const AUTH_PUBLIC = /^\/api\/auth\/(session|logout|lark\/app|[a-z][a-z0-9-]*\/(start|callback)|link\/[A-Za-z0-9_-]{20,64})(\?.*)?$/;
/** What a pending user or a restricted session may still reach: who am I, my account, binding, signing out. */
export const AUTH_LIMITED = /^\/api\/(me|auth\/[^?]*)(\?.*)?$/;

/** Where this page is reached: `webUrl`, else the address the browser used. */
function baseUrl(app: App, req: FastifyRequest) {
  const configured = app.config.webUrl?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || ((req.raw.socket as TLSSocket).encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost");
  return `${proto}://${host}`;
}
export const callbackUrl = (base: string, provider: string) => `${base}/api/auth/${provider}/callback`;

const userView = (app: App, id: string) => {
  const u = getUser(app, id);
  return { id: u.id, name: u.name, role: u.role, status: u.status, email: u.email, avatar: u.avatar };
};
const providerView = (app: App, id: string) => {
  const p = loginProvider(id);
  return p ? { id: p.id, label: p.label, unavailable: p.unavailable(app) } : null;
};
/** A provider on the login page, with what can be turned on in the same authorization (background access comes with any). */
const loginView = (app: App, id: string) => {
  const p = providerView(app, id);
  return p ? { ...p, features: featuresOf(id).filter((f) => f.id !== "offline").map((f) => ({ id: f.id, label: f.label, description: f.description })) } : null;
};
const identityView = (i: ReturnType<typeof identitiesOf>[number]) => ({
  channel: i.channel,
  externalId: i.external_id,
  kind: i.kind,
  display: i.display,
  appId: i.app_id,
  provider: loginProviders().find((p) => p.channel === i.channel)?.label ?? i.channel,
  createdAt: i.created_at,
  verifiedAt: i.verified_at,
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#222}main{max-width:360px;padding:32px 24px;text-align:center}button{font:inherit;padding:10px 28px;border-radius:8px;border:0;background:#222;color:#fff;cursor:pointer}p{color:#555}@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}button{background:#eee;color:#111}p{color:#aaa}}</style></head><body><main>${body}</main></body></html>`;
}

export function registerAuthRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string, authOf: (req: FastifyRequest) => RequestAuth | null) {
  const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const secure = (base: string) => base.startsWith("https:");
  const back = (reply: FastifyReply, base: string, path: string) => reply.header("cache-control", "no-store").redirect(`${base}/#${path}`);
  const startSession = (req: FastifyRequest, reply: FastifyReply, base: string, userId: string, via: string, restricted: boolean) => {
    const s = createSession(app, userId, { via, restricted, ip: req.ip ?? "", userAgent: String(req.headers["user-agent"] ?? "") });
    reply.header("set-cookie", sessionCookie(s.token, s.maxAge, secure(base)));
  };

  // ------------------------------------------------------------ public routes
  server.get("/api/auth/session", async (req) => {
    const a = resolveAuth(app, req);
    const u = a ? findUser(app, a.userId) : null;
    const { invite } = parse(z.object({ invite: z.string().max(80).optional() }), req.query);
    const inv = invite ? validInvite(app, invite) : null;
    return {
      user: u && !u.disabledAt ? userView(app, u.id) : null,
      via: u ? a!.via : null,
      restricted: !!a?.restricted,
      // The Feishu web app (/lark/) asks Feishu for a sign-in code with this app id.
      larkApp: app.config.lark.webApp && app.config.lark.appId ? app.config.lark.appId : null,
      login: {
        enabled: app.config.auth.enabled,
        primary: app.config.auth.primary ? loginView(app, app.config.auth.primary) : null,
        providers: enabledProviders(app).map((id) => loginView(app, id)).filter((p) => !!p),
        invite: invite ? (inv ? { note: inv.note, allowAny: inv.allowAny } : { invalid: true }) : null,
      },
    };
  });

  server.get("/api/auth/:provider/start", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const o = parse(z.object({ purpose: z.enum(["login", "bind", "connect"]).default("login"), features: z.string().max(300).optional(), scopes: z.string().regex(/^[\w:., -]*$/).max(1000).optional(), invite: z.string().max(80).optional(), return: z.string().max(300).optional() }), req.query);
    const base = baseUrl(app, req);
    try {
      const a = resolveAuth(app, req);
      if (o.purpose !== "login" && !a) throw new HttpError(401, "先登录再绑定");
      if (o.purpose === "connect" && !offeredConnectors(app).includes(provider)) throw new HttpError(403, "omem 的主人没有打开这个平台的连接");
      // Connecting asks for just the scopes of the features being turned on (incremental authorization).
      // A missing scope a call ran into (lark-user.ts larkAs) is asked for by name, with background access.
      const named = (o.scopes ?? "").split(/[\s,]+/).filter(Boolean).slice(0, 30);
      // Logging in asks for nothing beyond who the person is, unless they ticked features on the login page.
      const features = (o.features ?? "").split(",").filter(Boolean);
      const scopes = o.purpose === "connect" ? [...new Set([...scopesFor(provider, features), ...named, ...(named.length ? scopesFor(provider, ["offline"]) : [])])] : o.purpose === "login" ? scopesFor(provider, features) : [];
      const url = beginLogin(app, { provider, purpose: o.purpose, redirectUri: callbackUrl(base, provider), userId: a?.userId, sessionHash: a?.sessionHash, invite: o.invite, returnTo: o.return, scopes });
      return reply.header("cache-control", "no-store").redirect(url);
    } catch (e) {
      return back(reply, base, `${o.purpose === "login" ? "/login" : "/account"}?error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  server.get("/api/auth/:provider/callback", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const o = parse(z.object({ code: z.string().max(512).optional(), state: z.string().max(128).default(""), error: z.string().max(200).optional() }).passthrough(), req.query);
    const base = baseUrl(app, req);
    try {
      const r = await completeLogin(app, { provider, state: o.state, code: o.code, error: o.error });
      if (r.kind === "bound") {
        if (r.lifted) liftRestriction(app, r.lifted);
        return back(reply, base, r.returnTo || `/account?${r.connected ? "connected" : "bound"}=${encodeURIComponent(provider)}`);
      }
      startSession(req, reply, base, r.userId, r.via, r.restricted);
      return back(reply, base, r.returnTo || "/");
    } catch (e) {
      const msg = (e as Error).message;
      if (!(e instanceof HttpError)) console.warn(`[omem] 登录失败（${provider}）：${msg}`);
      return back(reply, base, `/login?error=${encodeURIComponent(msg)}`);
    }
  });

  // The Feishu web app (`/lark/`): a code from tt.requestAccess signs this browser in, without a login page.
  server.post("/api/auth/lark/app", async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().min(1).max(512) }), req.body);
    const base = baseUrl(app, req);
    const r = await larkAppLogin(app, code);
    if (r.kind === "session") startSession(req, reply, base, r.userId, r.via, r.restricted);
    reply.header("cache-control", "no-store");
    return { ok: true, userId: r.userId, restricted: r.kind === "session" ? r.restricted : false };
  });

  // A one-time link from the bot (`/login` in a private chat): opening it shows a button, pressing it signs in.
  server.get("/api/auth/link/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("x-robots-tag", "noindex");
    if (!peekLoginLink(app, code)) return page("链接已失效", `<h2>链接已失效</h2><p>登录链接 5 分钟内有效，只能用一次。在私聊里再发一次 /login。</p>`);
    return page("登录 omem", `<h2>登录 omem</h2><p>这个链接只能用一次，5 分钟内有效。</p><form method="post"><button type="submit">登录</button></form>`);
  });
  server.post("/api/auth/link/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    const base = baseUrl(app, req);
    const r = consumeLoginLink(app, code);
    if (!r) return reply.type("text/html; charset=utf-8").send(page("链接已失效", `<h2>链接已失效</h2><p>在私聊里再发一次 /login。</p>`));
    const u = getUser(app, r.userId);
    const restricted = !!app.config.auth.primary && !u.settings.loginAny && !hasPrimary(app, r.userId);
    startSession(req, reply, base, r.userId, "link", restricted);
    return reply.code(303).header("cache-control", "no-store").header("location", `${base}/#/`).send();
  });

  server.post("/api/auth/logout", async (req, reply) => {
    const s = sessionFor(app, cookies(req.raw)[SESSION_COOKIE]);
    if (s && sameOrigin(req.raw)) revokeSessionHash(app, s.idHash);
    reply.header("set-cookie", clearSessionCookie(baseUrl(app, req).startsWith("https:")));
    return { ok: true };
  });

  // --------------------------------------------------------------- one's own
  server.get("/api/auth/account", async (req) => {
    const id = who(req);
    const a = authOf(req);
    const primary = app.config.auth.primary;
    return {
      user: { ...userView(app, id), loginAny: !!getUser(app, id).settings.loginAny },
      via: a?.via ?? "local",
      restricted: !!a?.restricted,
      identities: identitiesOf(app, id).map(identityView),
      sessions: listSessions(app, id, a?.sessionHash),
      // Binding is open for every provider that can log in.
      providers: enabledProviders(app).map((p) => ({ ...providerView(app, p)!, primary: p === primary })),
      ownerSeesPersonal: id !== OWNER,
    };
  });
  // Connected platforms (src/auth/connections.ts): what is on, whether it works in the background; disconnecting.
  server.get("/api/auth/connections", async (req) => ({
    connections: connectionsOf(app, who(req)),
    // Every provider with something to turn on, logging in with it or not (a plugin's may be for connecting only).
    // The platforms offered here (Feishu, the login ones, those the owner turned on): each with what can be
    // turned on, or for a key connection the fields to fill in.
    available: offeredConnectors(app)
      .map((id) => loginProvider(id)!)
      .filter((p) => p.credentials || featuresOf(p.id).length)
      .map((p) => ({ ...providerView(app, p.id)!, group: p.group ?? "", docs: p.docs ?? "", identity: canLogIn(p), credentials: p.credentials?.fields.map((f) => ({ key: f.key, label: f.label, secret: !!f.secret, optional: !!f.optional, hint: f.hint ?? "" })) ?? null, features: featuresOf(p.id).map((f) => ({ id: f.id, label: f.label, description: f.description })) })),
    may: can(app, who(req), "connector.use"),
  }));
  // Connect a platform by filling in a key (an API key, a user name and password).
  server.post("/api/auth/connections/:provider/credentials", async (req) => {
    const { provider } = req.params as { provider: string };
    requirePerm(app, who(req), "connector.use");
    if (!offeredConnectors(app).includes(provider)) throw new HttpError(403, "omem 的主人没有打开这个平台的连接");
    const { values } = parse(z.object({ values: z.record(z.string(), z.string().max(4000)) }), req.body);
    await connectWithCredentials(app, who(req), provider, values);
    audit(app, who(req), "connection.add", who(req), { provider });
    return { connections: connectionsOf(app, who(req)) };
  });
  // What this person keeps in sync from connected platforms (src/plugins/platforms.ts); set up by asking an agent.
  server.get("/api/auth/watches", async (req) => ({ watches: listWatches(app, who(req)) }));
  server.delete("/api/auth/watches/:id", async (req) => {
    if (!removeWatch(app, who(req), (req.params as { id: string }).id)) throw new HttpError(404, "没有这项");
    return { watches: listWatches(app, who(req)) };
  });
  server.post("/api/auth/watches/:id/sync", async (req) => {
    const id = (req.params as { id: string }).id;
    if (!listWatches(app, who(req)).some((w) => w.id === id)) throw new HttpError(404, "没有这项");
    const report = await syncWatches(app, { id });
    return { report, watches: listWatches(app, who(req)) };
  });
  // Turn a feature off in omem or back on (the platform's grant stays).
  server.put("/api/auth/connections/:provider/features/:feature", async (req) => {
    const { provider, feature } = req.params as { provider: string; feature: string };
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    setFeatureOff(app, who(req), provider, feature, !on);
    audit(app, who(req), on ? "connection.feature.on" : "connection.feature.off", who(req), { provider, feature });
    return { connections: connectionsOf(app, who(req)) };
  });
  server.delete("/api/auth/connections/:provider", async (req) => {
    const { provider } = req.params as { provider: string };
    disconnect(app, who(req), provider);
    audit(app, who(req), "connection.remove", who(req), { provider });
    return { ok: true };
  });
  server.delete("/api/auth/sessions/:id", async (req) => {
    revokeSession(app, who(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  server.delete("/api/auth/identities", async (req) => {
    const b = parse(z.object({ channel: z.string(), externalId: z.string() }), req.body);
    const id = who(req);
    const mine = identitiesOf(app, id).find((i) => i.channel === b.channel && i.external_id === b.externalId);
    if (!mine) throw new HttpError(404, "没有这个绑定");
    if (mine.kind === "alias") throw new HttpError(400, "这是渠道里的身份（机器人靠它认人），不能自己解绑");
    const primary = app.config.auth.primary ? loginProvider(app.config.auth.primary) : null;
    if (primary && primary.channel === b.channel && id !== OWNER) throw new HttpError(400, `${primary.label}是主要登录方，要解绑请联系 omem 的主人`);
    unlinkIdentity(app, b.channel, b.externalId);
    return { ok: true };
  });

  // --------------------------------------------- managing people and roles
  // `users.manage` (the owner, or a custom role); roles themselves and who has which global role are
  // the owner's alone, so nobody can hand themselves more than they have.
  const manager = (req: FastifyRequest) => requirePerm(app, who(req), "users.manage");
  const ownerOnly = (req: FastifyRequest, what: string) => {
    if (who(req) !== OWNER) throw new HttpError(403, `只有 omem 的主人能${what}`);
  };
  const notOwner = (id: string) => {
    if (id === OWNER) throw new HttpError(400, "本人的账号不用这样设置");
  };
  server.get("/api/users", async (req) => {
    manager(req);
    const members = all<{ space_id: string; user_id: string; role: string }>(app.db, "select space_id, user_id, role from space_members");
    return listUsers(app)
      .filter((u) => u.kind === "person")
      .map((u) => ({
        ...userView(app, u.id),
        loginAny: !!u.settings.loginAny,
        disabledAt: u.disabledAt,
        createdAt: u.createdAt,
        lastSeenAt: lastSeen(app, u.id),
        identities: identitiesOf(app, u.id).map(identityView),
        spaces: members.filter((m) => m.user_id === u.id).map((m) => ({ space: m.space_id, name: findSpace(app, m.space_id)?.name ?? m.space_id, role: m.role })),
      }))
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  });
  server.patch("/api/users/:id", async (req) => {
    manager(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ approve: z.boolean().optional(), role: z.string().optional(), disabled: z.boolean().optional(), loginAny: z.boolean().optional(), name: z.string().min(1).max(60).optional() }), req.body);
    if (b.disabled !== undefined || b.loginAny !== undefined || b.role) notOwner(id);
    if (b.role) {
      ownerOnly(req, "分配全局角色");
      setUserRole(app, id, b.role);
      audit(app, who(req), "user.role", id, { role: b.role });
    }
    if (b.approve) {
      approveUser(app, id);
      audit(app, who(req), "user.approve", id);
    }
    const u = updateUser(app, id, { name: b.name, disabled: b.disabled, settings: b.loginAny === undefined ? undefined : { loginAny: b.loginAny } });
    if (b.disabled !== undefined) audit(app, who(req), b.disabled ? "user.disable" : "user.enable", id);
    if (b.loginAny !== undefined) audit(app, who(req), "user.login-any", id, { on: b.loginAny });
    if (b.disabled) revokeUserSessions(app, id);
    return userView(app, u.id);
  });
  server.delete("/api/users/:id/sessions", async (req) => {
    manager(req);
    const { id } = req.params as { id: string };
    audit(app, who(req), "user.sign-out", id);
    return { revoked: revokeUserSessions(app, id) };
  });
  server.delete("/api/users/:id/identities", async (req) => {
    manager(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ channel: z.string(), externalId: z.string() }), req.body);
    if (!identitiesOf(app, id).some((i) => i.channel === b.channel && i.external_id === b.externalId)) throw new HttpError(404, "没有这个绑定");
    unlinkIdentity(app, b.channel, b.externalId);
    audit(app, who(req), "identity.unlink", id, b);
    return { ok: true };
  });
  /** Add, change or remove someone in a space; a personal space stays its owner's alone. */
  const setMembership = (req: FastifyRequest, space: string, userId: string, role: string | null) => {
    const s = findSpace(app, space);
    if (!s) throw new HttpError(404, `空间不存在：${space}`);
    if (s.kind === "personal") throw new HttpError(400, "个人空间不能加人或移出");
    const u = getUser(app, userId);
    if (u.kind !== "person" && role) throw new HttpError(400, "设备的账号在“设备与共享”里设置");
    if (role) addMember(app, space, userId, role);
    else removeMember(app, space, userId);
    audit(app, who(req), role ? "space.member" : "space.remove", space, { user: userId, role });
  };
  server.put("/api/users/:id/spaces", async (req) => {
    manager(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ space: z.string(), role: z.string().nullable() }), req.body);
    setMembership(req, b.space, id, b.role);
    return { ok: true };
  });

  // A space's own manager (space.manage, checked by the route) looks after its members.
  server.get("/api/spaces/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const rows = all<{ user_id: string; role: string }>(app.db, "select user_id, role from space_members where space_id = ?", id);
    return rows.map((r) => ({ ...userView(app, r.user_id), spaceRole: r.role === "owner" ? "manager" : r.role }));
  });
  server.put("/api/spaces/:id/members/:user", async (req) => {
    const { id, user } = req.params as { id: string; user: string };
    const b = parse(z.object({ role: z.string().nullable() }), req.body);
    if (user === who(req) && who(req) !== OWNER) throw new HttpError(400, "不能改自己在这个空间的角色");
    setMembership(req, id, user, b.role);
    return { ok: true };
  });

  server.get("/api/access/roles", async () => ({ roles: listRoles(app), global: GLOBAL_PERMS, space: SPACE_PERMS }));
  server.post("/api/access/roles", async (req) => {
    ownerOnly(req, "建角色");
    const b = parse(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).optional(), name: z.string().min(1).max(40), scope: z.enum(["global", "space"]), description: z.string().max(200).optional(), permissions: z.array(z.string()).max(60) }), req.body);
    const r = saveRole(app, b);
    audit(app, who(req), "role.save", r.id, { permissions: r.permissions });
    return r;
  });
  server.put("/api/access/roles/:id", async (req) => {
    ownerOnly(req, "改角色");
    const { id } = req.params as { id: string };
    const old = findRole(app, id);
    if (!old) throw new HttpError(404, "没有这个角色");
    const b = parse(z.object({ name: z.string().min(1).max(40).optional(), description: z.string().max(200).optional(), permissions: z.array(z.string()).max(60).optional() }), req.body);
    const r = saveRole(app, { id, name: b.name ?? old.name, scope: old.scope, description: b.description ?? old.description, permissions: b.permissions ?? old.permissions });
    audit(app, who(req), "role.save", id, { permissions: r.permissions });
    return r;
  });
  server.delete("/api/access/roles/:id", async (req) => {
    ownerOnly(req, "删角色");
    const { id } = req.params as { id: string };
    deleteRole(app, id);
    audit(app, who(req), "role.delete", id);
    return { ok: true };
  });
  server.get("/api/access/audit", async (req) => {
    manager(req);
    return auditLog(app);
  });

  server.get("/api/invites", async (req) => {
    manager(req);
    return listInvites(app);
  });
  server.post("/api/invites", async (req) => {
    manager(req);
    const b = parse(
      z.object({ role: z.string().default("member"), spaces: z.array(z.object({ space: z.string(), role: z.string() })).max(50).default([]), allowAny: z.boolean().default(false), note: z.string().max(200).default(""), days: z.number().int().min(1).max(90).default(7) }),
      req.body,
    );
    if (b.role !== "member") ownerOnly(req, "邀请成员以外的角色");
    const r = createInvite(app, who(req), b);
    audit(app, who(req), "invite.create", r.id, { role: b.role, spaces: b.spaces });
    return { id: r.id, url: `${baseUrl(app, req)}/#/login?invite=${r.token}` };
  });
  server.delete("/api/invites/:id", async (req) => {
    manager(req);
    const { id } = req.params as { id: string };
    revokeInvite(app, id);
    audit(app, who(req), "invite.revoke", id);
    return { ok: true };
  });
  // What to register in the provider's console (the redirect URL) and whether it can be used now.
  server.get("/api/auth/providers", async (req) => {
    manager(req);
    const base = baseUrl(app, req);
    const offered = new Set(app.config.auth.connectors);
    return loginProviders().map((p) => ({
      id: p.id,
      label: p.label,
      unavailable: p.unavailable(app),
      callback: p.authorizeUrl ? callbackUrl(base, p.id) : null,
      identity: canLogIn(p),
      group: p.group ?? "",
      docs: p.docs ?? "",
      credentials: !!p.credentials,
      offered: p.id === "lark" || offered.has(p.id),
      app: appView(app, p),
    }));
  });
  // What the owner fills in for a platform's app (client id and secret…): kept in secrets/, never sent back whole.
  server.put("/api/auth/providers/:id/app", async (req) => {
    manager(req);
    const { id } = req.params as { id: string };
    const { values } = parse(z.object({ values: z.record(z.string(), z.string().max(4000).nullable()) }), req.body);
    const fields = setAppConfig(app, id, values);
    audit(app, who(req), "connector.app", id, { fields: Object.keys(values) });
    const p = loginProvider(id)!;
    return { unavailable: p.unavailable(app), app: fields };
  });
}
