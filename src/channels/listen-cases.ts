import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import type { ListenContext } from "./listen.ts";

/**
 * The cases of 「关注」(reply_samples): someone asked something somewhere, the assistant did something
 * (a draft, a direct reply, nothing), the owner decided (sent, edited, dropped with a reason), replied
 * themselves, or corrected it later on the web. Cases are what the handlers, the screening and the
 * coach learn from: the nearest ones go into the prompts, listen-coach files them into scenes.
 */

/** Where listen-coach's lessons of a 关注 live (a work file in its space; the source tree shows 关注/ as folders). */
export function playbookPath(c: Pick<ListenContext, "name" | "id">) {
  const name = c.name.replace(/[\\/:*?"<>|#\s]+/g, " ").trim().slice(0, 40) || c.id;
  return `关注/${name}/经验.md`;
}

export type CaseLite = {
  id: string; context_id: string | null; chat_id: string; chat_name: string; asker_id: string | null; asker_name: string; ask: string;
  draft: string | null; decision: string | null; final: string | null; reason: string | null; owner_reply: string | null;
  verdict: string | null; note: string | null; scene: string | null; checked: string | null; created_at: string;
};

const grams = (s: string) => {
  const t = s.replace(/\s+/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / Math.min(a.size, b.size);
}

/**
 * The cases closest to a new message: of this 关注 (or the default one), the same person and group
 * first, then by how alike the question reads, newer ahead of older. Only cases that teach something:
 * the owner decided, replied themselves, corrected it, or the assistant stayed quiet for a reason.
 */
export function nearCases(app: App, to: { contextId?: string | null; askerId?: string | null; askerName?: string | null; chatId?: string | null; text: string }, limit = 6): CaseLite[] {
  const rows = all<CaseLite>(
    app.db,
    `select id, context_id, chat_id, chat_name, asker_id, asker_name, ask, draft, decision, final, reason, owner_reply, verdict, note, scene, checked, created_at
     from reply_samples where (decision is not null or owner_reply is not null or verdict is not null)
     and ${to.contextId ? "context_id = ?" : "1 = 1"} order by created_at desc limit 400`,
    ...(to.contextId ? [to.contextId] : []),
  );
  const q = grams(to.text);
  const nowMs = Date.now();
  const scored = rows.map((r) => {
    let s = overlap(q, grams(r.ask)) * 3;
    if (to.askerId && r.asker_id === to.askerId) s += 2;
    else if (to.askerName && r.asker_name && r.asker_name === to.askerName) s += 2;
    if (to.chatId && r.chat_id === to.chatId) s += 1;
    if (r.verdict || r.decision === "edited" || r.decision === "dropped" || r.decision === "disliked") s += 0.5;
    s -= Math.min(1, (nowMs - Date.parse(r.created_at)) / (60 * 86400_000));
    return { r, s };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.r);
}

const DECIDED: Record<string, string> = { sent: "本人照发了", edited: "本人改了再发", dropped: "本人没发", auto: "自动发出", disliked: "自动发出后本人不满意", quiet: "助手没回" };
const VERDICT: Record<string, string> = { "should-reply": "本人说该回", "should-not": "本人说不该回", wrong: "本人说回得不对" };

/** Cases as lines for a prompt: who asked what where, what the assistant did, what the owner made of it. */
export function casesText(cases: CaseLite[]) {
  return cases
    .map((c) => {
      const parts = [`${c.asker_name || "有人"}在「${truncate(c.chat_name || c.chat_id, 20)}」${c.scene ? `（${c.scene}）` : ""}：${truncate(c.ask.replace(/\s+/g, " "), 160)}`];
      if (c.checked) parts.push(`助手查了：${truncate(c.checked, 120)}`);
      if (c.draft) parts.push(`助手拟的：${truncate(c.draft.replace(/\s+/g, " "), 160)}`);
      if (c.decision) parts.push(`${DECIDED[c.decision] ?? c.decision}${c.reason ? `（${c.reason}）` : ""}${c.decision === "edited" && c.final ? `：${truncate(c.final.replace(/\s+/g, " "), 160)}` : ""}`);
      if (c.owner_reply) parts.push(`本人自己回了：${truncate(c.owner_reply.replace(/\s+/g, " "), 200)}`);
      if (c.verdict) parts.push(`${VERDICT[c.verdict] ?? c.verdict}${c.note ? `：${truncate(c.note, 120)}` : ""}`);
      return `- [${c.id}] ${parts.join("；")}`;
    })
    .join("\n");
}
