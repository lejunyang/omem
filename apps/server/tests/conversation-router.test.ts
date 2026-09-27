import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRouter } from "../src/conversation/router.js";
import { Store } from "../src/store.js";

const resources: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-router-"));
  const store = new Store(directory);
  resources.push({ directory, store });
  return { directory, store, router: new ConversationRouter(store.db) };
};

describe("V3-04 ConversationRouter", () => {
  it("opens one conversation per principal+channel+chat+thread key", () => {
    const { router } = setup();
    const first = router.open({
      principalId: "owner",
      channel: "lark_p2p",
      chatId: "oc_owner",
      visibility: "private",
    });
    const again = router.open({
      principalId: "owner",
      channel: "lark_p2p",
      chatId: "oc_owner",
      visibility: "private",
    });
    expect(again.id).toBe(first.id);
    expect(router.open({ principalId: "owner", channel: "lark_p2p", chatId: "oc_other", visibility: "private" }).id).not.toBe(first.id);
    expect(router.open({ principalId: "owner", channel: "web", chatId: "web-1", visibility: "private" }).id).not.toBe(first.id);
    expect(first.visibility).toBe("private");
    expect(first.threadId).toBe("");
  });

  it("records turns with monotonic ordinals and history", () => {
    const { router } = setup();
    const conversation = router.open({
      principalId: "owner",
      channel: "web",
      chatId: "web-1",
      visibility: "private",
    });
    expect(router.nextOrdinal(conversation.id)).toBe(1);
    const t1 = router.recordTurn({
      conversationId: conversation.id,
      inputText: "找接口说明",
      inputMessageRefs: {},
      selectedEvidence: [{ fragmentId: "f1" }],
      toolActions: [],
      result: "找到了",
    });
    const t2 = router.recordTurn({
      conversationId: conversation.id,
      inputText: "整理下一步",
      inputMessageRefs: {},
      selectedEvidence: [],
      toolActions: [{ tool: "create_task", taskId: "task-1" }],
      result: "已记录",
    });
    expect(t1.ordinal).toBe(1);
    expect(t2.ordinal).toBe(2);
    expect(router.nextOrdinal(conversation.id)).toBe(3);
    const history = router.turns(conversation.id);
    expect(history.map((t) => t.inputText)).toEqual([
      "找接口说明",
      "整理下一步",
    ]);
    expect(history[1]!.toolActions).toEqual([
      { tool: "create_task", taskId: "task-1" },
    ]);
  });

  it("persists current goal on the conversation", () => {
    const { router } = setup();
    const conversation = router.open({
      principalId: "owner",
      channel: "web",
      chatId: "web-2",
      visibility: "private",
    });
    router.setGoal(conversation.id, "整理接口文档");
    expect(router.get(conversation.id)?.currentGoal).toBe("整理接口文档");
  });
});
