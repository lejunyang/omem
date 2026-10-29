import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/core/db.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { sendItemDigests, sweepItems } from "../src/agents/jobs.ts";
import { listRuns } from "../src/agents/runs.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { applyBacklog, digestBody, digestFor, dueItems, expireDue, handledCandidates, itemExpiry, keepItem, markChecked } from "../src/items/expiry.ts";
import { addItemEvent, getItem, itemEvents, upsertItem } from "../src/items/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** Pretend the item was made, and last moved, `days` ago. */
function age(app: ReturnType<typeof testApp>, id: string, days: number) {
  run(app.db, "update items set created_at = ?, updated_at = ? where id = ?", ago(days), ago(days), id);
  run(app.db, "update item_events set at = ? where item_id = ?", ago(days), id);
}
const line = (ms: number, who: string, text: string, id: string) => `[${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}] ${who}: ${text} (${id})`;

afterEach(() => setLarkCliForTests(null));

describe("items close themselves", () => {
  it("expires by kind from the last real progress; a time still ahead holds it, a reminder goes a day after", () => {
    const app = testApp();
    const todo = upsertItem(app, undefined, { title: "补齐报销单" });
    expect(itemExpiry(app, todo)!.text).toMatch(/14 天没有新进展/);
    const later = upsertItem(app, undefined, { title: "月底交审计材料", dueAt: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(itemExpiry(app, later)!.text).toMatch(/截止时间过后 1 天/);
    const meeting = upsertItem(app, undefined, { title: "参加周会", kind: "reminder", remindAt: ago(2) });
    expect(Date.parse(itemExpiry(app, meeting)!.at)).toBeLessThan(Date.now());

    age(app, todo.id, 20);
    // An agent note without evidence is not progress; the owner's note is.
    addItemEvent(app, todo.id, "note", "仍在等待", "agent");
    expect(dueItems(app).map((d) => d.item.id)).toContain(todo.id);
    addItemEvent(app, todo.id, "note", "我周五交", "user");
    expect(dueItems(app).map((d) => d.item.id)).not.toContain(todo.id);
  });

  it("leaves the backlog for the owner, expires the rest, and reopens on keep or new evidence", () => {
    const app = testApp();
    const old = upsertItem(app, undefined, { title: "旧事项", kind: "decision" });
    const kept = upsertItem(app, undefined, { title: "要留下的", kind: "decision" });
    age(app, old.id, 30);
    age(app, kept.id, 30);
    // Expiry started now: these were overdue before it, so the hourly sweep leaves them.
    expect(expireDue(app)).toEqual([]);
    expect(dueItems(app).every((d) => d.backlog)).toBe(true);
    expect(applyBacklog(app, [kept.id])).toEqual([old.id]);
    expect(getItem(app, old.id).status).toBe("expired");
    expect(getItem(app, kept.id).status).toBe("open");
    expect(itemEvents(app, old.id).at(-1)!.text).toMatch(/^本人收尾积压：7 天没有新进展/);
    // Closed by the owner's own review: not news for the next digest.
    expect(digestFor(app, "owner")?.closed ?? []).toEqual([]);

    // After the backlog, the sweep handles newly overdue items.
    const fresh = upsertItem(app, undefined, { title: "新关注", kind: "watch" });
    age(app, fresh.id, 8);
    expect(expireDue(app)).toEqual([fresh.id]);

    // New evidence reopens an expired item; so does "keep".
    const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "note:x", title: "x", text: "进展" });
    upsertItem(app, old.id, { sourceRefs: [`src:${src.id}#L1`], note: "有新消息" }, "agent");
    expect(getItem(app, old.id).status).toBe("open");
    keepItem(app, fresh.id);
    expect(getItem(app, fresh.id).status).toBe("open");
    expect(getItem(app, fresh.id).closedAt).toBeNull();
  });

  it("finds items the owner acted on in the source chat, judges each piece once, and closes on DONE", async () => {
    const app = testApp();
    let reactions: Record<string, string[]> = {};
    setLarkCliForTests(async (args) => {
      if (args.includes("auth")) return { data: { identities: { user: { openId: "ou_me" } } } };
      const id = args[args.indexOf("--message-ids") + 1];
      // The shape lark-cli's +messages-mget really returns (checked against the CLI).
      const mine = reactions[id] ?? [];
      return { data: { messages: [{ message_id: id, ...(mine.length ? { reactions: { counts: mine.map((t) => ({ count: "1", reaction_type: t })), details: mine.map((t) => ({ action_time: "1793267838", emoji_type: t, operator: { operator_id: "ou_me", operator_type: "user" } })) } } : {}) }], total: 1 } };
    });
    const t = Date.now() - 3 * 3600_000;
    const chat = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_x", title: "项目 A 群", text: [line(t, "小王", "@本人 员工号要加白", "om_1"), line(t + 60_000, "本人（本人）", "已经加白了", "om_2")].join("\n") });
    const item = upsertItem(app, undefined, { title: "给员工号加白", sourceRefs: [`src:${chat.id}#L1`] });
    run(app.db, "update items set created_at = ? where id = ?", ago(0.1), item.id);
    applyBacklog(app);

    let cs = await handledCandidates(app);
    expect(cs.map((c) => c.item.id)).toEqual([item.id]);
    expect(cs[0].lines[0].text).toMatch(/已经加白了/);
    markChecked(app, cs[0]);
    expect(await handledCandidates(app)).toEqual([]);

    // The sweep hands fresh evidence to the item-keeper once, with the lines cited.
    upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_x", title: "项目 A 群", text: [line(t, "小王", "@本人 员工号要加白", "om_1"), line(t + 60_000, "本人（本人）", "已经加白了", "om_2"), line(t + 120_000, "本人（本人）", "回归也过了", "om_3")].join("\n") });
    const r = await sweepItems(app);
    expect(r.settle).toBeTruthy();
    const settle = listRuns(app, { kind: "item-settle" })[0];
    expect(settle.input.task).toMatch(/回归也过了.*src:/s);

    // A DONE reaction closes another item without a model.
    const other = upsertItem(app, undefined, { title: "确认上线时间", sourceRefs: [`src:${chat.id}#L1`] });
    run(app.db, "update items set created_at = ? where id = ?", ago(0.1), other.id);
    run(app.db, "update item_checks set evidence_ms = ? where item_id = ?", Date.now(), item.id);
    reactions = { om_1: ["DONE"] };
    await handledCandidates(app);
    expect(getItem(app, other.id).status).toBe("done");
    expect(itemEvents(app, other.id).at(-1)!.text).toMatch(/推断已处理：本人对来源消息回了 DONE/);
  });

  it("settles through the tool and reports it in the daily digest", async () => {
    const app = testApp();
    const ctx = toolContextForToken(app, issueToolToken({ runId: "r_t", spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "item-keeper" }))!;
    const a = upsertItem(app, undefined, { title: "回复小李的排期" });
    const b = upsertItem(app, undefined, { title: "看一下预览图问题" });
    const soon = upsertItem(app, undefined, { title: "关注报警复发", kind: "watch" });
    age(app, soon.id, 6.5);
    const r = await callTool(ctx, "settle_items", { verdicts: [{ item_id: a.id, verdict: "done", reason: "本人在群里答复了排期" }, { item_id: b.id, verdict: "keep", reason: "只说了“我看看”" }] });
    expect(r.text).toMatch(new RegExp(`${a.id} → done`));
    expect(getItem(app, b.id).status).toBe("open");

    const d = digestFor(app, "owner")!;
    expect(d.closed.map((c) => c.id)).toEqual([a.id]);
    expect(d.soon.map((s) => s.item.id)).toEqual([soon.id]);
    expect(digestBody(app, d)).toMatch(/看起来已经处理了（1）[\s\S]*本人在群里答复了排期[\s\S]*明天会自动过期（1）/);
    const sent = await sendItemDigests(app);
    expect(sent[0].title).toBe("事项清点：1 件看起来已办，1 件明天过期");
    expect(sent[0].digest).toEqual({ closed: [a.id], soon: [soon.id] });
    // Nothing new since: no second card.
    expect(await sendItemDigests(app)).toEqual([]);
  });
});
