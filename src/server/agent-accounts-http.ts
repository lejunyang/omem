import { allCredentials, logoutCredential, myCredentials, setCredentialSharing, startCredentialLogin } from "../agents/credentials.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { configSchema, saveConfig } from "../core/config.ts";
import { findUser, OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { isOwner } from "../auth/permissions.ts";
import { accountEntry, allAccounts, checkAccount, myAccounts, readMyQuota, removeAccount, saveToken, startLogin } from "../agents/accounts.ts";
import { sandboxSupport } from "../agents/sandbox.ts";

/**
 * Each person's own AI accounts over HTTP (docs/v2/agent-accounts.md). `/api/me/…` always acts on the
 * caller's own account folder, so a member can never reach another's; the overview, the rules and
 * removing a member's login are the owner's (src/auth/routes.ts).
 */
export function registerAgentAccountRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const kindOf = (req: FastifyRequest) => (req.params as { kind: string }).kind;
  server.get("/api/credentials", async req => myCredentials(app, who(req)));
  server.post("/api/credentials/:kind/login", async req => startCredentialLogin(app, who(req), kindOf(req)));
  server.put("/api/credentials/:kind/sharing", async req => setCredentialSharing(app, who(req), kindOf(req), req.body));
  server.delete("/api/credentials/:kind", async req => {
    await logoutCredential(app, who(req), kindOf(req));
    return { ok: true };
  });
  server.get("/api/credentials/all", async () => allCredentials(app));
  server.delete("/api/credentials/:user/:kind", async req => {
    const { user, kind } = req.params as { user: string; kind: string };
    if (!findUser(app, user) || user === OWNER) throw new HttpError(404, "没有这个成员");
    await logoutCredential(app, user, kind, who(req));
    return { ok: true };
  });

  const backendOf = (req: FastifyRequest) => {
    const id = (req.params as { backend: string }).backend;
    if (!accountEntry(app, id)) throw new HttpError(404, `后端 ${id} 不能按人登录`);
    return id;
  };
  /** The caller, when they can have accounts of their own here. */
  const member = (req: FastifyRequest) => {
    const userId = who(req);
    if (userId === OWNER || isOwner(app, userId)) throw new HttpError(400, "本人用这台机器上已有的登录，不用在这里登录");
    const s = sandboxSupport();
    if (!s.ok) throw new HttpError(400, `这台机器不能按人登录 AI 账号：${s.reason}`);
    return userId;
  };

  server.get("/api/me/agent-accounts", async (req) => myAccounts(app, who(req)));
  // `method`: the backend's own login (`native`, the default) or a plugin's (`<plugin>:<id>`).
  server.post("/api/me/agent-accounts/:backend/login", async (req) => {
    const userId = member(req);
    const body = z.object({ method: z.string().max(80).optional() }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "登录方式不对");
    return startLogin(app, userId, backendOf(req), body.data.method || "native");
  });
  server.post("/api/me/agent-accounts/:backend/token", async (req) => {
    const userId = member(req);
    const body = z.object({ token: z.string().min(1).max(4096) }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "要粘贴令牌");
    return saveToken(app, userId, backendOf(req), body.data.token);
  });
  server.post("/api/me/agent-accounts/:backend/check", async (req) => {
    const userId = member(req);
    return checkAccount(app, userId, backendOf(req));
  });
  // The plan quota of their own account, read now in their sandbox.
  server.post("/api/me/agent-accounts/:backend/quota", async (req) => {
    const userId = member(req);
    return { quota: await readMyQuota(app, userId, backendOf(req)) };
  });
  server.delete("/api/me/agent-accounts/:backend", async (req) => {
    const userId = member(req);
    await removeAccount(app, userId, backendOf(req));
    return { ok: true };
  });

  server.get("/api/agent-accounts", async () => allAccounts(app));
  server.put("/api/agent-accounts/:backend/policy", async (req) => {
    const backend = backendOf(req);
    const body = z.object({ policy: z.enum(["owner", "own", "own-or-other"]) }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, "规则只能是 owner（借用本人的）、own（只能用自己的）或 own-or-other（没登录时换别的后端）");
    const next = configSchema.parse(structuredClone(app.config));
    next.agents.accounts = { ...next.agents.accounts, [backend]: body.data.policy };
    saveConfig(next, app.home);
    Object.assign(app.config, next);
    return { backend, policy: body.data.policy };
  });
  server.delete("/api/agent-accounts/:user/:backend", async (req) => {
    const { user } = req.params as { user: string };
    if (!findUser(app, user) || user === OWNER) throw new HttpError(404, "没有这个成员");
    await removeAccount(app, user, backendOf(req));
    return { ok: true };
  });
}
