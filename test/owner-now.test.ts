import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { run } from "../src/core/db.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";
import { createRun } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { ownerInChat, ownerNow } from "../src/agents/owner-now.ts";

describe("what the owner is doing right now", () => {
  const app = App.open(mkdtempSync(join(tmpdir(), "omem-owner-now-")));
  ensurePersonalSpace(app);
  const at = Date.parse("2026-03-04T06:30:00Z");
  const iso = (min: number) => new Date(at + min * 60_000).toISOString();
  const meeting = (id: string, topic: string, status: string, start: number, end: number | null) =>
    run(app.db, "insert into lark_meetings(meeting_id, topic, status, started_at, ended_at, updated_at) values(?,?,?,?,?,?)", id, topic, status, iso(start), end === null ? null : iso(end), iso(0));
  const message = (id: string, chat: string, kind: string, min: number) =>
    run(app.db, "insert into lark_messages(message_id, chat_id, sender_name, sender_kind, content, create_ms) values(?,?,?,?,?,?)", id, chat, kind === "owner" ? "本人" : "小王", kind, "…", at + min * 60_000);

  it("says nothing when there is nothing to see", () => {
    expect(ownerNow(app, at)).toBe("");
  });

  it("names the meeting going on, today's finished ones and where the owner just spoke", () => {
    meeting("m1", "周会", "listening", -20, null);
    meeting("m2", "方案评审", "ended", -180, -120);
    // One that never reported its end stops counting after a few hours.
    meeting("m3", "昨晚的通话", "joined", -600, null);
    message("om_1", "oc_team", "owner", -10);
    message("om_2", "oc_team", "user", -5);
    message("om_3", "oc_old", "owner", -300);
    const text = ownerNow(app, at);
    expect(text).toContain("正在开会：「周会」");
    expect(text).toContain("今天开过的会：「方案评审」");
    expect(text).not.toContain("昨晚的通话");
    expect(text).toContain("「oc_team」（10 分钟前）");
    expect(text).not.toContain("oc_old");
  });

  it("tells how the owner uses a chat: how much they wrote there and what the assistant was asked", () => {
    expect(ownerInChat(app, "oc_quiet", at)).toContain("没有在这里发过言");
    const t = createThread(app, { channel: "lark", spaceId: "personal", userId: "owner", key: "oc_team#omt_1" });
    const r = createRun(app, { kind: "ask", spaceId: "personal", title: "查一下这个账号的审核单", input: { conversationId: t.id }, userId: "owner" });
    run(app.db, "update runs set created_at = ? where id = ?", iso(-60), r.id);
    const text = ownerInChat(app, "oc_team", at);
    expect(text).toContain("发了 1 条消息");
    expect(text).toContain("查一下这个账号的审核单");
  });
});
