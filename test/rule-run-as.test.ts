import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { accountHome } from "../src/agents/accounts.ts";
import { commandGateDir } from "../src/agents/command-gate.ts";
import { registerCredential } from "../src/agents/credentials.ts";
import { createRun } from "../src/agents/runs.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { createThread } from "../src/agents/threads.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { all, run } from "../src/core/db.ts";
import { createUser, linkIdentity } from "../src/core/users.ts";
import { actingAs, consented, decideRunAs, endActing, reaskRunAs, runAsOf, switchIdentity } from "../src/rules/run-as.ts";
import { deleteRule, getRule, saveRule } from "../src/rules/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const name = "sample-read", kind = "fixture:account";
let app: ReturnType<typeof testApp>, home: string, drop: () => void;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "run-as-owner-"));
  vi.stubEnv("HOME", home);
  app = testApp();
  createUser(app, { id: "ann", name: "小安" });
  linkIdentity(app, "ann", "lark", "ou_ann", { kind: "alias" });
  createUser(app, { id: "bo", name: "小波" });
  drop = registerCredential("fixture", { id: "account", name: "示例账号", login: async () => ({ user: "demo" }), check: async () => ({ state: "ok" }),
    provides: { commands: [{ name, readOnly: [{ subcommand: ["show"] }], state: [".sample"] }] } }, () => ({}), app);
});
afterEach(async () => {
  // Cards are shown asynchronously (asks.ts show): let them land before the database closes.
  await new Promise((r) => setTimeout(r, 50));
  drop(); vi.unstubAllEnvs(); setSandboxSupportForTests(undefined);
  app.db.close(); rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

const weekly = (runAs: string[], extra: object = {}) => ({
  name: "周报", description: "每周五以大家的身份查研发平台写周报", enabled: true,
  trigger: { event: "schedule" as const, cron: "0 17 * * 5" }, judge: "code" as const,
  actions: [{ type: "agent" as const, spec: "assistant", task: "查各人本周的合并请求", reply: "none" as const, runAs }], ...extra,
});

it("列了谁就问谁：能问的发卡片，没账号、没飞书、没权限的写明原因；只有本人能列", () => {
  const rule = saveRule(app, weekly(["ann", "bo"]), "user", "owner");
  const people = runAsOf(app, rule);
  expect(people.map((p) => [p.userId, p.status])).toEqual([["ann", "pending"], ["bo", "unavailable"]]);
  expect(people[1].reason).toMatch(/飞书/);
  const asks = listAsks(app, { userId: "ann", status: "pending" });
  expect(asks).toHaveLength(1);
  expect(asks[0].question).toContain("周报");
  // Saving again does not ask twice.
  saveRule(app, { ...weekly(["ann", "bo"]), id: rule.id }, "user", "owner");
  expect(listAsks(app, { userId: "ann", status: "pending" })).toHaveLength(1);
  // A member's agent cannot add anyone; the owner's own turn can.
  expect(() => saveRule(app, { ...weekly(["ann", "bo"]), id: rule.id, actions: [{ ...weekly([]).actions[0], runAs: ["ann", "bo", "cy"] }] }, "agent", "bo")).toThrow();
  createUser(app, { id: "cy", name: "小晨" });
  expect(() => saveRule(app, { ...weekly(["cy"]) }, "agent", "bo")).toThrow(/本人指定/);
  expect(() => saveRule(app, weekly(["owner"]), "user", "owner")).toThrow(/只列成员/);
  expect(() => saveRule(app, weekly(["nobody"]), "user", "owner")).toThrow(/没有这个成员/);
});

it("群里设的规则在群里问；只有被问的人能答，同意后才能换成他，撤回后立刻不能", async () => {
  const group = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_team", title: "项目 A", settings: { group: true }, userId: "owner" });
  const rule = saveRule(app, { ...weekly(["ann"]), conversationId: group.id }, "user", "owner");
  const q = listAsks(app, { userId: "ann", status: "pending" })[0];
  expect(q.conversationId).toBe(group.id);
  await expect(answerAsk(app, q.id, { choice: 0, by: "bo" })).rejects.toThrow(/被问的人/);
  await answerAsk(app, q.id, { choice: 0, by: "ann" });
  await vi.waitFor(() => expect(consented(app, rule.id, "ann")).toBe(true));
  expect(all(app.db, "select title from notifications where user_id = 'owner' and title like '%同意%'")).toHaveLength(1);

  const runId = createRun(app, { kind: "agent", spaceId: "personal", title: "周报", input: { rule: { id: rule.id, runAs: ["ann"] } }, userId: "owner" }).id;
  expect(switchIdentity(app, runId, { id: rule.id, runAs: ["ann"] }, "小安")).toBe("ann");
  expect(actingAs(runId)).toBe("ann");
  expect(() => switchIdentity(app, runId, { id: rule.id, runAs: ["ann"] }, "bo")).toThrow(/没有列/);
  decideRunAs(app, rule.id, "ann", false, "ann");
  expect(runAsOf(app, rule)[0].status).toBe("revoked");
  expect(() => switchIdentity(app, runId, { id: rule.id, runAs: ["ann"] }, "ann")).toThrow(/撤回/);
  expect(() => decideRunAs(app, rule.id, "ann", true, "bo")).toThrow(/只有本人/);
  // Asked again by the owner, then the rule deleted: the open card is withdrawn.
  reaskRunAs(app, getRule(app, rule.id), "ann");
  const again = listAsks(app, { userId: "ann", status: "pending" })[0];
  deleteRule(app, rule.id);
  expect(getAsk(app, again.id).status).toBe("cancelled");
  endActing(runId);
});

it.skipIf(process.platform === "win32")("换成成员后，登记过的命令在他的账号环境里用他的登录跑；没登录就提醒他、不用本人的", async () => {
  const rule = saveRule(app, weekly(["ann"]), "user", "owner");
  decideRunAs(app, rule.id, "ann", true, "ann");
  commandGateDir(app);
  const bin = join(app.home, "bin-fixtures");
  mkdirSync(bin);
  writeFileSync(join(bin, name), "#!/bin/sh\necho ran\n", { mode: 0o755 });
  vi.stubEnv("PATH", bin + delimiter + process.env.PATH);
  const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  const runId = createRun(app, { kind: "agent", spaceId: "personal", title: "周报", input: { rule: { id: rule.id, runAs: ["ann"] } }, userId: "owner" }).id;
  run(app.db, "update runs set status = 'running' where id = ?", runId);
  const token = issueToolToken({ actor: "agent", userId: "owner", commandHomeUser: "owner", runId, spaceId: "personal", spaces: [], tools: new Set() });
  const gate = async () => (await server.inject({ method: "POST", url: "/api/command-gate", headers: { authorization: "Bearer " + token },
    payload: { command: name, args: ["show", "--project", "sample"], cwd: app.home, credentialExecution: true } })).json();
  try {
    // As the owner: nothing special, the command runs as it is.
    expect((await gate()).execution).toBeUndefined();
    switchIdentity(app, runId, { id: rule.id, runAs: ["ann"] }, "ann");
    setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
    const none = await gate();
    expect(none).toMatchObject({ decision: "deny", message: expect.stringContaining("小安没有可用的示例账号登录") });
    mkdirSync(join(accountHome(app, "ann"), ".sample"), { recursive: true });
    run(app.db, "insert into credential_holds(user_id,kind,state,sharing) values('ann',?,'logged-in','{\"scope\":\"self\"}') on conflict(user_id,kind) do update set state='logged-in'", kind);
    const ran = await gate();
    expect(ran).toMatchObject({ decision: "allow" });
    // /bin/echo stands in for bubblewrap: the plan mounts her login, not the owner's HOME.
    const plan = Buffer.from(ran.execution.stdout, "base64").toString();
    expect(plan).toContain(join(accountHome(app, "ann"), ".sample"));
    expect(all(app.db, "select 1 from audit_events where action = 'rule.run-as.command'")).toHaveLength(1);
    decideRunAs(app, rule.id, "ann", false, "ann");
    expect((await gate()).decision).not.toBe("allow");
  } finally {
    endActing(runId);
    revokeToolToken(token);
    await server.close();
  }
});
