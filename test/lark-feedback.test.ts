import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { reviewTask } from "../src/agents/profile-jobs.ts";
import { all, one, run } from "../src/core/db.ts";
import { setupLarkBot } from "../src/channels/lark-bot.ts";
import { summarizeCheck } from "../src/channels/lark-bot-check.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { feedbackStats, markLarkSent, onLarkReaction, polarityOf, reactionEventsQuiet, recordLarkSent } from "../src/channels/lark-feedback.ts";
import { checkLarkApp } from "../src/channels/lark-setup.ts";
import { onLarkSent, sendLark, setLarkBotClient } from "../src/channels/lark-send.ts";
import { ownerReactions, reactionsBy } from "../src/channels/notify-gate.ts";
import { shortcomings, shortcomingsText } from "../src/memory/gaps.ts";
import { testApp } from "./helpers.ts";

/** A bot client: records posts; any other SDK call answers with an empty success. */
function fakeClient(sent: string[]) {
  const post = () => {
    const id = `om_bot_${sent.length + 1}`;
    sent.push(id);
    return { code: 0, data: { message_id: id, chat_id: "oc_team" } };
  };
  const overrides: Record<string, (...a: any[]) => Promise<unknown>> = {
    request: async (o: { url: string }) => (o.url.includes("/bot/v3/info") ? { bot: { open_id: "ou_bot", app_name: "小助手" } } : { code: 1, msg: "unsupported in test" }),
    "im.message.reply": async () => post(),
    "im.message.create": async () => post(),
  };
  const make = (path: string): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (typeof k !== "string" || k === "then" ? undefined : make(path ? `${path}.${k}` : k)),
      apply: (_t, _this, args) => (overrides[path] ?? (async () => ({ code: 0, data: {} })))(...args),
    });
  return make("");
}

const reaction = (messageId: string, emoji: string, openId: string, operator = "user") => ({
  event_id: "ev",
  message_id: messageId,
  reaction_type: { emoji_type: emoji },
  operator_type: operator,
  user_id: { open_id: openId, union_id: `on_${openId}` },
  action_time: String(Date.now()),
});

afterEach(() => {
  onLarkSent(null);
  setLarkBotClient("main", null);
  setLarkCliForTests(null);
});

