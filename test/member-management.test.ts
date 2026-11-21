import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { saveRole } from "../src/auth/permissions.ts";
import { addMember, createApiToken, createUser, getUser, linkIdentity } from "../src/core/users.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
let server: FastifyInstance;
const actors = ["owner", "admin", "delegate", "member"] as const;
const tokens: Record<string, string> = {};
const override = (capability: string, effect = "allow", space = "") =>
  ({ capability, effect, scope_kind: space ? "space" : "global", scope_id: space });
function request(actor: string, method: HTTPMethods, url: string, payload?: object) {
  return server.inject({ method, url, payload, headers: { authorization: `Bearer ${tokens[actor]}` } });
}
const putCaps = (actor: string, id: string, overrides: object[], preset = "member") =>
  request(actor, "PUT", `/api/members/${id}/capabilities`, { preset, overrides });

beforeAll(async () => {
  server = await startServer(app, { port: 0, quiet: true });
  for (const id of [...actors, "other", "legacy"]) {
    if (id !== "owner") createUser(app, { id, name: id, role: id === "admin" ? "admin" : "member" });
    tokens[id] = createApiToken(app, id, `test-${id}`);
  }
  createSpace(app, { id: "team", name: "项目" });
  createSpace(app, { id: "outside", name: "其他项目" });
  addMember(app, "team", "delegate", "reader");
  expect((await putCaps("owner", "delegate", [override("settings.members")])).statusCode).toBe(200);
});
afterAll(async () => { await server.close(); app.db.close(); });

describe.each(actors)("成员管理 · %s", actor => {
  const owner = actor === "owner";
  const manager = actor !== "member";
  it("成员列表、能力目录、新建和邀请", async () => {
    for (const url of ["/api/users", "/api/capabilities", "/api/invites"])
      expect((await request(actor, "GET", url)).statusCode).toBe(manager ? 200 : 403);
    expect((await request(actor, "POST", "/api/users", { name: `new-${actor}`, email: `${actor}@example.test` })).statusCode).toBe(manager ? 200 : 403);
    const tokenList = await request(actor, "GET", "/api/auth/tokens?userId=other");
    expect(tokenList.json().tokens.map((t: { label: string }) => t.label)).toEqual([`test-${actor}`]);
    const invite = await request(actor, "POST", "/api/invites", {});
    expect(invite.statusCode).toBe(manager ? 200 : 403);
    expect((await request(actor, "DELETE", `/api/invites/${invite.json().id ?? "missing"}`)).statusCode).toBe(manager ? 200 : 403);
  });

  it.each(["owner", "admin", "delegate", "other"])("目标 %s 的资料、状态、空间、能力、身份与会话", async id => {
    const editable = owner || (manager && id !== actor && id !== "owner" && id !== "admin");
    const path = `/api/users/${id}`;
    expect((await request(actor, "GET", `/api/members/${id}/capabilities`)).statusCode).toBe(manager ? 200 : 403);
    expect((await request(actor, "PATCH", path, { name: id })).statusCode).toBe(editable ? 200 : 403);
    expect((await request(actor, "PATCH", path, { disabled: false })).statusCode).toBe(owner && id === "owner" ? 400 : editable ? 200 : 403);
    const caps = id === "delegate" ? [override("settings.members")] : [];
    expect((await putCaps(actor, id, caps, getUser(app, id).role)).statusCode).toBe(owner && id === "owner" ? 400 : editable ? 200 : 403);
    expect((await request(actor, "PUT", path + "/spaces", { space: "team", role: "reader" })).statusCode)
      .toBe(editable && (owner || actor === "admin") ? 200 : 403);
    for (const patch of [{ loginAny: false }, { email: `${id}@example.org` }, { role: getUser(app, id).role }]) {
      expect((await request(actor, "PATCH", path, patch)).statusCode)
        .toBe(!owner ? 403 : id === "owner" && !("email" in patch) ? 400 : 200);
    }
    expect((await request(actor, "DELETE", path + "/sessions")).statusCode).toBe(owner ? 200 : 403);
    linkIdentity(app, id, "example", id);
    expect((await request(actor, "DELETE", path + "/identities", { channel: "example", externalId: id })).statusCode).toBe(owner ? 200 : 403);
  });
});

it("转授权检查名称、作用域、显式拒绝与整份替换", async () => {
  addMember(app, "team", "other", "reader");
  const allowed = override("wiki.view", "allow", "team");
  expect((await putCaps("delegate", "other", [allowed])).statusCode).toBe(200);
  for (const cap of ["settings.members.edit", "settings.security.edit", "settings.system.edit", "remote.operate"])
    expect((await putCaps("delegate", "other", [override(cap)])).statusCode).toBe(403);
  for (const extra of [override("wiki.view"), override("wiki.view", "allow", "outside")])
    expect((await putCaps("delegate", "other", [extra])).statusCode).toBe(403);
  expect((await putCaps("delegate", "other", [], "admin")).statusCode).toBe(403);
  expect((await request("delegate", "GET", "/api/members/other/capabilities")).json().overrides).toEqual([allowed]);
  expect((await putCaps("owner", "other", [override("remote.view", "deny")])).statusCode).toBe(200);
  expect((await putCaps("delegate", "other", [])).statusCode).toBe(403);
  expect((await request("delegate", "POST", "/api/invites", { spaces: [{ space: "outside", role: "reader" }] })).statusCode).toBe(403);
  expect((await request("delegate", "POST", "/api/invites", { role: "admin" })).statusCode).toBe(403);
  const before = getUser(app, "other").email;
  expect((await request("delegate", "PATCH", "/api/users/other", { email: "changed@example.org", role: "admin" })).statusCode).toBe(403);
  expect(getUser(app, "other").email).toBe(before);
});

it("旧角色 users.manage 兼容成员管理，显式拒绝仍生效", async () => {
  saveRole(app, { id: "people", name: "成员管理", scope: "global", permissions: ["users.manage"] });
  expect((await putCaps("owner", "legacy", [], "people")).statusCode).toBe(200);
  expect((await request("legacy", "GET", "/api/users")).statusCode).toBe(200);
  expect((await putCaps("owner", "legacy", [override("settings.members", "deny")], "people")).statusCode).toBe(200);
  expect((await request("legacy", "POST", "/api/invites", {})).statusCode).toBe(403);
});

it("持有配置编辑权仍不能转授，也不能用它管理普通成员", async () => {
  for (const capability of ["settings.members.edit", "settings.security.edit", "settings.system.edit"]) {
    for (const user of ["delegate", "member"])
      run(app.db, "insert into member_capability_overrides(user_id, capability, scope_kind, scope_id, effect, created_at, created_by) values (?, ?, 'global', '', 'allow', ?, 'owner')", user, capability, new Date().toISOString());
    expect((await putCaps("delegate", "other", [override(capability)])).statusCode).toBe(403);
  }
  expect((await request("member", "GET", "/api/users")).statusCode).toBe(403);
  const invite = await request("owner", "POST", "/api/invites", { role: "admin" });
  expect(invite.statusCode).toBe(200);
  const path = `/api/invites/${invite.json().id}`;
  expect((await request("delegate", "DELETE", path)).statusCode).toBe(403);
  expect((await request("owner", "DELETE", path)).statusCode).toBe(200);
});
