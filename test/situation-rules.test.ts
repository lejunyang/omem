import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { run } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { startWorker, stopWorker } from "../src/agents/runs.ts";
import { getContext } from "../src/channels/listen.ts";
import { findRule, saveRule } from "../src/rules/store.ts";
import { SITUATION_RULE_NAME_MIGRATION } from "../src/situations/schema.ts";
import { requireSituation, saveSituation, situationRuleId } from "../src/situations/settings.ts";

/**
 * A 持续跟进 rule edited as a rule (docs/v2/situations.md): the rules page sets its trigger and conditions
 * directly, a new sentence leaves hand-set conditions alone until regenerated, name and on / off are the
 * same on both sides, and nobody but the owner can change it.
 */
const app = testApp();
let server: Awaited<ReturnType<typeof startServer>>;
let tokens: { owner: string; member: string };
beforeAll(async () => {
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath,
    args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "situation" } })];
  createUser(app, { id: "member", name: "成员", role: "member" });
  tokens = { owner: createApiToken(app, "owner", "t-owner"), member: createApiToken(app, "member", "t-member") };
  server = await startServer(app, { port: 0, quiet: true });
  startWorker(app);
}, 60_000);
afterAll(async () => { stopWorker(); releaseAll(); await server?.close(); });

const call = (who: keyof typeof tokens, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  server.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
const byHand = { all: [{ field: "chat.name", op: "contains", value: "演练" }, { field: "sender.kind", op: "equals", value: "bot" }, { field: "message.text", op: "contains", value: "回切开始" }] };

describe("持续跟进的规则在规则页改", () => {
  it("生成后规则名就是名字；手改条件后换一句话不覆盖，重新生成才覆盖；改名、启停两边一致", async () => {
    const { context: c } = await saveSituation(app, "owner", { name: "项目 A 演练", note: "盯着回切", recognize: "群里说演练开始" });
    const id = situationRuleId(c.id);
    const generated = findRule(app, id)!;
    expect(generated).toMatchObject({ name: "项目 A 演练", description: "群里说演练开始", conditions: { field: "message.text", op: "contains", value: "演练开始" } });
    expect(generated.origin).not.toHaveProperty("manual");

    // The rules page sets the conditions by hand (PUT /api/rules/situation:<id>).
    const put = await call("owner", "PUT", `/api/rules/${id}`, { ...generated, conditions: byHand, judge: "code" });
    expect(put.statusCode, put.body).toBe(200);
    expect(findRule(app, id)).toMatchObject({ conditions: byHand, origin: { kind: "situation", contextId: c.id, manual: true }, actions: [{ type: "context", context: c.id }] });

    // A new sentence (from the assistant, or the follow-up's own form) keeps the hand-set conditions.
    const kept = await saveSituation(app, "owner", { id: c.id, recognize: "群里说回切开始" });
    expect(kept.conditionsKept).toBe(true);
    expect(findRule(app, id)).toMatchObject({ description: "群里说回切开始", conditions: byHand, origin: { manual: true } });
    const viaListen = await call("owner", "PUT", `/api/listen/${c.id}`, { recognize: "群里说回切结束" });
    expect(viaListen.json()).toMatchObject({ conditionsKept: true });
    expect(findRule(app, id)!.conditions).toEqual(byHand);

    // 重新生成条件: compiled from the sentence again, no longer marked as set by hand.
    const regen = await call("owner", "PUT", `/api/listen/${c.id}`, { regenerate: true });
    expect(regen.statusCode, regen.body).toBe(200);
    const after = findRule(app, id)!;
    expect(after.conditions).toEqual({ field: "message.text", op: "contains", value: "演练开始" });
    expect(after.origin).not.toHaveProperty("manual");

    // Conditions the page got from “生成条件” and left alone keep following the sentence.
    await call("owner", "PUT", `/api/listen/${c.id}`, { trigger: after.trigger, conditions: byHand, judge: "code", judgeWith: "decision", fromSentence: true });
    expect(findRule(app, id)!.origin).not.toHaveProperty("manual");

    // Renaming the rule renames the follow-up; the list's switch pauses both.
    await call("owner", "PUT", `/api/rules/${id}`, { ...findRule(app, id)!, name: "项目 A 回切" });
    expect(requireSituation(app, "owner", c.id).name).toBe("项目 A 回切");
    expect(findRule(app, id)).toMatchObject({ name: "项目 A 回切", origin: { name: "项目 A 回切" } });
    await call("owner", "PUT", `/api/rules/${id}`, { ...findRule(app, id)!, enabled: false });
    expect(requireSituation(app, "owner", c.id).status).toBe("paused");
    expect(findRule(app, id)!.enabled).toBe(false);
    await saveSituation(app, "owner", { id: c.id, status: "active" });
    expect(findRule(app, id)!.enabled).toBe(true);

    // A trigger that cannot start a follow-up is refused; the actions stay the host's.
    const schedule = await call("owner", "PUT", `/api/rules/${id}`, { ...findRule(app, id)!, trigger: { event: "schedule", cron: "0 9 * * *" } });
    expect(schedule.statusCode).toBe(422);
    await call("owner", "PUT", `/api/rules/${id}`, { ...findRule(app, id)!, actions: [{ type: "notify", urgent: true }] });
    expect(findRule(app, id)!.actions).toEqual([{ type: "context", context: c.id }]);
    // The generic rule store still refuses it: only the follow-up's own paths write it.
    expect(() => saveRule(app, { ...findRule(app, id)!, temporary: undefined, enabled: false })).toThrow(/持续跟进的规则/);

    // Deleting from the rules page deletes the follow-up too.
    expect((await call("owner", "DELETE", `/api/rules/${id}`)).json()).toEqual({ ok: true });
    expect(getContext(app, c.id)).toBeFalsy();
    expect(findRule(app, id)).toBeNull();
  }, 90_000);

  it("新建时可以直接给条件、不写那句话；交给 AI 判断时要写", async () => {
    const created = await call("owner", "POST", "/api/listen", { kind: "situation", name: "值班交接", note: "交接时核对未结事项", trigger: { event: "message" }, conditions: byHand, judge: "code" });
    expect(created.statusCode, created.body).toBe(200);
    const c = created.json();
    expect(findRule(app, situationRuleId(c.id))).toMatchObject({ name: "值班交接", description: "值班交接", conditions: byHand, origin: { manual: true } });
    const ai = await call("owner", "PUT", `/api/listen/${c.id}`, { trigger: { event: "message" }, conditions: byHand, judge: "code+ai" });
    expect(ai.statusCode).toBe(400);
    const nothing = await call("owner", "POST", "/api/listen", { kind: "situation", name: "空的", note: "说明" });
    expect(nothing.statusCode).toBe(400);
    await call("owner", "DELETE", `/api/listen/${c.id}`);
  }, 90_000);

  it("别人不能改、停或删本人的持续跟进规则", async () => {
    const { context: c } = await saveSituation(app, "owner", { name: "项目 B 演练", note: "盯着", recognize: "群里说演练开始" });
    const id = situationRuleId(c.id);
    const before = findRule(app, id)!;
    for (const r of [
      await call("member", "PUT", `/api/rules/${id}`, { ...before, conditions: byHand, enabled: false, name: "改掉" }),
      await call("member", "DELETE", `/api/rules/${id}`),
      await call("member", "PUT", `/api/listen/${c.id}`, { regenerate: true }),
    ]) expect(r.statusCode).toBeGreaterThanOrEqual(403);
    await expect(saveSituation(app, "member", { id: c.id, name: "改掉" })).rejects.toThrow();
    expect(findRule(app, id)).toMatchObject({ name: "项目 B 演练", enabled: true, conditions: before.conditions });
    expect(requireSituation(app, "owner", c.id).name).toBe("项目 B 演练");
  }, 90_000);

  it("启动迁移去掉旧的“情境：”前缀，别的规则不动", () => {
    run(app.db, `insert into rules(id,name,description,enabled,trigger,conditions,judge,judge_with,actions,created_by,created_at,updated_at,origin)
      values('situation:ctx_old','情境：项目 C 演练','x',1,'{"event":"message"}',null,'code','decision','[]','user',datetime('now'),datetime('now'),'{"kind":"situation","contextId":"ctx_old","name":"项目 C 演练"}'),
            ('rule_plain','情境：一条普通规则','x',1,'{"event":"message"}',null,'code','decision','[]','user',datetime('now'),datetime('now'),null)`);
    app.db.exec(SITUATION_RULE_NAME_MIGRATION);
    expect(findRule(app, "situation:ctx_old")!.name).toBe("项目 C 演练");
    expect(findRule(app, "rule_plain")!.name).toBe("情境：一条普通规则");
    run(app.db, "delete from rules where id in ('situation:ctx_old','rule_plain')");
  });
});
