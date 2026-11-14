import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { deliverToThread } from "../src/agents/inbox.ts";
import { one } from "../src/core/db.ts";
import { notify } from "../src/core/notify.ts";
import { createUser, linkIdentity, resolveIdentity } from "../src/core/users.ts";
import { describePlugin, forgetPlugin, getPlugin, reloadPlugin, setPluginEnabled, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { savePluginSettings } from "../src/plugins/settings.ts";
import { getRun } from "../src/agents/runs.ts";

type Fixture = { receive: (m: Record<string, unknown>) => Promise<void>; sent: { to: { chatId: string; topicId?: string }; text: string }[]; fail: boolean };
const fixture = () => (globalThis as unknown as { pluginChannelFixture: Fixture }).pluginChannelFixture;

describe("插件聊天渠道", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-plugin-channel-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" } }] }, sessions: { mergeMs: 0 } }));
  const dir = join(home, "plugins/chatfixture"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: chatfixture\nname: 示例聊天\nsettings:\n  - { key: ownerId, label: 本人在这个平台上的 id, type: text }\n");
  writeFileSync(join(dir, "server.mjs"), `export default function register(api) {
    const state = globalThis.pluginChannelFixture = { sent: [], fail: false };
    const channel = api.channel({ id: "matrix", label: "Matrix", maxLength: 4000,
      owner: (settings) => settings.ownerId,
      send: async (to, text) => { if (state.fail) throw new Error("示例发送失败"); state.sent.push({ to, text }); } });
    state.receive = channel.receive;
  }`);
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => { forgetPlugin("chatfixture"); releaseAll(); await server.close(); });
  const message = (senderId: string, extra = {}) => ({ chatId: senderId, senderId, isGroup: false, text: "项目 A 进展", messageId: `m-${Math.random()}`, ...extra });
  const bind = (id: string) => savePluginSettings(app, "chatfixture", getPlugin("chatfixture").manifest.settings, "owner", "personal", { ownerId: id });

  it("未信任时不运行；隔离模式明确拒绝渠道", async () => {
    expect(getPlugin("chatfixture").channels).toEqual([]);
    await expect(trustPlugin(app, "chatfixture", "isolated")).rejects.toThrow(/聊天渠道/);
    expect(getPlugin("chatfixture").trust).toBe("required");
    await trustPlugin(app, "chatfixture", "inprocess");
    expect(describePlugin(getPlugin("chatfixture")).channels[0]).toMatchObject({ id: "chatfixture-matrix", running: true });
  });

  it("未设本人时私聊提示绑定，群里和未绑定用户不启动运行", async () => {
    await fixture().receive(message("unknown"));
    expect(fixture().sent).toHaveLength(1); expect(fixture().sent[0].text).toContain("unknown");
    await fixture().receive(message("unknown", { isGroup: true, addressed: true }));
    bind("owner-platform");
    await fixture().receive(message("unknown"));
    await fixture().receive(message("owner-platform", { isGroup: true, addressed: false }));
    expect(fixture().sent).toHaveLength(1);
    expect(one(app.db, "select count(*) n from runs where kind='ask'")).toEqual({ n: 0 });
  });

  it("绑定本人经真实 ACP/MCP 桥开一轮，回复和后续投递经过 send", async () => {
    await fixture().receive(message("owner-platform", { chatId: "room", topicId: "topic", isGroup: true, addressed: true }));
    const sent = fixture().sent.at(-1)!;
    expect(sent.to).toEqual({ chatId: "room", topicId: "topic" });
    expect(JSON.parse(sent.text).msgs).toEqual(["项目 A 进展"]);
    const thread = one<{ id: string }>(app.db, "select id from conversations where channel='chatfixture-matrix'")!;
    const run = one<{ id: string }>(app.db, "select id from runs where kind='ask' order by created_at desc limit 1")!;
    expect(getRun(app, run.id)).toMatchObject({ status: "done" });
    expect(one(app.db, "select user_id from conversations where id=?", thread.id)).toEqual({ user_id: "owner" });
    expect(await deliverToThread(app, thread.id, "后续结果")).toBe(true);
    expect(fixture().sent.at(-1)).toMatchObject({ to: { chatId: "room", topicId: "topic" }, text: "后续结果" });
  }, 60000);

  it("通知给本人或成员的私聊，长消息分段；send 出错只记录", async () => {
    const before = fixture().sent.length;
    notify(app, { title: "提醒", body: "项目 A", urgency: "urgent" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fixture().sent.at(-1)).toMatchObject({ to: { chatId: "owner-platform" }, text: "提醒\n项目 A" });
    const user = createUser(app, { name: "小王" }); linkIdentity(app, user.id, "chatfixture-matrix", "member-platform");
    notify(app, { title: "成员提醒", body: "项目 A", userId: user.id, urgency: "urgent" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fixture().sent.at(-1)?.to.chatId).toBe("member-platform");
    const thread = one<{ id: string }>(app.db, "select id from conversations where channel='chatfixture-matrix'")!;
    await deliverToThread(app, thread.id, "字".repeat(9000));
    expect(fixture().sent.slice(before).every((s) => s.text.length <= 4000)).toBe(true);
    fixture().fail = true;
    await expect(deliverToThread(app, thread.id, "失败测试")).resolves.toBe(true);
    expect(getPlugin("chatfixture").channels[0].lastError).toBe("示例发送失败");
    fixture().fail = false;
  });

  it("停用立即注销 sender、sink 和身份解析，旧 receive 失效；重启只注册一次", async () => {
    const old = fixture(), before = old.sent.length;
    const thread = one<{ id: string }>(app.db, "select id from conversations where channel='chatfixture-matrix'")!;
    await setPluginEnabled(app, "chatfixture", false);
    expect(await deliverToThread(app, thread.id, "停止后不发")).toBe(false);
    notify(app, { title: "停止后通知", urgency: "urgent" });
    await old.receive(message("owner-platform"));
    await new Promise((r) => setTimeout(r, 30));
    expect(old.sent).toHaveLength(before);
    expect(resolveIdentity(app, "chatfixture-matrix", "owner-platform")).toBeNull();
    expect(getPlugin("chatfixture").channels[0].running).toBe(false);
    await setPluginEnabled(app, "chatfixture", true);
    notify(app, { title: "重新启用", urgency: "urgent" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fixture().sent).toHaveLength(1);
    untrustPlugin(app, "chatfixture");
    expect(getPlugin("chatfixture").channels[0].running).toBe(false);
  });
});