describe("reaction feedback", () => {
  it("records what the bot sends, and everyone's reactions on it, by run, profile and model", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const sent: string[] = [];
    const bot = await setupLarkBot(app, "main", fakeClient(sent));

    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "问答", input: { conversationId: "c_1" } });
    run(app.db, "update runs set roles = '|assistant|', ai = ? where id = ?", JSON.stringify({ profile: "codex", model: "gpt-x", effort: "low" }), r.id);
    // A progress card that later becomes the answer, a card, a notification.
    const progress = await sendLark({ chatId: "oc_team", purpose: "progress", runId: r.id }, { card: { elements: [] } });
    const card = await sendLark({ chatId: "oc_team" }, { card: { elements: [] } });
    const note = await sendLark({ userId: "ou_owner", purpose: "notification" }, { markdown: "提醒" });
    const rows = () => Object.fromEntries(all<{ message_id: string; purpose: string; run_id: string | null; conversation_id: string | null }>(app.db, "select * from lark_sent").map((x) => [x.message_id, x]));
    expect(rows()[progress.messageId]).toMatchObject({ purpose: "progress", run_id: r.id, conversation_id: "c_1" });
    expect(rows()[card.messageId].purpose).toBe("card");
    expect(rows()[note.messageId].purpose).toBe("notification");
    markLarkSent(app, progress.messageId, { purpose: "answer", runId: r.id });
    expect(rows()[progress.messageId].purpose).toBe("answer");

    // The owner likes it, a guest does not, a member acknowledges; the bot's own OnIt is ignored.
    await bot.reaction(reaction(progress.messageId, "THUMBSUP", "ou_owner"), "created");
    await bot.reaction(reaction(progress.messageId, "thumbsdown", "ou_stranger"), "created");
    await bot.reaction(reaction(progress.messageId, "OK", "ou_stranger"), "created");
    await bot.reaction(reaction(progress.messageId, "OnIt", "cli_app", "app"), "created");
    await bot.reaction(reaction(progress.messageId, "SomethingNew", "ou_owner"), "created");
    const fb = all<{ emoji: string; polarity: string; actor_kind: string; run_id: string; on_bot: number }>(app.db, "select emoji, polarity, actor_kind, run_id, on_bot from feedback order by emoji");
    expect(fb.map((f) => [f.emoji, f.polarity, f.actor_kind])).toEqual([
      ["OK", "ack", "guest"],
      ["SomethingNew", "neutral", "owner"],
      ["THUMBSUP", "positive", "owner"],
      ["thumbsdown", "negative", "guest"],
    ]);
    expect(fb.every((f) => f.run_id === r.id && f.on_bot === 1)).toBe(true);

    const stats = feedbackStats(app, 30);
    expect(stats.byProfile[0]).toMatchObject({ key: "assistant", owner: { positive: 1, negative: 0, neutral: 1 }, guests: { negative: 1, ack: 1 } });
    expect(stats.byModel[0].key).toBe("codex / gpt-x / low");

    // Removing a reaction keeps the row; adding it again brings it back.
    await bot.reaction(reaction(progress.messageId, "THUMBSUP", "ou_owner"), "deleted");
    expect(one<{ removed_at: string | null }>(app.db, "select removed_at from feedback where emoji = 'THUMBSUP'")!.removed_at).toBeTruthy();
    expect(feedbackStats(app, 30).byProfile[0].owner.positive).toBe(0);
    await bot.reaction(reaction(progress.messageId, "THUMBSUP", "ou_owner"), "created");
    expect(feedbackStats(app, 30).byProfile[0].owner.positive).toBe(1);

    // Someone else's message: only the owner's reaction is kept, and the notification gate reads it without lark-cli.
    await bot.reaction(reaction("om_other", "DONE", "ou_stranger"), "created");
    await bot.reaction(reaction("om_other", "DONE", "ou_owner"), "created");
    expect(all(app.db, "select 1 from feedback where message_id = 'om_other'")).toHaveLength(1);
    setLarkCliForTests(async () => {
      throw new Error("lark-cli should not be asked");
    });
    expect(await ownerReactions(app, "om_other")).toEqual(["DONE"]);

    // The first raw events are kept for checking field names on the real server.
    const samples = JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = 'lark_reaction_samples'")!.value);
    expect(samples.created).toHaveLength(3);
    expect(samples.deleted).toHaveLength(1);

    // The dreamer's shortcomings and the coach's evidence see the negative reaction.
    const gaps = shortcomings(app, {});
    expect(gaps.reactions.negative[0]).toMatchObject({ runId: r.id, emoji: "thumbsdown", actorKind: "guest" });
    expect(shortcomingsText(gaps)).toMatch(/负面表情/);
    run(app.db, "update runs set status = 'done', finished_at = ?, created_at = ? where id = ?", new Date().toISOString(), new Date().toISOString(), r.id);
    expect(reviewTask(app, "assistant", "2000-01-01").task).toMatch(/本人 THUMBSUP（正面）/);
  });

  it("maps emoji types case-insensitively, with acknowledgements apart", () => {
    const app = testApp();
    expect(polarityOf(app, "thumbsup")).toBe("positive");
    expect(polarityOf(app, "CROSSMARK")).toBe("negative");
    expect(polarityOf(app, "Done")).toBe("ack");
    expect(polarityOf(app, "JIAYI")).toBe("ack");
    expect(polarityOf(app, "SMILE")).toBe("neutral");
    app.config.feedback.emoji.positive.push("SMILE");
    expect(polarityOf(app, "smile")).toBe("positive");
  });

  it("reads reactions in the shape lark-cli +messages-mget really returns", () => {
    const v = {
      ok: true,
      data: {
        messages: [
          {
            message_id: "om_1",
            reactions: {
              counts: [{ count: "2", reaction_type: "THUMBSUP" }],
              details: [
                { action_time: "1793267838", emoji_type: "THUMBSUP", operator: { operator_id: "ou_me", operator_type: "user" } },
                { action_time: "1793267628", emoji_type: "Get", operator: { operator_id: "ou_other", operator_type: "user" } },
              ],
            },
          },
        ],
        total: 1,
      },
    };
    expect(reactionsBy(v, "om_1", "ou_me")).toEqual(["THUMBSUP"]);
    expect(reactionsBy(v, "om_1", "ou_nobody")).toEqual([]);
    expect(reactionsBy({ data: { messages: [{ message_id: "om_1" }] } }, "om_1", "ou_me")).toEqual([]);
  });

  it("checks the app's permissions and event subscriptions, with a heuristic when they cannot be read", async () => {
    const app = testApp();
    const fetcher = (async (url: string) => {
      const body = url.includes("tenant_access_token")
        ? { code: 0, tenant_access_token: "t" }
        : url.includes("/bot/v3/info")
          ? { code: 0, bot: { open_id: "ou_bot", app_name: "小助手" } }
          : url.includes("/app_versions/")
            ? { code: 0, data: { app_version: { events: ["im.message.receive_v1"] } } }
            : { code: 0, data: { app: { scopes: [{ scope: "im:message" }], online_version_id: "v1", event: { subscription_type: "websocket", subscribed_events: ["im.message.receive_v1", "im.message.reaction.created_v1"] }, callback: { subscribed_callbacks: [] } } } };
      return { json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const check = await checkLarkApp("cli_main", "secret", fetcher);
    const s = summarizeCheck(app, "main", "cli_main", check);
    expect(s.scopes.missing).toContain("im:message.reactions:read");
    expect(s.scopes.link).toMatch(/open\.feishu\.cn\/app\/cli_main\/auth\?q=.*im:message\.reactions:read/);
    expect(s.events.missing.map((e) => e.name)).toEqual(["im.message.reaction.deleted_v1", "vc.bot.meeting_invited_v1"]);
    expect(s.events.missing.find((e) => e.name === "vc.bot.meeting_invited_v1")!.optional).toBe(true);
    expect(s.events.unpublished).toEqual(["im.message.reaction.created_v1"]);
    expect(s.events.link).toBe("https://open.feishu.cn/app/cli_main/event");
    expect(s.callbacks.missing.map((c) => c.name)).toEqual(["card.action.trigger"]);

    // Feishu does not list subscriptions: unknown, and the heuristic says whether events ever came.
    const unknown = summarizeCheck(app, "main", "cli_main", { missingScopes: [], events: null });
    expect(unknown.events.subscribed).toBeNull();
    expect(unknown.events.missing).toEqual([]);
    for (let i = 0; i < 25; i++) recordLarkSent(app, { messageId: `om_${i}`, purpose: "answer", bot: "main" });
    expect(reactionEventsQuiet(app)).toMatchObject({ quiet: true, botMessages: 25, reactions: 0 });
  });
});
