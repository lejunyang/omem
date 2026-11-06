import type { ProviderIdentity } from "../../src/auth/providers.ts";
import { get, type Who, type WhoInput } from "./engine.ts";

/**
 * Platforms whose connection also says who the person is, so they can log in or be bound to an omem
 * account. Each id is the platform's own permanent one (a number or uuid, never a login name that can
 * be changed); where an id is only unique inside a workspace, the workspace is part of it.
 */
const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const person = (externalId: unknown, name: unknown, email?: unknown, avatar?: unknown, tenant?: unknown): ProviderIdentity => {
  const id = s(externalId);
  if (!id) throw Object.assign(new Error("平台没有返回账号 id"), { statusCode: 400 });
  return { externalId: id, name: s(name) || id, email: s(email) || null, avatar: s(avatar) || null, ...(s(tenant) ? { tenant: s(tenant) } : {}) };
};
/** GET a JSON document and read the person from it. */
const from = (url: string, read: (j: any) => ProviderIdentity, scopes?: string[]): Who => ({ scopes, get: async (w) => read(await w.call(url)) });

export const IDENTITIES: Record<string, Who> = {
  google: from("https://www.googleapis.com/oauth2/v3/userinfo", (j) => person(j.sub, j.name, j.email, j.picture), ["openid", "email", "profile"]),
  microsoft: from("https://graph.microsoft.com/v1.0/me", (j) => person(j.id, j.displayName, j.mail || j.userPrincipalName)),
  github: from("https://api.github.com/user", (j) => person(j.id, j.name || j.login, j.email, j.avatar_url), ["read:user"]),
  gitlab: from("https://gitlab.com/api/v4/user", (j) => person(j.id, j.name || j.username, j.email, j.avatar_url), ["read_user"]),
  bitbucket: from("https://api.bitbucket.org/2.0/user", (j) => person(j.uuid, j.display_name, null, get(j, "links.avatar.href"))),
  atlassian: from("https://api.atlassian.com/me", (j) => person(j.account_id, j.name, j.email, j.picture), ["read:me"]),
  discord: from("https://discord.com/api/users/@me", (j) => person(j.id, j.global_name || j.username, j.email), ["identify", "email"]),
  linkedin: from("https://api.linkedin.com/v2/userinfo", (j) => person(j.sub, j.name, j.email, j.picture), ["openid", "profile", "email"]),
  figma: from("https://api.figma.com/v1/me", (j) => person(j.id, j.handle, j.email, j.img_url)),
  zoom: from("https://api.zoom.us/v2/users/me", (j) => person(j.id, j.display_name || `${j.first_name ?? ""} ${j.last_name ?? ""}`.trim(), j.email, j.pic_url)),
  box: from("https://api.box.com/2.0/users/me", (j) => person(j.id, j.name, j.login)),
  asana: from("https://app.asana.com/api/1.0/users/me", (j) => person(get(j, "data.gid"), get(j, "data.name"), get(j, "data.email"))),
  clickup: from("https://api.clickup.com/api/v2/user", (j) => person(get(j, "user.id"), get(j, "user.username"), get(j, "user.email"), get(j, "user.profilePicture"))),
  spotify: from("https://api.spotify.com/v1/me", (j) => person(j.id, j.display_name, j.email)),
  "twitter-v2": from("https://api.twitter.com/2/users/me", (j) => person(get(j, "data.id"), get(j, "data.name"), null), ["users.read", "tweet.read"]),
  facebook: from("https://graph.facebook.com/me?fields=id,name,email", (j) => person(j.id, j.name, j.email), ["email"]),
  okta: from("/oauth2/v1/userinfo", (j) => person(j.sub, j.name, j.email), ["openid", "profile", "email"]),
  auth0: from("/userinfo", (j) => person(j.sub, j.name, j.email, j.picture), ["openid", "profile", "email"]),
  dropbox: {
    get: async (w: WhoInput) => {
      const j = await w.call("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST" });
      return person(j.account_id, get(j, "name.display_name"), j.email, j.profile_photo_url);
    },
  },
  linear: {
    get: async (w: WhoInput) => {
      const j = await w.call("https://api.linear.app/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ viewer { id name email avatarUrl } }" }) });
      const v = get(j, "data.viewer") as Record<string, unknown> | undefined;
      return person(v?.id, v?.name, v?.email, v?.avatarUrl);
    },
  },
  // Notion and Slack say who connected in the token response itself.
  notion: { get: async (w) => person(get(w.raw, "owner.user.id"), get(w.raw, "owner.user.name"), get(w.raw, "owner.user.person.email"), get(w.raw, "owner.user.avatar_url")) },
  slack: {
    get: async (w) => {
      const team = s(get(w.raw, "team.id"));
      const user = s(get(w.raw, "authed_user.id"));
      if (!team || !user) throw Object.assign(new Error("Slack 没有返回工作区和用户"), { statusCode: 400 });
      const info = await w.call(`https://slack.com/api/users.info?user=${encodeURIComponent(user)}`).catch(() => null);
      const p = get(info, "user.profile") as Record<string, unknown> | undefined;
      return { ...person(`${team}:${user}`, p?.real_name || get(info, "user.name"), p?.email, p?.image_192), tenant: team };
    },
  },
};
