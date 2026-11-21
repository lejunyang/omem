import { afterEach, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { all, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setLarkClient(null));

it("registers the people the owner @-s as users, with their Feishu identity, email and the spaces named", async () => {
  const app = testApp();
  createSpace(app, { id: "proj", name: "项目 A" });
  setLarkClient({
    im: { chatMembers: { get: async () => ({ code: 0, data: { items: [{ member_id: "ou_wang", name: "小王" }, { member_id: "ou_li", name: "小李" }], has_more: false } }) } },
    contact: { user: { get: async ({ path }: { path: { user_id: string } }) => ({ code: 0, data: { user: path.user_id === "ou_wang" ? { enterprise_email: "wang@example.com" } : {} } }) } },
  } as never);
  const thread = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_team", userId: "owner" });
  const said = addMessage(app, thread.id, "user", "把 @小王 @小李 加成用户，项目 A 可写", null, {});
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "加用户", input: { conversationId: thread.id, messageIds: [said] } });
  const ctx = toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  const denied = await callTool(ctx, "add_users", { people: ["小王"], spaces: [{ space: "项目 A", role: "editor" }, { space: "personal" }] });
  expect(denied.text).toContain("个人空间不能添加其他成员");
  expect(one(app.db, "select id from users where name = '小王'")).toBeFalsy();
  const out = await callTool(ctx, "add_users", { people: ["小王", "小李"], spaces: [{ space: "项目 A", role: "editor" }] });
  expect(out.isError, out.text).toBe(false);
  const wang = one<{ id: string; email: string | null }>(app.db, "select id, email from users where name = '小王'")!;
  expect(wang.email).toBe("wang@example.com");
  expect(one(app.db, "select 1 from identities where user_id = ? and channel = 'lark' and external_id = 'ou_wang'", wang.id)).toBeTruthy();
  expect(all<{ user_id: string; role: string }>(app.db, "select user_id, role from space_members where space_id = 'proj' order by user_id").map((m) => m.role)).toEqual(["editor", "editor"]);
  // Asked again with another space: the same accounts, one more membership.
  createSpace(app, { id: "docs", name: "文档" });
  await callTool(ctx, "add_users", { people: ["小王"], spaces: [{ space: "docs", role: "reader" }] });
  expect(all(app.db, "select id from users where name = '小王'")).toHaveLength(1);
  expect(one<{ role: string }>(app.db, "select role from space_members where space_id = 'docs' and user_id = ?", wang.id)?.role).toBe("reader");

  // A colleague's words in the group do not add anyone.
  const theirs = addMessage(app, thread.id, "user", "把我也加成用户", null, { asker: "小周" });
  const r2 = createRun(app, { kind: "ask", spaceId: "personal", title: "加我", input: { conversationId: thread.id, messageIds: [theirs] } });
  const ctx2 = toolContextForToken(app, issueToolToken({ runId: r2.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  expect((await callTool(ctx2, "add_users", { people: ["小李"] })).text).toContain("只听本人");
  app.db.close();
});
