import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";

/**
 * What a person kept, dropped, put off or merged among the proposals put to them (docs/v2/architecture.md
 * “变化台账”), one record whatever the place they answered in: the web, a Feishu card, 今天, the work
 * page's 等你处理. Each domain asks before it proposes (mayPropose): what they said no to is not put to
 * them again until it changed. One row per person, kind and object (`owner_choices`); the latest answer wins.
 *
 * Kinds and what “changed” means for each (CHANGED, the one place it is said):
 */
export const CHOICE_KINDS = {
  situation: "要不要跟这一类事（按情境名）",
  line: "要不要建成工作线（按名字）",
  "line-end": "这条线要不要结束",
  "item-candidate": "助手自己建的候选事项要不要（按标题）",
  metric: "提议的指标要不要（按名字）",
  "meeting-item": "一场会的结果要不要记到某件事项",
  profile: "复盘提的档案改动要不要（按档案和标题）",
  probe: "助手提议的预查要不要（按名字）",
} as const;
export type ChoiceKind = keyof typeof CHOICE_KINDS;
export type Choice = "keep" | "drop" | "later" | "merged";
const DAY = 86_400_000;
/**
 * When a choice stops holding. `days`: a 不用 / 还没完 holds this long (none: until the object changes);
 * `versioned`: a new version of the object (its content fingerprint) may be proposed again.
 */
export const CHANGED: Record<ChoiceKind, { days: number | null; versioned: boolean; why: string }> = {
  situation: { days: null, versioned: false, why: "说过不用的同名情境不再提" },
  line: { days: 14, versioned: false, why: "说过不用建的名字两周内不再问" },
  "line-end": { days: 14, versioned: false, why: "说过还没完的线两周内不再问要不要结束" },
  "item-candidate": { days: 14, versioned: false, why: "说过不要的同名候选两周内不再建" },
  metric: { days: null, versioned: true, why: "说过不要的指标不再提，换了查法才可以再提" },
  "meeting-item": { days: null, versioned: false, why: "说过不用记的，这场会的结果不再问要不要记到这件事" },
  profile: { days: 30, versioned: true, why: "说过不要的档案改动一个月内不再提，内容改了才可以再提" },
  probe: { days: null, versioned: false, why: "说过不要的同名预查不再提" },
};
/** “以后再说” waits this long by default. */
export const LATER_DAYS = 7;

export type ChoiceRow = { user_id: string; kind: string; target: string; version: string | null; choice: Choice; into_ref: string | null; reason: string | null; until: string | null; via: string | null; at: string };

