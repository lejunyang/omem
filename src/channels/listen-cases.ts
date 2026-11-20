import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { truncate } from "../core/util.ts";
import type { ListenContext } from "./listen.ts";

/**
 * The cases of 「关注」(reply_samples): someone asked something somewhere, the assistant did something
 * (a draft, a direct reply, nothing), the owner decided (sent, edited, dropped with a reason), replied
 * themselves, or corrected it later on the web. Cases are what the handlers, the screening and the
 * coach learn from: the nearest ones go into the prompts, listen-coach files them into scenes.
 */

/** Where listen-coach's lessons of a 关注 live (a work file in its space; the source tree shows 关注/ as folders). */
export function playbookPath(c: Pick<ListenContext, "name" | "id"> & { playbookFile?: string }) {
  if (c.playbookFile) return c.playbookFile;
  const name = c.name.replace(/[\\/:*?"<>|#\s]+/g, " ").trim().slice(0, 40) || c.id;
  return `关注/${name}/经验.md`;
}

/**
 * Where the lessons the owner showed by doing go (a demonstration organized by skill-from-demo,
 * remote/demos.ts): next to the 关注's 经验.md, one file per demonstration. listen-coach does not
 * rewrite them; the handlers read them with the lessons.
 */
export function demoLessonsDir(c: Pick<ListenContext, "name" | "id"> & { playbookFile?: string }) {
  const path = playbookPath(c);
  return `${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path}/演示`;
}

/** The demonstrated lessons of a 关注 (newest first), as text; empty when there are none. */
export function demoLessonsOf(app: App, c: Pick<ListenContext, "name" | "id"> & { playbookFile?: string }, max = 3000) {
  const prefix = `work/${demoLessonsDir(c)}/`;
  // A range on uri, not LIKE: a 关注's name may hold `_` or `%`.
  const rows = all<{ title: string; text: string }>(app.db, "select title, text from sources where uri >= ? and uri < ? and kind = 'work' and deleted_at is null order by updated_at desc limit 10", prefix, `${prefix}￿`);
  return rows.length ? truncate(rows.map((r) => `### ${r.title}\n\n${r.text.trim()}`).join("\n\n"), max) : "";
}

/**
 * The lessons listen-coach wrote for a 关注 (its work file), as text, followed by what the owner
 * demonstrated (`demos: false` leaves those out); empty when there are none yet.
 */
export function playbookOf(app: App, c: Pick<ListenContext, "name" | "id"> & { playbookFile?: string }, max = 4000, opts: { demos?: boolean } = {}) {
  const row = one<{ text: string }>(app.db, "select text from sources where uri = ? and deleted_at is null order by captured_at desc limit 1", `work/${playbookPath(c)}`);
  const own = row ? row.text.trim() : "";
  const shown = opts.demos === false ? "" : demoLessonsOf(app, c, Math.max(1000, Math.floor(max / 2)));
  const text = [own, shown ? `## 本人演示过的做法\n\n${shown}` : ""].filter(Boolean).join("\n\n");
  return text ? truncate(text, max) : "";
}

/**
 * Cases about messages, not about going into a meeting (chat_kind 'meeting', listen-meetings.ts) or keeping an
 * item the assistant made (chat_kind 'item', items/auto-cases.ts): what
 * a reply, a draft streak or the owner's reply habits are read from. The coach reads both.
 */
export const NOT_MEETING = "chat_kind not in ('meeting', 'item')";

export type CaseLite = {
  id: string; context_id: string | null; chat_id: string; chat_kind: string; chat_name: string; settled_at: string | null; asker_id: string | null; asker_name: string; ask: string;
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
    `select id, context_id, chat_id, chat_kind, chat_name, settled_at, asker_id, asker_name, ask, draft, decision, final, reason, owner_reply, verdict, note, scene, checked, created_at
     from reply_samples where (decision is not null or owner_reply is not null or verdict is not null or settled_at is not null)
     and ${NOT_MEETING} and ${to.contextId ? "context_id = ?" : "1 = 1"} order by created_at desc limit 400`,
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
    // A silence the owner let stand teaches less than a decision or their own reply.
    if (!r.decision && !r.owner_reply && !r.verdict) s -= 0.5;
    s -= Math.min(1, (nowMs - Date.parse(r.created_at)) / (60 * 86400_000));
    return { r, s };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.r);
}

const REASONS: Record<string, string> = { "no-need": "不用回", verbose: "太啰嗦", "no-conclusion": "没有结论", self: "本人自己回", "not-ours": "不该回", "owner-decides": "该本人来定", wrong: "结论不对或没依据", useless: "没帮上忙" };
const DECIDED: Record<string, string> = { sent: "本人照发了", edited: "本人改了再发", dropped: "本人没发", auto: "自动发出", disliked: "自动发出后本人不满意", quiet: "助手没回" };
const VERDICT: Record<string, string> = { "should-reply": "本人说该回", "should-not": "本人说不该回", wrong: "本人说回得不对" };

/** Cases as lines for a prompt: who asked what where, what the assistant did, what the owner made of it. */
export function casesText(cases: CaseLite[]) {
  return cases
    .map((c) => {
      if (c.chat_kind === "meeting") return `- [${c.id}] ${meetingCaseText(c)}`;
      const parts = [`${c.asker_name || "有人"}${c.chat_kind === "p2p" ? "私聊" : `在「${truncate(c.chat_name || c.chat_id, 20)}」`}${c.scene ? `（${c.scene}）` : ""}：${truncate(c.ask.replace(/\s+/g, " "), 160)}`];
      if (c.checked) parts.push(`助手查了：${truncate(c.checked, 120)}`);
      if (c.draft) parts.push(`助手拟的：${truncate(c.draft.replace(/\s+/g, " "), 160)}`);
      if (c.decision) parts.push(`${DECIDED[c.decision] ?? c.decision}${c.reason ? `（${REASONS[c.reason] ?? c.reason}）` : ""}${c.decision === "edited" && c.final ? `：${truncate(c.final.replace(/\s+/g, " "), 160)}` : ""}`);
      if (c.owner_reply) parts.push(`本人自己回了：${truncate(c.owner_reply.replace(/\s+/g, " "), 200)}`);
      if (c.verdict) parts.push(`${VERDICT[c.verdict] ?? c.verdict}${c.note ? `：${truncate(c.note, 120)}` : ""}`);
      if (!c.decision && !c.owner_reply && !c.verdict && c.settled_at) parts.push("本人没回");
      return `- [${c.id}] ${parts.join("；")}`;
    })
    .join("\n");
}

/** A meeting the 关注 asked about (listen-meetings.ts): which one, and whether the assistant went in. */
function meetingCaseText(c: CaseLite) {
  const did =
    c.decision === "sent" ? "本人让助手进会旁听"
    : c.decision === "auto" ? "助手直接进会旁听（关注设的是直接旁听）"
    : c.decision === "dropped" ? (c.reason === "never" ? "本人说这个会以后不用问" : "本人说这次不用旁听")
    : "本人没答";
  return `${c.ask}${c.asker_name ? `（${c.asker_name} 发起）` : ""}${c.scene ? `（${c.scene}）` : ""}：${did}${c.verdict ? `；${VERDICT[c.verdict] ?? c.verdict}${c.note ? `：${truncate(c.note, 120)}` : ""}` : ""}`;
}
