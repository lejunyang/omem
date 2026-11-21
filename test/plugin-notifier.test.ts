import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { staleDays, sweepStaleAsks } from "../src/agents/ask-expiry.ts";
import { cancelAsk, createAsk, getAsk, waitForAnswer } from "../src/agents/asks.ts";
import { one, run } from "../src/core/db.ts";
import { addNotificationSink, deferNotification, markPushed, takeDeferred, listNotifications, notify, releaseLater } from "../src/core/notify.ts";
import { upsertItem } from "../src/items/store.ts";
import { createApiToken, createUser, linkIdentity } from "../src/core/users.ts";
import { answerFromOutlet, drainOutlets, startNotifierOutlets } from "../src/plugins/notifier.ts";
import { forgetPlugin, loadPlugins, setPluginEnabled, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const outlet = "localnotice:file";
const user = { provider: "local-demo", subject: "operator" };
const setting = { id: outlet, minUrgency: "normal" as const, askKinds: ["question"] };

describe.each(["isolated", "inprocess"] as const)("通知出口 %s", mode => {
  const app = testApp();
  let server: Awaited<ReturnType<typeof startServer>>;
  const data = join(app.home, "plugin-data", "localnotice");
  const file = (id: string) => join(data, id + ".json");
  const message = (id: string) => JSON.parse(readFileSync(file(id), "utf8"));
  const submit = (ref: string, choice = 0) => server.inject({ method: "POST", url: "/api/plugins/localnotice/call/localnotice_answer", payload: { ref, choice } });
  const ask = () => createAsk(app, { runId: null, question: "采用哪项？", options: [{ label: "采用" }] });
  let headers: { authorization: string };
  beforeAll(async () => {
    mkdirSync(data, { recursive: true });
    cpSync("examples/plugins/localnotice", join(app.home, "plugins", "localnotice"), { recursive: true });
    if (mode === "inprocess") vi.stubEnv("OMEM_PLUGIN_DATA", data);
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await trustPlugin(app, "localnotice", mode);
    linkIdentity(app, "owner", user.provider, user.subject);
    createUser(app, { id: "reader", name: "成员" });
    headers = { authorization: "Bearer " + createApiToken(app, "reader") };
    startNotifierOutlets(app);
    app.config.timezone = "UTC";
    app.config.notify.quietStart = app.config.notify.quietEnd = 0;
    server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  });
  beforeEach(() => { app.config.notify.outlets.owner = [{ ...setting, askKinds: ["question"] }]; });
  afterAll(async () => {
    untrustPlugin(app, "localnotice");
    forgetPlugin("localnotice");
    await server?.close();
    app.db.close();
    vi.unstubAllEnvs();
  });

  it("按当前成员列出、启用和试发出口", async () => {
    app.config.notify.outlets.owner = [];
    const n = notify(app, { title: "未开启" });
    await drainOutlets(app);
    expect(existsSync(file(n.id))).toBe(false);
    const url = "/api/notify/outlets";
    const list = (await server.inject(url)).json().outlets;
    expect(list.map((s: {id:string}) => s.id)).toEqual(["web","lark",outlet]);
    expect(list[2]).toMatchObject({ setting: null, supportsAsk: true, reachable: { ok: true } });
    expect((await server.inject({ url, headers })).json().outlets[2].reachable.ok).toBe(false);
    expect((await server.inject({ method: "PUT", url, headers, payload: { userId: "owner", outlets: [setting] } })).statusCode).toBe(403);
    expect((await server.inject({ method: "PUT", url, headers, payload: { outlets: [] } })).statusCode).toBe(200);
    expect((await server.inject({ method: "PUT", url, payload: { userId: "reader", outlets: [] } })).statusCode).toBe(200);
    for (const id of ["web", "lark"]) expect((await server.inject({ method: "POST", url: url + "/" + id + "/test" })).statusCode).toBe(404);
    const test = await server.inject({ method: "POST", url: url + "/" + outlet + "/test" });
    expect(test.statusCode, test.body).toBe(200);
    expect(message(test.json().id).user.id).toBe("owner");
    const other = await server.inject({ method: "POST", url: url + "/" + outlet + "/test", headers, payload: { userId: "owner" } });
    expect(other.statusCode).toBe(502);
    expect((await server.inject({method: "PUT", url, payload: { outlets: [setting] }})).statusCode).toBe(200);
  });

  it("夜间保留、早上补送；更新沿用回执，汇总复用宿主的释放时间", async () => {
    vi.setSystemTime(new Date("2026-11-21T23:00:00Z"));
    app.config.notify.quietStart = 22;
    app.config.notify.quietEnd = 9;
    try {
      const item = upsertItem(app, undefined, {title:"项目 A", detail:"事项私有详情"});
      const n = notify(app, { title: "进展", body: "第一步", link: "#/notifications", entityId: item.id });
      await drainOutlets(app);
      expect(existsSync(file(n.id))).toBe(false);
      const held = notify(app, { title: "等待更新" });
      await drainOutlets(app);
      const urgent = notify(app, { title: "紧急更新", urgency: "urgent", replaces: held.id });
      await drainOutlets(app);
      expect(message(held.id)).toMatchObject({ title: "紧急更新", dedupKey: held.id });
      expect(existsSync(file(urgent.id))).toBe(false);
      vi.setSystemTime(new Date("2026-11-22T09:01:00Z"));
      await drainOutlets(app);
      expect(message(n.id)).toMatchObject({ title: "进展", body: "第一步", dedupKey: n.id });
      expect(message(n.id).about).toEqual({title:"项目 A", link:"#/items/" + item.id});
      expect(JSON.stringify(message(n.id))).not.toContain("事项私有详情");
      expect(message(n.id)).not.toHaveProperty("sourceRefs");
      expect(listNotifications(app).find(x => x.id === n.id)).toMatchObject({ unread: false, pushed: { channel: outlet } });
      vi.setSystemTime(new Date("2026-11-22T23:00:00Z"));
      const next = notify(app, { title: "第二步", replaces: n.id });
      await drainOutlets(app);
      expect(message(n.id).title).toBe("第二步");
      expect(existsSync(file(next.id))).toBe(false);
      vi.setSystemTime(new Date("2026-11-23T09:01:00Z"));
      app.config.notify.outlets.owner[0].minUrgency = "later";
      const later = notify(app, { title: "汇总", urgency: "later" });
      await drainOutlets(app);
      expect(existsSync(file(later.id))).toBe(false);
      releaseLater(app, new Date(), { now: true });
      await drainOutlets(app);
      expect(message(later.id).title).toBe("汇总");
    } finally { vi.useRealTimers(); app.config.notify.quietStart = app.config.notify.quietEnd = 0; }
  });

  it.each(["plugin", "lark"])("早晨由 %s 先补送时只推一次", async first => {
    app.config.notify.quietStart = 22;
    app.config.notify.quietEnd = 9;
    try {
      vi.setSystemTime(new Date("2026-11-21T23:00:00Z"));
      const n = notify(app, { title: "夜间进展" });
      deferNotification(app, n.id);
      await drainOutlets(app);
      expect(existsSync(file(n.id))).toBe(false);
      vi.setSystemTime(new Date("2026-11-22T09:01:00Z"));
      if (first === "plugin") {
        await drainOutlets(app);
        expect(message(n.id).title).toBe("夜间进展");
        expect(takeDeferred(app)).toEqual([]);
      } else {
        expect(takeDeferred(app).map(row => row.id)).toEqual([n.id]);
        markPushed(app, n.id, "lark");
        await drainOutlets(app);
        expect(existsSync(file(n.id))).toBe(false);
      }
    } finally { vi.useRealTimers(); app.config.notify.quietStart = app.config.notify.quietEnd = 0; }
  });

  it.each([1, 3])("普通门槛保留 %i 条低优先级进展在网页", async count => {
    const entries = Array.from({ length: count }, () => notify(app, { title: "低优先级进展", urgency: "later" }));
    expect(releaseLater(app, new Date(), { now: true })).toBe(count);
    await drainOutlets(app);
    const visible = listNotifications(app);
    for (const n of entries) expect(visible.some(row => row.id === n.id)).toBe(true);
    const released = count === 1 ? entries[0] : visible.find(row => row.bundle?.includes(entries[0].id))!;
    expect(existsSync(file(released.id))).toBe(false);
  });

  it("校验投递回执、投递时和回答时的身份、白名单与到期日", async () => {
    const a = ask();
    await drainOutlets(app);
    expect(message(a.id).options).toEqual([{ label: "采用" }]);
    const input = { notifier: "file", user, ref: a.id, choice: 0 };
    await expect(answerFromOutlet(app, "other", input)).rejects.toThrow();
    await expect(answerFromOutlet(app, "localnotice", { ...input, ref: "unknown" })).rejects.toThrow();
    linkIdentity(app, "reader", user.provider, user.subject);
    await expect(answerFromOutlet(app, "localnotice", input)).rejects.toThrow();
    linkIdentity(app, "owner", user.provider, user.subject);
    linkIdentity(app, "owner", user.provider, "new");
    await expect(answerFromOutlet(app, "localnotice", { ...input, user: { ...user, subject: "new" } })).rejects.toThrow();
    app.config.notify.outlets.owner[0].askKinds = [];
    expect((await submit(a.id)).statusCode).toBe(400);
    app.config.notify.outlets.owner[0].askKinds = ["question"];
    run(app.db, "update asks set created_at='2000-01-01T00:00:00.000Z' where id=?", a.id);
    expect((await submit(a.id)).statusCode).toBe(400);
    expect(getAsk(app, a.id).status).toBe("pending");
    cancelAsk(app, a.id);
    await drainOutlets(app);
    expect(message(a.id)).toEqual({ closed: true });

    for (const context of [{ handler: "flow-stage" }, { handler: "command-gate" }]) {
      const gated = createAsk(app, { runId: null, question: "是否继续？", context });
      await drainOutlets(app);
      expect(existsSync(file(gated.id))).toBe(false);
      expect(one(app.db, "select 1 from outlet_deliveries where object_id=?", gated.id)).toBeUndefined();
    }
  });

  it("无人回答的提问到期后自动关闭外部卡片", async () => {
    const a = ask();
    await drainOutlets(app);
    expect(message(a.id).options).toEqual([{ label: "采用" }]);
    try {
      vi.setSystemTime(Date.parse(a.createdAt) + (staleDays(app) + 1) * 86400000);
      expect(sweepStaleAsks(app).stale).toBeGreaterThan(0);
      await drainOutlets(app);
      expect(getAsk(app, a.id)).toMatchObject({ status: "cancelled", lapsed: expect.any(String) });
      expect(message(a.id)).toEqual({ closed: true });
      expect((await submit(a.id)).statusCode).toBe(400);
    } finally { vi.useRealTimers(); }
  });

  it("表单沿用宿主校验，审批要有明确的授权种类和决定", async () => {
    const form = createAsk(app, { runId: null, question: "写下名称", ui: { fields: [{ type: "text", id: "name", label: "名称", required: true }] } });
    const approval = createAsk(app, { runId: null, kind: "approval", question: "批准试验？" });
    await drainOutlets(app);
    expect(message(form.id).fields[0].id).toBe("name");
    expect(existsSync(file(approval.id))).toBe(false);
    const input = { notifier: "file", user, ref: form.id };
    await expect(answerFromOutlet(app, "localnotice", { ...input, values: {} })).rejects.toThrow();
    const waiting = waitForAnswer(app, form.id, 5000);
    await answerFromOutlet(app, "localnotice", { ...input, values: { name: "项目 A" } });
    expect((await waiting).value).toEqual({name: "项目 A"});
    app.config.notify.outlets.owner[0].minUrgency = "urgent";
    app.config.notify.outlets.owner[0].askKinds.push("approval");
    const allowed = createAsk(app, { runId: null, kind: "approval", question: "批准试验？" });
    await drainOutlets(app);
    expect(message(allowed.id)).toMatchObject({requiresApproval:true, urgency:"urgent"});
    await expect(answerFromOutlet(app, "localnotice", { ...input, ref: allowed.id })).rejects.toThrow("明确");
    const decision = waitForAnswer(app, allowed.id, 5000);
    await answerFromOutlet(app, "localnotice", { ...input, ref: allowed.id, approved: false });
    expect((await decision).approved).toBe(false);
  });

  it("停用期间在网页回答，恢复出口后撤回旧卡", async () => {
    const a = ask();
    await drainOutlets(app);
    expect(message(a.id).options).toHaveLength(1);
    await setPluginEnabled(app, "localnotice", false);
    try {
      const waiting = waitForAnswer(app, a.id, 5000);
      const result = await server.inject({ method: "POST", url: "/api/asks/" + a.id + "/answer", payload: { choice: 0 } });
      expect(result.statusCode).toBe(200);
      expect(await waiting).toMatchObject({ answeredBy: "owner", consumed: true });
      await drainOutlets(app);
      expect(message(a.id).options).toHaveLength(1);
      expect(one(app.db, "select state,attempts from outlet_deliveries where object_id=? and op='retract'", a.id)).toEqual({ state: "pending", attempts: 0 });
    } finally { await setPluginEnabled(app, "localnotice", true); }
    await drainOutlets(app);
    expect(message(a.id)).toEqual({ closed: true });
    expect(one(app.db, "select state from outlet_deliveries where object_id=? and op='retract'", a.id)).toEqual({ state: "sent" });
  });

  it("两种回答都交给同一个等待者，关闭插件卡片并拒绝重复提交", async () => {
    for (const via of ["web", "plugin"]) {
      const a = ask();
      await drainOutlets(app);
      const waiting = waitForAnswer(app, a.id, 5000);
      const res = via === "web" ? await server.inject({ method: "POST", url: "/api/asks/" + a.id + "/answer", payload: {choice:0} }) : await submit(a.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(await waiting).toMatchObject({ answer: "采用", answeredBy: "owner", consumed: true });
      expect((await submit(a.id)).statusCode).toBe(400);
      await drainOutlets(app);
      expect(message(a.id)).toEqual({ closed: true });
    }
  });
});

it.each(["isolated", "inprocess"] as const)("%s 受托成员的审批出口由本人逐个授权", async mode => {
  const app = testApp();
  const dir = join(app.home, "plugins", "delegate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), JSON.stringify({ id: "delegate", name: "成员出口", permissions: { notify: { deliver: true, ask: true } } }));
  writeFileSync(join(dir, "server.mjs"), `export default api => {
    for (const id of ["first", "second"]) api.notifier({
      id, name: id, deliver: async () => ({}), ask: async a => ({ ref: a.dedupKey })
    });
  }`);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "delegate", mode);
  createUser(app, { id: "member", name: "成员" });
  linkIdentity(app, "member", user.provider, user.subject);
  const headers = { authorization: "Bearer " + createApiToken(app, "member") };
  startNotifierOutlets(app);
  const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  const first = { ...setting, id: "delegate:first", askKinds: ["approval"] };
  const second = { ...setting, id: "delegate:second" };
  const put = (byOwner: boolean, outlets: typeof first[]) => server.inject({
    method: "PUT", url: "/api/notify/outlets", headers: byOwner ? undefined : headers, payload: { userId: "member", outlets },
  });
  try {
    expect((await put(false, [first])).statusCode).toBe(403);
    expect((await put(true, [first, second])).statusCode).toBe(200);
    expect((await put(false, [first, { ...second, askKinds: ["approval"] }])).statusCode).toBe(403);
    // Simulate an older member preference saved before separate grants existed.
    app.config.notify.outlets.member[1].askKinds = ["approval"];
    const a = createAsk(app, { runId: null, userId: "member", kind: "approval", question: "批准试验？" });
    await drainOutlets(app);
    expect(one(app.db, "select outlet,ref from outlet_deliveries where object_id=?", a.id)).toEqual({ outlet: first.id, ref: a.id });
    expect(one(app.db, "select count(*) n from outlet_deliveries where object_id=?", a.id)).toEqual({ n: 1 });
    const input = { notifier: "first", ref: a.id, user, approved: false };
    expect((await put(true, [{ ...first, askKinds: ["question"] }, second])).statusCode).toBe(200);
    app.config.notify.outlets.member[0].askKinds = ["approval"];
    await expect(answerFromOutlet(app, "delegate", input)).rejects.toThrow("未获准");
    expect((await put(true, [first, second])).statusCode).toBe(200);
    const waiting = waitForAnswer(app, a.id, 5000);
    await answerFromOutlet(app, "delegate", input);
    expect(await waiting).toMatchObject({ answeredBy: "member", approved: false });
  } finally {
    await server.close();
    forgetPlugin("delegate");
    app.db.close();
  }
});

it.each(["isolated", "inprocess"] as const)("%s 只授予普通投递时隔离提问；出口超时照常记录并重试，其他出口继续", async mode => {
  const app = testApp();
  const undo: (() => void)[] = [];
  const dir = join(app.home, "plugins", "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), JSON.stringify({ id: "probe", name: "试验", permissions: { notify: { deliver: true } } }));
  writeFileSync(join(dir, "server.mjs"), `export default api => {
    let calls = 0;
    api.notifier({ id: "probe", name: "试验",
      async deliver(n, signal) {
        if (++calls === 1) await new Promise(resolve => signal.addEventListener("abort", resolve, {once:true}));
        if (calls > 2) throw new Error("重复发送");
        return {ref: "receipt"};
      },
      async ask() { throw new Error("投递了未获授权的提问"); }
    });
  }`);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "probe", mode);
  const heard: string[] = [];
  undo.push(addNotificationSink(n => { heard.push(n.id); }));
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 15000 ? 50 : ms));
  try {
    app.config.notify.quietStart = app.config.notify.quietEnd = 0;
    app.config.notify.outlets.owner = [{ ...setting, id: "probe:probe", askKinds: ["approval"] }];
    startNotifierOutlets(app);
    const n = notify(app, { title: "进展" });
    await drainOutlets(app);
    expect(heard).toContain(n.id);
    expect(listNotifications(app)[0].id).toBe(n.id);
    expect(one(app.db, "select state,attempts,error from outlet_deliveries where object_id=?", n.id)).toMatchObject({ state:"pending", attempts:1, error:expect.any(String) });
    run(app.db, "update outlet_deliveries set due=0 where object_id=?", n.id);
    await drainOutlets(app);
    const updated = notify(app, { title: "更新", replaces:n.id });
    await drainOutlets(app);
    expect(one(app.db, "select state,ref from outlet_deliveries where object_id=?", updated.id)).toEqual({state:"skipped", ref:null});
    const a = createAsk(app, { runId:null, question:"测试", kind:"approval" });
    await new Promise(resolve => setImmediate(resolve));
    await drainOutlets(app);
    expect(one(app.db, "select 1 from outlet_deliveries where object_id=?", a.id)).toBeUndefined();
    expect(one(app.db, "select count(*) as count from outlet_deliveries")).toEqual({count:2});
    expect(one(app.db, "select state,ref from outlet_deliveries where object_id=?", updated.id)).toEqual({state:"skipped", ref:null});
    cancelAsk(app, a.id);
  } finally {
    vi.restoreAllMocks();
    forgetPlugin("probe");
    for (const stop of undo) stop();
    app.db.close();
  }
});
