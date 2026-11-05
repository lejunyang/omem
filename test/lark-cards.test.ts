import { afterEach, expect, it } from "vitest";
import { createAsk } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { createThread, updateThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { registerLarkAsks } from "../src/channels/lark-asks.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import { buildCard, setLarkClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setLarkClient(null);
  for (const app of apps.splice(0)) app.db.close();
});
function fresh() {
  const app = testApp();
  apps.push(app);
  app.config.lark.ownerOpenId = "ou_owner";
  return app;
}
/** A bot client that records the cards it posts. */
function poster() {
  const posted: { chat: string; card: any }[] = [];
  setLarkClient({
    im: {
      message: {
        create: async (a: any) => (posted.push({ chat: a.data.receive_id, card: JSON.parse(a.data.content) }), { code: 0, data: { message_id: `om_${posted.length}` } }),
        reply: async (a: any) => (posted.push({ chat: a.path.message_id, card: JSON.parse(a.data.content) }), { code: 0, data: { message_id: `om_${posted.length}` } }),
        patch: async () => ({ code: 0 }),
      },
    },
  });
  return posted;
}
const texts = (rows: any[]) => rows.map((r: any) => r.columns.map((c: any) => c.elements[0].text.content));

it("lays a form's questions out alike: a bold numbered line above each full-width field", () => {
  const card = buildCard({
    title: "上线前确认",
    blocks: [{
      form: {
        fields: [
          { type: "select", name: "env", label: "发到哪个环境", required: true, options: [{ text: "预发", value: "pre" }, { text: "线上", value: "prod" }] },
          { type: "multi_select", name: "checks", label: "做过哪些检查", options: [{ text: "回归", value: "reg" }] },
          { type: "person", name: "duty", label: "谁值班" },
          { type: "date", name: "day", label: "哪天发" },
          { type: "input", name: "note", label: "备注（*可选*）", multiline: true },
          { type: "checkbox", name: "told", label: "已通知相关同学" },
        ],
        cancel: "重置",
      },
    }],
  }) as any;
  const form = card.body.elements[0];
  expect(form).toMatchObject({ tag: "form", vertical_spacing: "4px" });
  expect(form.elements.map((e: any) => e.tag)).toEqual(["markdown", "select_static", "markdown", "multi_select_static", "markdown", "select_person", "markdown", "date_picker", "markdown", "input", "checker", "column_set"]);
  expect(form.elements.filter((e: any) => e.tag === "markdown").map((e: any) => e.content)).toEqual([
    "**1. 发到哪个环境** <font color='red'>*</font>", "**2. 做过哪些检查**", "**3. 谁值班**", "**4. 哪天发**", "**5. 备注（&#42;可选&#42;）**",
  ]);
  // The first question opens the form; each later one keeps a gap from the field above it.
  expect(form.elements[0].margin).toBeUndefined();
  expect(form.elements.filter((e: any) => e.tag === "markdown").slice(1).every((e: any) => e.margin === "12px 0px 0px 0px")).toBe(true);
  for (const e of form.elements.filter((x: any) => ["select_static", "multi_select_static", "select_person", "date_picker", "input"].includes(x.tag))) {
    expect(e.width).toBe("fill");
    expect(e.label).toBeUndefined();
  }
  expect(form.elements[9]).toMatchObject({ name: "note", input_type: "multiline_text" });
  const actions = form.elements.at(-1);
  expect(actions.margin).toBe("12px 0px 0px 0px");
  expect(actions.columns.map((c: any) => c.elements[0].form_action_type)).toEqual(["submit", "reset"]);
  // Labels numbered by the agent keep their numbers; a single question is not numbered.
  const numbered = buildCard({ blocks: [{ form: { fields: [{ type: "input", name: "a", label: "1. 先回答这个" }, { type: "input", name: "b", label: "2. 再回答这个" }] } }] }) as any;
  expect(numbered.body.elements[0].elements.filter((e: any) => e.tag === "markdown").map((e: any) => e.content)).toEqual(["**1. 先回答这个**", "**2. 再回答这个**"]);
  const single = buildCard({ blocks: [{ form: { fields: [{ type: "input", name: "a", label: "原因" }] } }] }) as any;
  expect(single.body.elements[0].elements[0].content).toBe("**原因**");
});

