import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { accountEntry, ensureAccountHome, memberAccountPlan, selectedMemberAccount, stopAccountLogins } from "../src/agents/accounts.ts";
import { markOutOfQuota } from "../src/agents/capacity.ts";
import { aiLoginWait, backendLoginReady } from "../src/agents/credential-wait.ts";
import { registerCredential, stopCredentialLogins } from "../src/agents/credentials.ts";
import { receive, registerThreadSender } from "../src/agents/inbox.ts";
import { memberAi } from "../src/agents/member-ai.ts";
import { noteRateLimit } from "../src/agents/quota.ts";
import { runRole } from "../src/agents/runner.ts";
import { getRun, runEvents, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { getThread } from "../src/agents/threads.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { sendLark, setLarkClient } from "../src/channels/lark-send.ts";
import { closeVault } from "../src/auth/vault.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { allProfiles } from "../src/core/config.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { run } from "../src/core/db.ts";
import { createUser, linkIdentity } from "../src/core/users.ts";
import { registerAgentAccountRoutes } from "../src/server/agent-accounts-http.ts";
import "../src/agents/jobs.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/quota.ts", async (load) => ({
  ...await load<typeof import("../src/agents/quota.ts")>(),
  refreshQuota: vi.fn(async () => null),
  afterTurn: vi.fn(),
}));

