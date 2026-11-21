import type { App } from "../core/app.ts";
import { saveConfig } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { now, truncate } from "../core/util.ts";
import { createAsk, registerAskHandler, type Ask } from "./asks.ts";

/**
 * How much say the owner keeps over a tool, in three rungs:
 *
 * - `ask`: every call waits for the owner's OK (`approvals.tools`);
 * - `report`: the call runs, and the owner is told what was done afterwards (`approvals.report`);
 * - `free`: neither.
 *
 * A tool moves up only on the owner's word. What the host does is notice: after the owner has
 * approved a tool's calls `approvals.promoteAfter` times in a row without refusing one, it asks once
 * whether calls like these may run and be reported instead. A refusal starts the count again; the
 * question is not repeated within a month. Tools that always wait (a plugin's clicks and keystrokes
 * on a machine) are never offered, and the owner can move any tool back in settings.
 */
export type Rung = "ask" | "report" | "free";

export function rungOf(app: App, tool: string): Rung {
  const a = app.config.approvals;
  return a.tools.includes(tool) ? "ask" : (a.report ?? []).includes(tool) ? "report" : "free";
}

export function setRung(app: App, tool: string, rung: Rung) {
  const a = app.config.approvals;
  a.tools = a.tools.filter((t) => t !== tool);
  a.report = (a.report ?? []).filter((t) => t !== tool);
  if (rung === "ask") a.tools.push(tool);
  if (rung === "report") a.report.push(tool);
  saveConfig(app.config, app.home);
}

/** How long a streak may reach back, and how long after asking the owner is left alone about a tool. */
const STREAK_DAYS = 60;
const ASK_AGAIN_DAYS = 30;
const askedKey = (tool: string) => `approval_promote:${tool}`;
const resetKey = (tool: string) => `approval_streak_reset:${tool}`;

/** Disliking a completed call starts a new streak without changing past approval records. */
export function resetApprovalStreak(app: App, tool: string) {
  run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", resetKey(tool), now());
}

/** The owner's latest answers to this tool's approval requests, newest first: how many approvals before the first refusal. */
export function approvalStreak(app: App, tool: string, userId = OWNER): number {
  const window = new Date(Date.now() - STREAK_DAYS * 86400_000).toISOString();
  const reset = userId === OWNER ? one<{ value: string }>(app.db, "select value from kv where key = ?", resetKey(tool))?.value : undefined;
  const since = reset && reset > window ? reset : window;
  const rows = all<{ approved: number | null }>(
    app.db,
    "select approved from asks where kind = 'approval' and tool = ? and user_id = ? and status = 'answered' and json_extract(context, '$.operationApproval') is null and answered_at > ? order by answered_at desc limit 200",
    tool, userId, since,
  );
  let n = 0;
  for (const r of rows) {
    if (!r.approved) break;
    n++;
  }
  return n;
}

/**
 * After an approval: when the streak has reached `promoteAfter`, ask the owner once whether this
 * tool may run and be reported from now on. `eligible` says whether the tool may leave the first
 * rung at all (not the always-approve ones). Returns the question, or null.
 */
export function suggestPromotion(app: App, ask: Pick<Ask, "tool" | "userId">, eligible: (tool: string) => boolean): Ask | null {
  const tool = ask.tool;
  const after = app.config.approvals.promoteAfter ?? 10;
  if (!tool || !after || ask.userId !== OWNER || rungOf(app, tool) !== "ask" || !eligible(tool)) return null;
  if (approvalStreak(app, tool) < after) return null;
  const last = Date.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", askedKey(tool))?.value ?? "");
  if (Number.isFinite(last) && Date.now() - last < ASK_AGAIN_DAYS * 86400_000) return null;
  run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", askedKey(tool), now());
  return createAsk(app, {
    runId: null,
    conversationId: null,
    question: `「${tool}」最近 ${after} 次你都批准了。以后这类调用直接做、做完告诉你，还是继续每次问你？`,
    options: [{ label: "直接做，做完告诉我" }, { label: "继续每次问我" }],
    allowText: false,
    context: { handler: "approval-promote", tool },
  });
}

registerAskHandler("approval-promote", async (app, ask, context) => {
  const tool = typeof context.tool === "string" ? context.tool : "";
  if (!tool || ask.choice !== 0 || rungOf(app, tool) !== "ask") return;
  setRung(app, tool, "report");
  run(app.db, "update asks set result = ? where id = ?", `以后 ${tool} 直接做，做完告诉你；要改回在 设置 → 安全 → 工具审批`, ask.id);
});

/** A call on the `report` rung has run: tell the owner what was done (with the others that can wait, not as a ping of its own). */
export function reportDone(app: App, by: { who: string; userId?: string | null; runId?: string | null }, tool: string, args: Record<string, unknown>, result: { text: string; isError: boolean }) {
  try {
    notify(app, {
      userId: by.userId ?? OWNER,
      runId: by.runId ?? null,
      reportTool: tool,
      title: `${by.who} ${result.isError ? "调用失败" : "已调用"} ${tool}`,
      body: [truncate(JSON.stringify(args, null, 1), 800), `结果：${truncate(result.text.replace(/\s+/g, " "), 300)}`, "这个工具现在是“直接做，做完告诉你”；要改回每次先问，在 设置 → 安全 → 工具审批。"].join("\n\n"),
      link: "#/settings?tab=security",
      urgency: "later",
    });
  } catch (e) {
    console.warn(`[omem] ${tool} 做完后的告知没有发出：${(e as Error).message}`);
  }
}
