import type { FastifyRequest } from "fastify";
import type { App } from "../core/app.ts";
import { findUser, OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import type { PeerAgentScope } from "../agents/peer-agent.ts";
import { bearerToken, resolveAuth } from "./http.ts";
import { can } from "./permissions.ts";

/**
 * Tools for someone's own Agent on their own computer (docs/v2/remote-clients.md): `omem tool --url`
 * and `omem mcp --url` call `/api/tools` and `/mcp` with the person's credential (an API token, or
 * one an authenticator plugin recognizes) instead of a run's token. The tools are those a paired
 * device's Agent gets (agents/peer-agent.ts), cut to what this person may do and read, and every
 * session is a run of theirs.
 *
 * What the client says about itself comes in headers, each value URI-encoded (header values are
 * Latin-1 only, session names often are not).
 */
export const CLIENT_HEADERS = {
  session: "x-omem-session",
  client: "x-omem-client",
  agent: "x-omem-agent",
  model: "x-omem-model",
  effort: "x-omem-effort",
  space: "x-omem-space",
  spaces: "x-omem-spaces",
  readOnly: "x-omem-read-only",
} as const;

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw).trim() || undefined;
  } catch {
    return raw.trim() || undefined;
  }
};

/** Who is calling the tool routes with a person's credential, or null when the request has none of those. */
export function externalCaller(app: App, req: FastifyRequest): PeerAgentScope | null {
  if (!bearerToken(req)) return null;
  const auth = resolveAuth(app, req);
  if (!auth || auth.via !== "token") return null;
  const u = findUser(app, auth.userId);
  if (!u || u.disabledAt) throw new HttpError(403, "这个 omem 账号已停用");
  if (u.status === "pending") throw new HttpError(403, `你的 omem 账号（${u.name}）在等 omem 的主人批准，批准后重试`);
  if (u.id !== OWNER && !can(app, u.id, "tools.external")) throw new HttpError(403, "你的角色不能在自己的电脑上用 omem 工具（需要“tools.external”权限，请联系 omem 的主人）");
  const caller = header(req, CLIENT_HEADERS.client) ?? "remote";
  const spaces = header(req, CLIENT_HEADERS.spaces)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const readOnly = header(req, CLIENT_HEADERS.readOnly);
  return {
    userId: u.id,
    via: auth.provider ?? "token",
    caller,
    session: header(req, CLIENT_HEADERS.session) ?? `${caller}-${new Date().toLocaleDateString("sv")}`,
    space: header(req, CLIENT_HEADERS.space),
    spaces: spaces?.length ? spaces : undefined,
    readOnly: readOnly === "1" || readOnly === "true" || undefined,
    agent: header(req, CLIENT_HEADERS.agent),
    model: header(req, CLIENT_HEADERS.model),
    effort: header(req, CLIENT_HEADERS.effort),
  };
}

/** The tool backend for such a caller: list and call, each call recorded in the session's run. */
export async function externalToolBackend(app: App, scope: PeerAgentScope) {
  const { peerToolCall, peerTools } = await import("../agents/peer-agent.ts");
  return {
    list: async () => peerTools(app, scope),
    call: async (name: string, args: unknown) => {
      const r = await peerToolCall(app, scope, name, args);
      return { text: r.text, isError: r.isError };
    },
  };
}