describe.skipIf(process.platform !== "linux")("成员的 AI 选择和飞书登录", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-member-ai-"));
  const fake = resolve("test/fake-acp-agent.ts");
  const prompts = join(home, "prompts.jsonl");
  const bwrap = join(home, "bwrap");
  writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  const qrCli = join(home, "fake-login");
  writeFileSync(qrCli, [
    "#!/bin/sh",
    "case \"$1\" in",
    'status) test -f "$HOME/login-ok" ;;',
    'login) printf "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO5sAAAAASUVORK5CYII=" | base64 -d > "$TMPDIR/login.png"',
    '      printf "二维码： %s\\n" "$TMPDIR/login.png"',
    '      while [ ! -f "$HOME/login-ok" ]; do sleep .1; done ;;',
    "esac",
  ].join("\n"), { mode: 0o700 });
  // Use regular pipes for the fixture's Node stdio on hosts that restrict socket operations.
  const profile = (id: string) => ({ id, transport: "acp", command: "/bin/sh", args: ["-c", 'cat | "$@" | cat', "acp-fixture", process.execPath, fake], env: { FAKE_MODE: "thread", FAKE_LEGACY: "1", FAKE_PROMPT_LOG: prompts }, model: "m1" });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    agents: { default: "codex", queueTimeoutMinutes: 1, profiles: [
      profile("codex"), profile("alternate"), {
        ...profile("qr-demo"), account: { cli: qrCli, owns: [".demo"], login: { args: ["login"], url: "https://\\S+", qrArgs: ["login"] }, status: { args: ["status"] } },
      },
    ] },
  }));
  setSandboxSupportForTests({ ok: true, bwrap });
  const app = testApp(home);
  app.baseUrl = "http://127.0.0.1:1";
  const server = Fastify();
  registerAgentAccountRoutes(server, app, req => req.headers.authorization === "Bearer ann" ? "ann" : "bob");
  startWorker(app);
  for (const userId of ["ann", "bob"]) {
    createUser(app, { id: userId, name: userId });
    linkIdentity(app, userId, "lark", "ou_" + userId);
  }
  const call = (id: string, method: "GET" | "PUT", body?: object) => server.inject({
    url: "/api/me/agent-accounts" + (method === "PUT" ? "/settings" : ""), method, headers: { authorization: "Bearer " + id }, payload: body,
  });
  const card = vi.fn(async (_data: unknown) => ({ data: { message_id: "om_card" } }));
  const ephemeral = vi.fn(async (_data: unknown) => ({ data: { message_id: "om_ephemeral" } }));
  const image = vi.fn(async (_data: unknown) => ({ image_key: "img_qr" }));
  const answer = async (id: string) => {
    const result = await waitForRun(app, id);
    expect(result.error, JSON.stringify(runEvents(app, id).filter(e => e.type !== "prompt"))).toBeNull();
    expect(result.status).toBe("done");
    return result;
  };
  const account = (id: string, holder: string, why: string) => {
    expect(runEvents(app, id).map(e => e.data)).toContainEqual(expect.objectContaining({
      account: expect.objectContaining({ holder, reason: expect.stringContaining(why) }),
    }));
  };
  const ask = (chatId: string, text: string, userId = "ann", topicId?: string) => receive(app, {
    channel: "lark", chatId, text, userId, topicId, isGroup: !!topicId, externalMessageId: "om_" + chatId, mergeMs: 0,
  });
  const used = (percent: number) => noteRateLimit(app, allProfiles(app.config).find(p => p.id === "codex")!, {
    type: "rate-limit", window: "five_hour", usedPercent: percent, resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  beforeEach(() => {
    for (const fn of [card, ephemeral, image]) fn.mockClear();
    setLarkClient({ im: { message: { reply: card, create: card }, image: { create: image } }, request: ephemeral });
    setLarkCliForTests(() => { throw new Error("测试不调用真实飞书 CLI"); });
    app.config.agents.routing.choose.conversation = "off";
    writeFileSync(prompts, "");
    run(app.db, "delete from kv where key in ('agent_quota', 'agent_quota_exhausted') or key like 'agent_account:%'");
  });
  afterAll(async () => {
    setLarkClient(null);
    setLarkCliForTests(null);
    setDecisionFetchForTests(null);
    stopAccountLogins();
    stopCredentialLogins();
    releaseAll();
    setSandboxSupportForTests(undefined);
    stopWorker();
    await server.close();
    closeVault(home);
    app.db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("有自己的登录也先借额度充足的本人账号，额度紧张时下一轮换到自己的沙箱", async () => {
    ensureAccountHome(app, "ann", accountEntry(app, "codex")!);
    run(app.db, "insert into kv(key,value) values('agent_account:ann:codex','{\"state\":\"logged-in\",\"user\":\"ann@example.test\"}')");
    used(12);
    const first = await ask("room", "第一条");
    await answer(first.runId!);
    account(first.runId!, "owner", "本人额度充足");
    expect(getRun(app, first.runId!)!.ai).toMatchObject({ profile: "codex", account: { holder: "owner", borrowed: true, reason: expect.stringContaining("本人额度充足") } });
    const machineSession = getThread(app, first.thread.id).agentProfile;
    expect(machineSession).not.toContain("@ann");
    used(96);
    await ask("room", "/agent codex");
    const second = await ask("room", "第二条");
    await answer(second.runId!);
    account(second.runId!, "ann", "本人额度紧张");
    const own = getRun(app, second.runId!)!.ai!;
    expect(own.account).toMatchObject({ holder: "ann", login: "ann@example.test" });
    expect(own.account?.borrowed).toBeUndefined();
    expect(getThread(app, second.thread.id).agentProfile).not.toBe(machineSession);
    expect(card.mock.calls.map(c => JSON.stringify(c[0])).join()).toContain("本人额度紧张");
    expect(runEvents(app, second.runId!).map(e => e.data)).toContainEqual(expect.objectContaining({
      choice: expect.objectContaining({ reason: "成员指定了 AI" }),
    }));
  }, 30_000);

  it("仅自己和缺登录换后端的规则，在本人额度充足时也禁止借本人", () => {
    const p = allProfiles(app.config).find(p => p.id === "codex")!;
    used(20);
    try {
      for (const policy of ["own", "own-or-other"] as const) {
        app.config.agents.accounts.codex = policy;
        expect(memberAccountPlan(app, "bob", p).kind).toBe("blocked");
      }
      ensureAccountHome(app, "ann");
      run(app.db, "insert into kv(key,value) values('agent_account:ann:codex','{\"state\":\"logged-in\"}')");
      const plan = memberAccountPlan(app, "ann", p);
      expect(plan.kind === "ready" && selectedMemberAccount(plan.profile)?.holder).toBe("ann");
    } finally { delete app.config.agents.accounts.codex; }
  });

  it("话题内提示等待，设备码仅显示给发起成员，授权后原运行使用成员账号并回原话题", async () => {
    used(100);
    let finish: (() => void) | undefined;
    const unregister = registerCredential("fixture", {
      id: "login", name: "示例设备登录", provides: { backends: ["codex"] },
      login: (_ctx, show) => new Promise(resolve => {
        show({ url: "https://auth.example.test/device", code: "WXYZ-1234" });
        finish = () => resolve({ user: "member@example.test" });
      }),
    }, () => ({}), app);
    const unregisterSender = registerThreadSender("lark", async (_thread, text, meta) => {
      await sendLark({ replyTo: String(meta.larkReplyTo), inThread: !!meta.larkInThread }, { text });
    });
    try {
      const turn = await ask("team", "整理原来的任务", "ann", "omt_example");
      const id = turn.runId!;
      await vi.waitFor(() => {
        expect(getRun(app, id).status).toBe("queued");
        expect(ephemeral).toHaveBeenCalledTimes(1);
      }, { timeout: 15_000 });
      expect(ephemeral).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ chat_id: "team", open_id: "ou_ann" }) }));
      expect(JSON.stringify(ephemeral.mock.calls)).toContain("https://auth.example.test/device");
      expect(JSON.stringify(ephemeral.mock.calls)).toContain("WXYZ-1234");
      expect(card).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: "om_team" }, data: expect.objectContaining({ reply_in_thread: true }) }));
      expect(JSON.stringify(card.mock.calls)).not.toContain("WXYZ-1234");
      expect(runEvents(app, id).some(e => e.type === "prompt")).toBe(false);
      expect(JSON.stringify(getRun(app, id))).not.toContain("WXYZ-1234");
      backendLoginReady(app, "bob", "codex");
      expect(aiLoginWait(app, id)?.ready).toBeUndefined();
      used(5);
      finish!();
      const completed = await answer(id);
      expect(readFileSync(prompts, "utf8")).toContain("整理原来的任务");
      expect(completed.output.channelDelivered).toBe(true);
      account(id, "ann", "使用成员自己的登录");
      expect(card).toHaveBeenCalledTimes(2);
    } finally {
      unregisterSender();
      unregister();
    }
  }, 30_000);

  it("等待超时后在原私聊提醒，原运行结束且未消耗模型额度", async () => {
    const backend = allProfiles(app.config).find(p => p.id === "qr-demo")!;
    markOutOfQuota(app, backend, "You've hit your usage limit");
    await ask("timeout", "/agent qr-demo", "bob");
    const turn = await ask("timeout", "需要登录", "bob");
    const id = turn.runId!;
    try {
      await vi.waitFor(() => {
        expect(getRun(app, id).status).toBe("queued");
        expect(image).toHaveBeenCalled();
      }, { timeout: 15_000 });
      run(app.db, "update runs set input=json_set(input,'$.aiLoginWait.deadline',?), not_before=null where id=?", new Date(Date.now() - 1000).toISOString(), id);
      const result = await waitForRun(app, id);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("登录等待已超时");
      expect(JSON.stringify(card.mock.calls)).toContain("登录等待已超时");
      expect(readFileSync(prompts, "utf8")).toBe("");
    } finally { stopAccountLogins(); }
  }, 30_000);

  it("私聊扫码登录上传 PNG，等待期间停用原会话的模型调用", async () => {
    const backend = allProfiles(app.config).find(p => p.id === "qr-demo")!;
    markOutOfQuota(app, backend, "You've hit your usage limit");
    await ask("scan", "/agent qr-demo");
    const turn = await ask("scan", "这次用扫码账号");
    const id = turn.runId!;
    await vi.waitFor(() => {
      expect(getRun(app, id).status).toBe("queued");
      expect(image).toHaveBeenCalled();
    }, { timeout: 15_000 });
    expect(card).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: "om_scan" }, data: expect.objectContaining({ reply_in_thread: false }) }));
    expect(JSON.stringify(card.mock.calls)).toContain("img_qr");
    expect(runEvents(app, id).some(e => e.type === "prompt")).toBe(false);
    writeFileSync(join(ensureAccountHome(app, "ann"), "login-ok"), "");
    await answer(id);
    account(id, "ann", "使用成员自己的登录");
  }, 30_000);

  it("成员在共享会话指定的后端与个人默认各自隔离", async () => {
    const first = await ask("group", "/agent alternate", "ann", "omt_shared");
    expect(first.reply).toContain("alternate");
    expect(getThread(app, first.thread.id).settings.profile).toBeUndefined();
    expect((await answer((await ask("group", "用我指定的", "ann", "omt_shared")).runId!)).profileId).toBe("alternate");
    expect((await answer((await ask("group", "我没指定", "bob", "omt_shared")).runId!)).profileId).toBe("codex");
    expect((await ask("group", "/agent save alternate", "ann", "omt_shared")).reply).toContain("个人默认");
    expect((await ask("group", "/model save m2", "ann", "omt_shared")).reply).toContain("个人默认");
    expect(memberAi(app, "ann")).toMatchObject({ profile: "alternate", model: "m2" });
    expect(memberAi(app, "bob")).toEqual({});
    expect((await answer((await ask("fresh", "用我的默认")).runId!)).profileId).toBe("alternate");
    await ask("group", "/agent save default", "ann", "omt_shared");
  }, 30_000);

  it("网页保存的成员偏好和本人的任务说明一起交给决策模型", async () => {
    expect((await call("ann", "PUT", { guidance: "长会议纪要优先整理型模型" })).statusCode).toBe(200);
    expect((await call("bob", "GET")).json().ai).toEqual({});
    app.config.agents.routing = {
      automatic: true, guidance: "简单问题用响应快的", pinnedFallback: "unavailable",
      choose: { conversation: "decision", tasks: "decision", rules: "off" },
      candidates: [{ profile: "alternate", when: "适合长文整理" }],
    };
    app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
    app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
    setKey(app.home, "d", "fake-key");
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      answers: [{ type: "choice", name: "q", choice: "c1", probabilities: [] }],
    })));
    setDecisionFetchForTests(request as unknown as typeof fetch);
    try {
      expect((await answer((await ask("pick", "整理会议纪要")).runId!)).profileId).toBe("alternate");
      const material = JSON.stringify(request.mock.calls[0]?.[1]?.body);
      for (const text of ["长会议纪要优先整理型模型", "简单问题用响应快的", "适合长文整理"]) expect(material).toContain(text);
    } finally { setDecisionFetchForTests(null); }
  }, 30_000);

  it("成员自己的交办运行优先用个人默认，助手的自动建议只在没有个人指定时生效", async () => {
    expect((await call("ann", "PUT", { profile: "alternate", model: "m2" })).statusCode).toBe(200);
    const done = await runRole(app, {
      role: "assistant", userId: "ann", task: "整理测试说明", spaceId: "personal-ann", runId: null,
      execution: { profile: "codex", source: "auto", reason: "助手建议" },
    });
    expect(done.ai).toMatchObject({ profile: "alternate", model: "m2" });
    expect(JSON.parse(done.text).model).toBe("m2");
  }, 30_000);

  it("后台任务换用成员账号后用任务上下文开新会话", async () => {
    const task = { role: "assistant" as const, userId: "ann", task: "继续整理测试材料", spaceId: "personal-ann", runId: null, profileId: "codex", persistSession: true };
    ensureAccountHome(app, "ann");
    run(app.db, "insert into kv(key,value) values('agent_account:ann:codex','{\"state\":\"logged-in\"}')");
    used(20);
    const first = await runRole(app, task);
    expect(first.sessionId).toBeTruthy();
    used(95);
    const next = await runRole(app, { ...task, resumeSessionId: first.sessionId });
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(JSON.parse(next.text).resumed).toBe(false);
    const same = await runRole(app, { ...task, resumeSessionId: next.sessionId });
    expect(same.sessionId).toBe(next.sessionId);
    expect(JSON.parse(same.text).resumed).toBe(true);
  }, 30_000);
});
