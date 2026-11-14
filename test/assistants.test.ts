import { describe, expect, it } from "vitest";
import { listAssistants, overDailyLimit, removeAssistant, updateAssistant } from "../src/agents/assistants.ts";
import { receive } from "../src/agents/inbox.ts";
import { botSender } from "../src/channels/lark-bots.ts";
import { run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

/** The owner's second bot and a member's assistant, as the settings keep them. */
function setup() {
  const app = testApp();
  const wang = createUser(app, { name: "小王" }).id;
  app.config.lark.bots = [
    { id: "oncall", appId: "cli_a1", agent: "assistant", enabled: true, ownerOpenId: "ou_owner_in_a1" },
    { id: "wang-helper", appId: "cli_b2", agent: "assistant", enabled: true, ownerOpenId: "ou_wang_in_b2", userId: wang, name: "小王的写作助手", description: "帮小王改周报", dailyRuns: 2 },
  ];
  return { app, wang };
}

describe("assistants: each bot is someone's", () => {
  it("a member's assistant knows its maker as that member, and says whose it is", async () => {
    const { app, wang } = setup();
    const [mine, theirs] = app.config.lark.bots;
    expect(botSender(app, mine, { open_id: "ou_owner_in_a1" })).toBe("owner");
    expect(botSender(app, theirs, { open_id: "ou_wang_in_b2" })).toBe(wang);
    expect(botSender(app, theirs, { open_id: "ou_someone_else" })).toBeNull();
    const list = await listAssistants(app);
    expect(list.map((a) => [a.id, a.userId, a.name])).toEqual([["oncall", "owner", "oncall"], ["wang-helper", wang, "小王的写作助手"]]);
    expect(list[1]).toMatchObject({ userName: "小王", description: "帮小王改周报", dailyRuns: 2, todayRuns: 0 });
  });

  it("only its owner or the node's owner changes it; the daily limit is the node owner's to set", async () => {
    const { app, wang } = setup();
    await expect(updateAssistant(app, wang, "oncall", { description: "x" })).rejects.toThrow(/只能管理自己的助手/);
    await expect(updateAssistant(app, wang, "wang-helper", { dailyRuns: 100 })).rejects.toThrow(/主人设置/);
    expect(await updateAssistant(app, wang, "wang-helper", { description: "改周报和邮件" })).toMatchObject({ description: "改周报和邮件" });
    expect(await updateAssistant(app, "owner", "wang-helper", { dailyRuns: 1 })).toMatchObject({ dailyRuns: 1 });
    expect(() => removeAssistant(app, wang, "oncall")).toThrow(/只能管理自己的助手/);
    removeAssistant(app, wang, "wang-helper");
    expect(app.config.lark.bots.map((b) => b.id)).toEqual(["oncall"]);
  });

  it("past its daily limit a turn does not run and the sender is told", async () => {
    const { app, wang } = setup();
    await updateAssistant(app, "owner", "wang-helper", { dailyRuns: 1 });
    const to = { channel: "lark:wang-helper", chatId: "oc_p2p", isGroup: false, userId: wang, mergeMs: 0 };
    const first = await receive(app, { ...to, text: "帮我改一下周报" });
    expect(first.runId).toBeTruthy();
    // The turn has run (a message arriving while it still waits would join it).
    run(app.db, "update runs set status = 'done' where id = ?", first.runId!);
    expect(overDailyLimit(app, "lark:wang-helper")).toMatch(/每天 1 次/);
    const second = await receive(app, { ...to, text: "再改一版" });
    expect(second).toMatchObject({ runId: null, reply: expect.stringContaining("次数用完了") });
    // The main bot and bots without a limit are not counted.
    expect(overDailyLimit(app, "lark")).toBeNull();
    expect(overDailyLimit(app, "lark:oncall")).toBeNull();
  });
});
