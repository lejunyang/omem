import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const file = ctx => join(ctx.home, ".acme-demo", "account.json");
const expires = () => Date.now() + 7 * 86400_000;

export default function register(api) {
  api.credential({
    id: "demo", name: "示例账号", required: true,
    describe: "本地演示登录，无需外部账号。",
    provides: {
      backends: ["acmeauth:demo"],
      commands: [{ name: "acme-demo", install: ["~/.local/lib/acmeauth"], state: [".acme-demo"],
        readOnly: [{ subcommand: ["whoami"] }] }],
    },
    async login(ctx) {
      await ctx.secret.set("demo-" + ctx.userId);
      return { user: ctx.userId, expiresAt: expires() };
    },
    async refresh(ctx) { return await ctx.secret.get() ? { expiresAt: expires() } : null; },
    async provide(ctx) { await writeFile(file(ctx), JSON.stringify({ user: ctx.userId }), { mode: 0o600 }); },
    async check(ctx) {
      try { return { state: "ok", user: JSON.parse(await readFile(file(ctx), "utf8")).user }; }
      catch (err) { if (err.code === "ENOENT") return { state: "missing" }; throw err; }
    },
    async logout(ctx) { await rm(file(ctx), { force: true }); },
  });
}
