import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

let app: App;
beforeEach(() => { app = testApp(); });
afterEach(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

it("新成员有邮箱时用邮箱前缀做 ID，重名加序号；没有邮箱时照旧用名字", () => {
  expect(createUser(app, { name: "小王", email: "Xiao.Wang@example.test" }).id).toBe("xiao-wang");
  expect(createUser(app, { name: "另一个小王", email: "xiao.wang@other.test" }).id).toBe("xiao-wang-2");
  expect(createUser(app, { name: "Li Lei" }).id).toBe("li-lei");
  expect(createUser(app, { name: "小李" }).id).toMatch(/^u[a-z0-9]+$/);
  // An explicit id still wins over the email.
  expect(createUser(app, { name: "小周", id: "zhou", email: "someone@example.test" }).id).toBe("zhou");
});