/** A stable key for an object named in words: spaces, quotes and case do not matter. */
/** A short fingerprint of a longer content (a proposal's body), for “the object changed”. */
export function contentVersion(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
export const fingerprint = (s: string) => s.replace(/[\s「」“”"'·・\-—_/]+/g, "").toLowerCase().slice(0, 120);

/** Record a choice (the latest wins). `until`: when a 以后再说 or a 还没完 runs out (defaults from CHANGED / LATER_DAYS). */
export function recordChoice(app: App, c: { userId: string; kind: ChoiceKind; target: string; choice: Choice; version?: string | null; into?: string | null; reason?: string | null; until?: string | null; via?: string | null }) {
  if (!c.target) return;
  const at = now();
  const rule = CHANGED[c.kind];
  const until = c.until ?? (c.choice === "later" ? new Date(Date.now() + LATER_DAYS * DAY).toISOString() : (c.choice === "drop" || (c.kind === "line-end" && c.choice === "keep")) && rule.days ? new Date(Date.now() + rule.days * DAY).toISOString() : null);
  run(app.db, `insert into owner_choices(user_id,kind,target,version,choice,into_ref,reason,until,via,at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?)
    on conflict(user_id,kind,target) do update set version=excluded.version, choice=excluded.choice, into_ref=excluded.into_ref, reason=excluded.reason,
      until=excluded.until, via=excluded.via, at=excluded.at, updated_at=excluded.updated_at`,
    c.userId, c.kind, truncate(c.target, 200), c.version ?? null, c.choice, c.into ?? null, c.reason ? truncate(c.reason, 300) : null, until, c.via ?? null, at, at);
}

export function choiceOn(app: App, userId: string, kind: ChoiceKind, target: string): ChoiceRow | null {
  return one<ChoiceRow>(app.db, "select * from owner_choices where user_id = ? and kind = ? and target = ?", userId, kind, target) ?? null;
}

/**
 * Whether a proposal may be put to the person now. Not when they said 不用 (or, for a line's end, 还没完)
 * and it still holds: its time has not run out and the object did not change (CHANGED). A 以后再说 holds
 * until its date. A choice to keep or merge does not stop anything (the domain knows it is done).
 */
export function mayPropose(app: App, userId: string, kind: ChoiceKind, target: string, version?: string | null): { ok: true } | { ok: false; why: string; at: string } {
  const c = choiceOn(app, userId, kind, target);
  if (!c) return { ok: true };
  const holds = c.choice === "drop" || c.choice === "later" || (kind === "line-end" && c.choice === "keep");
  if (!holds) return { ok: true };
  if (c.until && c.until <= now()) return { ok: true };
  if (CHANGED[kind].versioned && version && c.version && version !== c.version) return { ok: true };
  return { ok: false, why: c.choice === "later" ? `本人 ${c.at.slice(0, 10)} 说以后再说（到 ${c.until?.slice(0, 10)}）` : `本人 ${c.at.slice(0, 10)} 说过${c.choice === "keep" ? "还没完" : "不用"}${c.reason ? `：${c.reason}` : ""}`, at: c.at };
}

/** The person's latest choices, newest first; `targets` limits them to these objects (a line and its items). */
export function recentChoices(app: App, userId: string, opts: { targets?: string[]; limit?: number } = {}): ChoiceRow[] {
  const t = opts.targets?.filter(Boolean).slice(0, 200);
  return all<ChoiceRow>(app.db, `select * from owner_choices where user_id = ? ${t ? `and target in (${t.map(() => "?").join(",") || "''"})` : ""} order by at desc limit ?`, userId, ...(t ?? []), opts.limit ?? 20);
}
const WORD: Record<Choice, string> = { keep: "要", drop: "不要", later: "以后再说", merged: "并进别的" };
/** A choice as a short line for an agent: “11-20 线要不要结束：还没完（本人说……）”. */
export function choiceLine(c: ChoiceRow) {
  const kind = CHANGED[c.kind as ChoiceKind] ? CHOICE_KINDS[c.kind as ChoiceKind] : c.kind;
  const word = c.kind === "line-end" && c.choice === "keep" ? "还没完" : WORD[c.choice];
  return `${c.at.slice(5, 10)} ${kind}：${word}${c.reason ? `（${truncate(c.reason, 60)}）` : ""}`;
}

// ------------------------------------------------------------------ from the answer of an ask

/** A choice an ask carries in its context: one object, how its options map to choices (by label; unmapped ones are no choice). */
export type ChoiceDescriptor = { kind: ChoiceKind; target: string; version?: string | null; map?: Record<string, Choice> };
type Reader = (app: App, ask: { value: Record<string, unknown> | null; choice: number | null; options: { label: string }[]; answer: string | null }, ctx: Record<string, unknown>) => (ChoiceDescriptor & { choice: Choice; reason?: string })[];
const readers = new Map<string, Reader>();
/** For an ask that answers several objects at once (a form): which choices its answer made. */
export function registerChoiceReader(handler: string, read: Reader) {
  readers.set(handler, read);
}
const NO = /^(不用|不要|不改|这次不用|就这样|让它过期)/;
const LATER = /^(以后再说|稍后|再看|晚点)/;
/** An option's label as a choice, when the descriptor gives no map: 不用 / 不要 are drop, 以后再说 later, the first option keep. */
export function labelChoice(label: string, index: number): Choice | null {
  if (NO.test(label)) return "drop";
  if (LATER.test(label)) return "later";
  return index === 0 ? "keep" : null;
}

/**
 * The common answer path (agents/asks.ts recordAnswer): whatever the person answered in, its choices are
 * recorded here — the ask's own descriptor (`context.choice`) and any reader registered for its handler.
 */
export function noteChoices(app: App, ask: { userId: string; answeredBy: string | null; handler: string | null; value: Record<string, unknown> | null; choice: number | null; options: { label: string }[]; answer: string | null; id: string }, ctx: Record<string, unknown>) {
  const userId = ask.answeredBy ?? ask.userId;
  const out: (ChoiceDescriptor & { choice: Choice; reason?: string })[] = [];
  const d = ctx.choice as ChoiceDescriptor | undefined;
  if (d?.kind && d.target && ask.choice !== null) {
    const label = ask.options[ask.choice]?.label ?? "";
    // With a map only the options it names are choices (the others act, like 结束 on a line).
    const choice = d.map ? d.map[label] ?? null : labelChoice(label, ask.choice);
    if (choice) out.push({ ...d, choice });
  }
  const read = ask.handler ? readers.get(ask.handler) : undefined;
  if (read) out.push(...read(app, ask, ctx));
  for (const c of out) recordChoice(app, { userId, kind: c.kind, target: c.target, version: c.version ?? null, choice: c.choice, reason: c.reason ?? null, via: `ask:${ask.id}` });
  return out.length;
}

// The readers for the forms that answer several proposals at once.
const pick = (v: Record<string, unknown> | null, id: string) => (typeof v?.[id] === "string" ? (v[id] as string) : "");
const proposalChoice = (label: string): Choice | null => (label === "建" ? "keep" : label === "不用" ? "drop" : label.startsWith("并进") ? "merged" : null);
// The nightly card of proposed lines (items/lines.ts linesCard).
registerChoiceReader("line-propose", (_app, ask, ctx) => ((ctx.proposals as { key: string; name: string }[] | undefined) ?? []).flatMap((p) => {
  const choice = proposalChoice(pick(ask.value, p.key));
  return choice ? [{ kind: "line" as const, target: fingerprint(p.name), choice }] : [];
}));
// 今天 (items/today.ts): its proposed lines and candidates; its line-end fields answer their own asks, recorded there.
registerChoiceReader("today", (app, ask, ctx) => {
  const props = (ctx.proposals as { list?: { key: string; name: string }[] } | undefined)?.list ?? [];
  const lines = props.flatMap((p) => { const choice = proposalChoice(pick(ask.value, `p_${p.key}`)); return choice ? [{ kind: "line" as const, target: fingerprint(p.name), choice }] : []; });
  const cands = ((ctx.candidates as string[] | undefined) ?? []).flatMap((id) => {
    const p = pick(ask.value, `c_${id}`);
    const title = one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title;
    return p && title ? [{ kind: "item-candidate" as const, target: fingerprint(title), choice: (p === "不要" ? "drop" : "keep") as Choice }] : [];
  });
  return [...lines, ...cands];
});

/** For a run's look at a line (turn-focus.ts): the person's latest choices on it and its items, a few short lines. */
export function lineChoices(app: App, userId: string, lineId: string, itemIds: string[], titles: string[], limit = 4): string[] {
  const targets = [lineId, ...itemIds, ...titles.map(fingerprint)];
  return recentChoices(app, userId, { targets, limit }).map(choiceLine);
}
