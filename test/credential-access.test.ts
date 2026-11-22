import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { accountHome } from "../src/agents/accounts.ts";
import { recordAccess, whoCan } from "../src/agents/credential-access.ts";
import { registerCredential } from "../src/agents/credentials.ts";
import { all, run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
const kind = "demo:account";
let unregister: (() => void) | undefined;
beforeEach(() => {
  app = testApp();
  for (const id of ["reader", "lender", "private"]) createUser(app, { id, name: "成员" + id });
});
afterEach(() => { unregister?.(); unregister = undefined; app.db.close(); rmSync(app.home, { recursive: true, force: true }); });
function hold(user: string, sharing: object) {
  if (user !== "owner") mkdirSync(accountHome(app, user), { recursive: true });
  run(app.db, "insert into credential_holds(user_id,kind,state,sharing) values(?,?,'logged-in',?)", user, kind, JSON.stringify(sharing));
}

it("按资源、种类和开放范围返回最新权限，申请链接同样受范围和三十天限制", async () => {
  hold("lender", { scope: "members", members: ["reader"] });
  hold("private", { scope: "self" });
  recordAccess(app, kind, "db:a", "reader", false, "run-a", "https://example.test/apply");
  recordAccess(app, kind, "db:a", "reader", true, "run-b");
  recordAccess(app, kind, "db:a", "lender", true, "run-b");
  recordAccess(app, kind, "db:a", "private", false, "run-c", "https://example.test/private");
  recordAccess(app, "other", "db:a", "reader", false, "run-old");
  run(app.db, "update credential_access set observed_at='2000-01-01' where kind='other'");
  const data = await whoCan(app, "reader", null, "db:a");
  expect(data.allowed.map(r => r.name).sort()).toEqual(["成员lender", "成员reader"]);
  expect(data.denied).toEqual([]);
  expect(data.applyUrl).toBe("https://example.test/apply");
  expect((await whoCan(app, "owner", null, "db:a", kind)).denied[0]?.name).toBe("成员private");
  run(app.db, "update credential_access set apply_at='2000-01-01' where user_id='reader'");
  expect((await whoCan(app, "reader", null, "db:a", kind)).applyUrl).toBeNull();
});

// 插件回调在成员 HOME 中校验 POSIX 账号目录。
it.skipIf(process.platform === "win32")("预检优先用发起人的身份，缺登录仅 auto 借用；最多五人并发二，未知不落库", async () => {
  let active = 0, peak = 0;
  const calls: { holder: string; target: string }[] = [];
  unregister = registerCredential("demo", { id: "account", name: "示例", provides: {}, async login(ctx) { return { user: ctx.userId }; },
    async precheck(ctx, req) {
      calls.push({ holder: ctx.userId, target: req.user });
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { allowed: req.user === "owner" ? null : false, applyUrl: "https://example.test/apply" };
    },
  }, () => ({}), app);
  for (let i = 0; i < 6; i++) { createUser(app, { id: "member-" + i, name: "成员 " + i }); hold("member-" + i, { scope: "all" }); }
  hold("owner", { scope: "all" });
  hold("reader", { scope: "self" });
  const data = await whoCan(app, "reader", null, "db:a", kind);
  expect(calls).toHaveLength(5);
  expect(peak).toBe(2);
  expect(calls.every(c => c.holder === "reader")).toBe(true);
  expect(data.denied).toHaveLength(4);
  await whoCan(app, "reader", null, "db:a", kind);
  expect(calls).toHaveLength(5);
  run(app.db, "update credential_holds set state='missing' where user_id='reader'");
  await whoCan(app, "reader", null, "db:b", kind);
  expect(calls.slice(5).map(c => c.holder)).toEqual(Array(5).fill("owner"));
  for (const mode of ["off", "confirm"] as const) { app.config.credentials.lending = mode; await whoCan(app, "reader", null, "new", kind); }
  expect(calls).toHaveLength(10);
  expect(all(app.db, "select 1 from audit_events where action='credentials.precheck'")).toHaveLength(10);
});
