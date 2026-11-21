import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { addMessage, threadMessages } from "../src/agents/threads.ts";
import { watchedNote } from "../src/agents/sessions.ts";
import { watchChat } from "../src/channels/lark-watch.ts";
import { contextsOfChat } from "../src/channels/listen.ts";
import { directExperience, recordCase, watchExperience } from "../src/channels/watch-trial.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

async function setup() {
  const app = testApp(); apps.push(app);
  saveAgentSpec(app, { name: "helper", description: "帮忙", prompt: "回答接口进度。" }, "user");
  await watchChat(app, "oc_team", { spec: "helper", on: "all", reply: "draft" });
  const c = contextsOfChat(app, "oc_team")[0];
  recordCase(app, c, { chatId: "oc_team", chatName: "项目群", runId: null, asker: "小王", ask: "接口什么时候能联调", decision: "quiet", reason: "本人自己回" });
  recordCase(app, c, { chatId: "oc_team", chatName: "项目群", runId: null, asker: "小李", ask: "周会改到周四吗", decision: "quiet", reason: "不用回" });
  return { app, c };
}

describe("关注里学到的经验也给直接 @ 机器人的那一轮", () => {
  it("同一个群：盯群的批次和直接 @ 拿到同一组案例和经验", async () => {
    const { app, c } = await setup();
    const text = "接口什么时候能联调";
    const batch = await watchExperience(app, c, { text, chatId: "oc_team" });
    const direct = await directExperience(app, { chatId: "oc_team", text, userId: "owner", guest: false });
    expect(direct).not.toBeNull();
    expect(direct!.picked).toMatchObject({ context: c.id, cases: batch.picked.cases, playbook: batch.picked.playbook, lessons: batch.picked.lessons });
    expect(batch.picked.cases.length).toBe(2);
    expect(direct!.text).toContain("相近的案例");
    expect(direct!.text).toContain(batch.cases);
    // The batch itself shows the same cases.
    addMessage(app, c.conversationId!, "user", text, null, { speaker: "小王", chatId: "oc_team" });
    const note = await watchedNote(app, { id: c.conversationId!, userId: "owner" } as never, threadMessages(app, c.conversationId!));
    expect(note).toContain(batch.cases);
  });

  it("没有关注的群不受影响；访客不带", async () => {
    const { app } = await setup();
    expect(await directExperience(app, { chatId: "oc_other", text: "接口什么时候能联调", userId: "owner", guest: false })).toBeNull();
    expect(await directExperience(app, { chatId: "oc_team", text: "接口什么时候能联调", userId: "owner", guest: true })).toBeNull();
  });

  it("成员只拿得到自己能读的空间里的关注", async () => {
    const { app } = await setup();
    createSpace(app, { id: "other", name: "别的项目" });
    const member = createUser(app, { name: "示例成员" });
    expect(await directExperience(app, { chatId: "oc_team", text: "接口什么时候能联调", userId: member.id, guest: false })).toBeNull();
  });
});
