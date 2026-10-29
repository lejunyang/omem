import { describe, expect, it } from "vitest";
import { createProposal, expireProposals } from "../src/agents/proposals.ts";
import { all, one, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

describe("profile proposals expire", () => {
  it("announces once two days before, expires after 14 days only once announced, and a refined proposal starts over", async () => {
    const app = testApp();
    const make = (title: string, days: number) => {
      const id = createProposal(app, { target: "assistant", kind: "settings", title, reason: "复盘", content: { add_tools: ["scan"] }, runId: null });
      run(app.db, "update profile_proposals set created_at = ? where id = ?", ago(days), id);
      return id;
    };
    const fresh = make("新的", 1);
    const soon = make("快到期", 12.5);
    const old = make("过期的", 15);
    // Many pending is fine: no cap.
    for (let i = 0; i < 8; i++) make(`其他 ${i}`, 2);

    // One already past 14 days but never announced is announced first, not expired.
    expect(await expireProposals(app)).toEqual({ expired: 0, noticed: 2 });
    const status = (id: string) => one<{ status: string; expiry_notice_at: string | null }>(app.db, "select status, expiry_notice_at from profile_proposals where id = ?", id)!;
    expect(status(old).status).toBe("pending");
    expect(status(old).expiry_notice_at).toBeTruthy();
    expect(status(soon)).toMatchObject({ status: "pending" });
    expect(status(soon).expiry_notice_at).toBeTruthy();
    expect(status(fresh).expiry_notice_at).toBeNull();
    const notes = all<{ title: string; body: string; link: string }>(app.db, "select title, body, link from notifications");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("2 条档案改进建议两天内过期");
    expect(notes[0].body).toMatch(/assistant · 设置：快到期/);
    // The overdue one is said to expire two days from now, not on a date already past.
    expect(notes[0].body).toContain(`过期的（${new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10)} 过期）`);
    expect(notes[0].link).toBe("#/agents?tab=agents&role=assistant");

    // Only once.
    expect(await expireProposals(app)).toEqual({ expired: 0, noticed: 0 });
    expect(all(app.db, "select 1 from notifications")).toHaveLength(1);

    // A later review refines the same proposal: its clock and notice start over.
    createProposal(app, { target: "assistant", kind: "settings", title: "快到期", reason: "又看到一次", content: { add_tools: ["scan"] }, runId: null });
    expect(status(soon)).toMatchObject({ status: "pending", expiry_notice_at: null });

    // Two days after its notice, the overdue one expires.
    expect(await expireProposals(app, Date.now() + 2.1 * 86400_000)).toEqual({ expired: 1, noticed: 0 });
    expect(status(old).status).toBe("expired");
    // The rest: announced once past 12 days, expired two days after that.
    expect(await expireProposals(app, Date.now() + 15 * 86400_000)).toEqual({ expired: 0, noticed: 10 });
    expect((await expireProposals(app, Date.now() + 17.1 * 86400_000)).expired).toBe(10);
    expect(one<{ n: number }>(app.db, "select count(*) n from profile_proposals where status = 'pending'")!.n).toBe(0);
  });
});
