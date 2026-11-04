import type { TLSSocket } from "node:tls";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { addMember, findUser, getUser, identitiesOf, listUsers, OWNER, removeMember, unlinkIdentity, updateUser, userForToken } from "../core/users.ts";
import { sameOrigin, trustedLocal } from "../server/origin.ts";
import { approveUser, beginLogin, completeLogin, consumeLoginLink, createInvite, hasPrimary, listInvites, peekLoginLink, revokeInvite, validInvite } from "./login.ts";
import { enabledProviders, loginProvider, loginProviders } from "./providers.ts";
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
export const AUTH_PUBLIC = /^\/api\/auth\/(session|logout|[a-z][a-z0-9-]*\/(start|callback)|link\/[A-Za-z0-9_-]{20,64})(\?.*)?$/;
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
      login: {
        enabled: app.config.auth.enabled,
        primary: app.config.auth.primary ? providerView(app, app.config.auth.primary) : null,
        providers: enabledProviders(app).map((id) => providerView(app, id)!).filter(Boolean),
        invite: invite ? (inv ? { note: inv.note, allowAny: inv.allowAny } : { invalid: true }) : null,
      },
    };
  });

  server.get("/api/auth/:provider/start", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const o = parse(z.object({ purpose: z.enum(["login", "bind"]).default("login"), invite: z.string().max(80).optional(), return: z.string().max(300).optional() }), req.query);
    const base = baseUrl(app, req);
    try {
      const a = resolveAuth(app, req);
      if (o.purpose === "bind" && !a) throw new HttpError(401, "先登录再绑定");
      const url = beginLogin(app, { provider, purpose: o.purpose, redirectUri: callbackUrl(base, provider), userId: a?.userId, sessionHash: a?.sessionHash, invite: o.invite, returnTo: o.return });
      return reply.header("cache-control", "no-store").redirect(url);
    } catch (e) {
      return back(reply, base, `${o.purpose === "bind" ? "/account" : "/login"}?error=${encodeURIComponent((e as Error).message)}`);
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
        return back(reply, base, r.returnTo || `/account?bound=${encodeURIComponent(provider)}`);
      }
      startSession(req, reply, base, r.userId, r.via, r.restricted);
      return back(reply, base, r.returnTo || "/");
    } catch (e) {
      const msg = (e as Error).message;
      if (!(e instanceof HttpError)) console.warn(`[omem] 登录失败（${provider}）：${msg}`);
      return back(reply, base, `/login?error=${encodeURIComponent(msg)}`);
    }
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

  // ------------------------------------------------------- the owner manages
  const owner = (req: FastifyRequest) => {
    if (who(req) !== OWNER) throw new HttpError(403, "只有 omem 的主人能管理成员");
  };
  server.get("/api/users", async (req) => {
    owner(req);
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
    owner(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ approve: z.boolean().optional(), disabled: z.boolean().optional(), loginAny: z.boolean().optional(), name: z.string().min(1).max(60).optional() }), req.body);
    if (id === OWNER && (b.disabled || b.loginAny !== undefined)) throw new HttpError(400, "本人的账号不用这样设置");
    if (b.approve) approveUser(app, id);
    const u = updateUser(app, id, { name: b.name, disabled: b.disabled, settings: b.loginAny === undefined ? undefined : { loginAny: b.loginAny } });
    if (b.disabled) revokeUserSessions(app, id);
    return userView(app, u.id);
  });
  server.delete("/api/users/:id/sessions", async (req) => {
    owner(req);
    return { revoked: revokeUserSessions(app, (req.params as { id: string }).id) };
  });
  server.delete("/api/users/:id/identities", async (req) => {
    owner(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ channel: z.string(), externalId: z.string() }), req.body);
    if (!identitiesOf(app, id).some((i) => i.channel === b.channel && i.external_id === b.externalId)) throw new HttpError(404, "没有这个绑定");
    unlinkIdentity(app, b.channel, b.externalId);
    return { ok: true };
  });
  server.put("/api/users/:id/spaces", async (req) => {
    owner(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ space: z.string(), role: z.enum(["reader", "editor"]).nullable() }), req.body);
    if (!findSpace(app, b.space)) throw new HttpError(404, `空间不存在：${b.space}`);
    if (b.role) addMember(app, b.space, id, b.role);
    else removeMember(app, b.space, id);
    return { ok: true };
  });

  server.get("/api/invites", async (req) => {
    owner(req);
    return listInvites(app);
  });
  server.post("/api/invites", async (req) => {
    owner(req);
    const b = parse(z.object({ spaces: z.array(z.object({ space: z.string(), role: z.enum(["reader", "editor"]) })).max(50).default([]), allowAny: z.boolean().default(false), note: z.string().max(200).default(""), days: z.number().int().min(1).max(90).default(7) }), req.body);
    const r = createInvite(app, OWNER, b);
    return { id: r.id, url: `${baseUrl(app, req)}/#/login?invite=${r.token}` };
  });
  server.delete("/api/invites/:id", async (req) => {
    owner(req);
    revokeInvite(app, (req.params as { id: string }).id);
    return { ok: true };
  });
  // What to register in the provider's console (the redirect URL) and whether it can be used now.
  server.get("/api/auth/providers", async (req) => {
    owner(req);
    const base = baseUrl(app, req);
    return loginProviders().map((p) => ({ id: p.id, label: p.label, unavailable: p.unavailable(app), callback: callbackUrl(base, p.id) }));
  });
}