it("puts many buttons in even rows that fit a phone, and gives a long one a row of its own", () => {
  const card = buildCard({ blocks: [{ buttons: ["认领", "转给别人", "稍后处理", "不用管", "看详情"].map((text) => ({ text })) }] }) as any;
  const rows = card.body.elements;
  expect(texts(rows)).toEqual([["认领", "转给别人", "稍后处理"], ["不用管", "看详情"]]);
  expect(rows.every((r: any) => r.tag === "column_set" && r.flex_mode === "flow")).toBe(true);
  expect(rows.flatMap((r: any) => r.columns.map((c: any) => c.elements[0].name))).toEqual(["btn_0", "btn_1", "btn_2", "btn_3", "btn_4"]);
  // A few short ones stay in one row, as before.
  expect(texts((buildCard({ blocks: [{ buttons: [{ text: "批准" }, { text: "拒绝" }] }] }) as any).body.elements)).toEqual([["批准", "拒绝"]]);
  const long = (buildCard({ blocks: [{ buttons: [{ text: "打开授权页面并在五分钟内完成飞书登录确认", url: "https://example.com/auth" }, { text: "取消" }] }] }) as any).body.elements;
  expect(texts(long)).toEqual([["打开授权页面并在五分钟内完成飞书登录确认"], ["取消"]]);
  expect(long[0].columns[0].elements[0]).toMatchObject({ width: "fill", behaviors: [{ type: "open_url", default_url: "https://example.com/auth" }] });
  expect(long[1].columns[0].elements[0].width).toBeUndefined();
});

let sinkRegistered = false;
it("@s the person who has to answer an ask card in a group, not in a private chat", async () => {
  const app = fresh();
  if (!sinkRegistered) {
    registerLarkAsks(app, () => "ou_owner");
    sinkRegistered = true;
  }
  const posted = poster();
  const ask = async (key: string, kind: "question" | "approval" = "question") => {
    const t = createThread(app, { channel: "lark", key, spaceId: "personal", userId: "owner" });
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "问", input: { conversationId: t.id } });
    const before = posted.length;
    createAsk(app, { runId: r.id, conversationId: t.id, kind, question: kind === "approval" ? "要删掉旧事项" : "发布改到周四还是周五？", options: kind === "approval" ? [] : [{ label: "周四" }, { label: "周五" }], tool: kind === "approval" ? "forget" : undefined, args: kind === "approval" ? {} : undefined });
    await expect.poll(() => posted.length).toBe(before + 1);
    return { thread: t, card: posted.at(-1)!.card };
  };
  const first = (card: any) => card.body.elements[0].content as string;
  // A group: the card starts by @-ing the owner (open_id in the posting bot's app).
  const group = await ask("oc_team");
  expect(group.card.header.title.content).toBe("需要你回答");
  expect(first(group.card)).toBe("<at id=ou_owner></at> 发布改到周四还是周五？");
  expect(first((await ask("oc_team2", "approval")).card)).toBe("<at id=ou_owner></at> 要删掉旧事项");
  // The owner's private chat with the bot, or a conversation known not to be a group: no @.
  run(app.db, "insert into kv(key,value) values('lark_owner_chat','oc_dm')");
  expect(JSON.stringify((await ask("oc_dm")).card)).not.toContain("<at");
  const other = createThread(app, { channel: "lark", key: "oc_member_dm", spaceId: "personal", userId: "owner" });
  updateThread(app, other.id, { settings: { group: false } });
  expect(JSON.stringify((await ask("oc_member_dm")).card)).not.toContain("<at");
});

it("lark_card @s the people who may act on it in a group, only with ids this bot knows", async () => {
  const app = fresh();
  const posted = poster();
  const t = createThread(app, { spaceId: "personal", channel: "lark-watch", key: "oc_g" });
  const r = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id, messageIds: [] } });
  const ctx = toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g", "oc_dm"] }))!;
  rememberPerson(app, { botOpenId: "ou_wang", name: "小王" });
  const card = { title: "谁来处理", blocks: [{ markdown: "线上告警需要认领" }, { buttons: [{ text: "我来", value: "claim" }] }] };
  expect((await callTool(ctx, "lark_card", { chat_id: "oc_g", ...card, allowed: ["owner", "ou_wang", "ou_stranger"] })).isError).toBeFalsy();
  const elements = posted.at(-1)!.card.body.elements;
  expect(elements[0]).toEqual({ tag: "markdown", content: "<at id=ou_owner></at> <at id=ou_wang></at>" });
  expect(elements[1].content).toBe("线上告警需要认领");
  // Nothing to act on, or a private chat: no @.
  await callTool(ctx, "lark_card", { chat_id: "oc_g", title: "通知", blocks: [{ markdown: "已发布" }], allowed: ["owner"] });
  expect(JSON.stringify(posted.at(-1)!.card)).not.toContain("<at");
  run(app.db, "insert into kv(key,value) values('lark_owner_chat','oc_dm')");
  await callTool(ctx, "lark_card", { chat_id: "oc_dm", ...card, allowed: ["owner"] });
  expect(JSON.stringify(posted.at(-1)!.card)).not.toContain("<at");
});
