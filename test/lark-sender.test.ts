import { afterEach, expect, it, vi } from "vitest";
import type * as lark from "@larksuiteoapi/node-sdk";
import { testApp } from "./helpers.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { larkSenderNames } from "../src/channels/lark-sender.ts";
import { isApp, storeMessages } from "../src/channels/lark-messages.ts";
import { saveRule, listFirings } from "../src/rules/store.ts";
import { dispatchRuleEvent } from "../src/rules/engine.ts";
import type { RuleEvent } from "../src/rules/types.ts";

const apps: ReturnType<typeof testApp>[] = [];
const fresh = () => { const app = testApp(); apps.push(app); return app; };
afterEach(() => { setLarkCliForTests(null); vi.useRealTimers(); for (const app of apps.splice(0)) app.db.close(); });
const eventMessage = { id: "om_alert", chatId: "oc_alerts", fromApp: isApp({ sender: { sender_type: "bot" } }) };
const captured = { message_id: "om_alert", chat_id: "oc_alerts", msg_type: "interactive", content: "[卡片] CPU 报警", create_time: String(Date.now()), sender: { id: "cli_monitor", sender_type: "app", name: "监控机器人" } };
const client = (get: ReturnType<typeof vi.fn>) => ({ contact: { user: { get } } }) as unknown as lark.Client;

it("resolves a bot by the exact message, fires its name condition once and keeps bot-side IDs separate", async () => {
  const app = fresh(), contact = vi.fn();
  const lookup = vi.fn(async () => ({ data: { messages: [captured] } }));
  setLarkCliForTests(lookup);
  const nameOf = larkSenderNames(app, client(contact));
  const rule = saveRule(app, { name: "报警", description: "监控机器人的卡片通知本人", enabled: true, judge: "code", conditions: { all: [
    { field: "sender.name", op: "contains", value: "监控" }, { field: "sender.kind", op: "equals", value: "bot" }, { field: "message.type", op: "equals", value: "interactive" },
  ] }, actions: [{ type: "notify", urgent: false }] });
  const event: RuleEvent = { key: "lark:om_alert", kind: "message", at: new Date().toISOString(), via: "bot", chat: { id: "oc_alerts", name: "项目 A 报警群", kind: "group" },
    sender: { id: "ou_bot", name: await nameOf("ou_bot", eventMessage), kind: "bot" }, message: { id: "om_alert", text: captured.content, type: "interactive", mentionsOwner: false, mentionsBot: false } };
  await dispatchRuleEvent(app, event);
  await dispatchRuleEvent(app, { ...event, via: "capture" });
  expect(listFirings(app, rule.id)).toHaveLength(1);
  expect(await nameOf("ou_bot", { ...eventMessage, id: "om_next" })).toBe("监控机器人");
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(contact).not.toHaveBeenCalled();
  expect(app.db.prepare("select name,bot_open_id,cli_open_id,user_id from lark_people").get()).toEqual({ name: "监控机器人", bot_open_id: "ou_bot", cli_open_id: null, user_id: null });
});

it("retries failed lookups, rejects unrelated messages and refreshes successful names", async () => {
  const app = fresh(), contact = vi.fn();
  let response: unknown = { data: { messages: [{ ...captured, chat_id: "oc_other" }] } };
  setLarkCliForTests(async () => { if (response instanceof Error) throw response; return response; });
  const nameOf = larkSenderNames(app, client(contact));
  expect(await nameOf("ou_bot", eventMessage)).toBe("ou_bot");
  response = new Error("temporary timeout");
  expect(await nameOf("ou_bot", eventMessage)).toBe("ou_bot");
  response = { data: { messages: [captured] } };
  expect(await nameOf("ou_bot", eventMessage)).toBe("监控机器人");
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60_000);
  response = { data: { messages: [{ ...captured, sender: { ...captured.sender, name: "新监控机器人" } }] } };
  expect(await nameOf("ou_bot", eventMessage)).toBe("新监控机器人");
  expect(contact).not.toHaveBeenCalled();
});

it("does not poison later user names after a contact error", async () => {
  const contact = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ code: 0, data: { user: { name: "小王" } } });
  const nameOf = larkSenderNames(fresh(), client(contact));
  expect(await nameOf("ou_user")).toBe("ou_user");
  expect(await nameOf("ou_user")).toBe("小王");
});

it("repairs bot classification on capture without replacing the original sender ID", () => {
  const app = fresh();
  storeMessages(app, "oc_alerts", [{ ...captured, sender: { id: "ou_bot", name: "ou_bot" } }], {});
  storeMessages(app, "oc_alerts", [captured], {});
  expect(app.db.prepare("select sender_id,sender_name,sender_kind from lark_messages").get()).toEqual({ sender_id: "ou_bot", sender_name: "监控机器人", sender_kind: "app" });
  storeMessages(app, "oc_alerts", [{ ...captured, sender: { id: "ou_bot", name: "监控机器人" } }], {});
  expect(app.db.prepare("select sender_kind from lark_messages").get()).toEqual({ sender_kind: "app" });
  storeMessages(app, "oc_alerts", [{ ...captured, message_id: "om_event", sender: { id: "ou_bot", name: "监控机器人", sender_type: "bot" } }], {});
  expect(app.db.prepare("select sender_kind from lark_messages where message_id='om_event'").get()).toEqual({ sender_kind: "app" });
});
