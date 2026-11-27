import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const file = ctx => join(ctx.home, ".acme-demo", "account.json");
const backendFile = ctx => join(ctx.home, ".acme-demo-agent.json");
const expires = () => Date.now() + 7 * 86400_000;

export default function register(api) {
  api.credential({
    id: "demo", name: "示例账号", required: true,
    describe: "本地演示登录，无需外部账号。",
    provides: {
      backends: ["acmeauth:demo"],
      commands: [{ name: "acme-demo", install: ["~/.local/lib/acmeauth"], state: [".acme-demo"],
        readOnly: [{ subcommand: ["whoami"] }, { subcommand: ["show"] }],
        resource: [{ match: { subcommand: ["show"] }, key: "project:{option.project}" }],
        outcomes: {
          unauthenticated: [{ json: "$.code", equals: "AUTH_REQUIRED" }],
          expired: [{ json: "$.code", equals: "EXPIRED" }],
          denied: [{ json: "$.code", equals: "DENIED" }], applyUrl: "$.details.links[0]",
        },
      }],
    },
    async precheck(ctx, { resource, user }) {
      if (!resource.startsWith("project:")) return { allowed: null };
      const login = JSON.parse(await readFile(file(ctx), "utf8"));
      if (login.expiresAt <= Date.now()) return { allowed: null };
      return { allowed: resource === "project:sample" || resource === "project:" + user,
        applyUrl: "https://example.test/request" };
    },
    async login(ctx) {
      await ctx.secret.set("demo-" + ctx.userId);
      return { user: ctx.userId, expiresAt: expires() };
    },
    async refresh(ctx) { return await ctx.secret.get() ? { expiresAt: expires() } : null; },
    async provide(ctx) {
      await writeFile(file(ctx), JSON.stringify({ user: ctx.userId, expiresAt: expires() }), { mode: 0o600 });
      await writeFile(backendFile(ctx), JSON.stringify({ user: ctx.userId }), { mode: 0o600 });
    },
    async check(ctx) {
      try {
        const { user, expiresAt } = JSON.parse(await readFile(file(ctx), "utf8"));
        return { state: expiresAt <= Date.now() ? "expired" : "ok", user, expiresAt };
      }
      catch (err) { if (err.code === "ENOENT") return { state: "missing" }; throw err; }
    },
    async logout(ctx) { await Promise.all([file(ctx), backendFile(ctx)].map(path => rm(path, { force: true }))); },
  });
}
