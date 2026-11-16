import { expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { setOwnerInChatForTests } from "../src/channels/lark-guest.ts";
import { all, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

const ctxFor = (app: ReturnType<typeof testApp>, runId: string) => toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;

it("keeps other people's business out of the owner's items", async () => {
  const app = testApp();
  app.config.lark.ownerOpenId = "ou_owner";
  const now = new Date().toISOString();
  for (const [id, chat] of [["s_oncall", "oc_oncall"], ["s_team", "oc_team"]])
    run(app.db, "insert into sources(id,space_id,kind,uri,title,hash,text,meta,captured_at,updated_at) values(?,'personal','chat',?,?,'h','[11-16 15:16] 小周: @助手 帮查一下这个账号','{}',?,?)", id, `lark:${chat}`, id, now, now);
  setOwnerInChatForTests("oc_oncall", false);
  setOwnerInChatForTests("oc_team", true);

  // Ingesting a group the owner is not in: no item for them.
  const ingest = createRun(app, { kind: "ingest", spaceId: "personal", title: "整理", input: { sourceIds: ["s_oncall"] } });
  const refused = await callTool(ctxFor(app, ingest.id), "upsert_item", { title: "查账号的线索场景", kind: "todo", source_refs: ["src:s_oncall#L1"] });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("本人不在");
  // The owner's own group: as before.
  const ok = await callTool(ctxFor(app, ingest.id), "upsert_item", { title: "回复小周的问题", kind: "todo", source_refs: ["src:s_team#L1"] });
  expect(ok.isError, ok.text).toBe(false);

  // A colleague asking the assistant: the assistant's job, not the owner's to-do.
  const thread = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_team", userId: "owner" });
  const asked = addMessage(app, thread.id, "user", "帮我把文档补完", null, { asker: "小周", askerId: "ou_zhou" });
  const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "补文档", input: { conversationId: thread.id, messageIds: [asked] }, trigger: { via: "chat", by: { key: "lark:ou_zhou", name: "小周" } } });
  const theirs = await callTool(ctxFor(app, turn.id), "upsert_item", { title: "补小周的文档", kind: "todo" });
  expect(theirs.text).toContain("小周请助手做的事");
  expect(all(app.db, "select title from items").map((i: any) => i.title)).toEqual(["回复小周的问题"]);
  app.db.close();
});
