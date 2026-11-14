import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import type { Item } from "../items/store.ts";
import { ownerContextParts } from "./owner-now.ts";

/**
 * Before a heartbeat tick hands its new material to the agent (minutes of work that nearly always
 * end in "nothing to tell"), the decision model is asked whether any of it could bear on what the
 * owner watches or waits for. It sees titles and a short piece of each new source, which of them is
 * where an item came from, the items, what was already sent, and where the owner is right now.
 *
 * A "no" skips the agent for this tick. What was skipped is not lost: it is kept and handed to the
 * agent in the next full sweep (at least every `heartbeat.sweepHours`), so a wrong "no" delays a
 * notice, it does not drop it. Without a decision model, with the gate off, with more new material
 * than the gate can be shown, or when the model fails, the agent runs as before.
 */
export type Fresh = { id: string; space_id: string; uri: string; title: string; kind: string };

/** New sources the gate can be shown; past it nothing is skipped unseen. */
const MAX_FRESH = 30;
const SNIPPET = 160;
const SKIPPED = "heartbeat_skipped";
const SWEEP_AT = "heartbeat_sweep_at";
/** Skipped sources remembered for the next sweep. */
const KEEP = 200;

const kv = (app: App, key: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
const setKv = (app: App, key: string, value: string) => run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", key, value);

/** The sources an item's refs name ("src:<id>#L1-L4" or a bare id). */
const refIds = (refs: string[]) => refs.map((r) => r.replace(/^src:/, "").split("#")[0]);

export function gateMaterial(app: App, watching: Item[], fresh: Fresh[], sent: { title: string }[]): Record<string, string> {
  const snippets = new Map(
    fresh.length
      ? all<{ id: string; snip: string }>(
          app.db,
          // A chat grows at its end; of anything else the start says what it is.
          `select id, case when kind = 'chat' then substr(text, -${SNIPPET}) else substr(text, 1, ${SNIPPET}) end snip from sources where id in (${fresh.map(() => "?").join(",")})`,
          ...fresh.map((s) => s.id),
        ).map((r) => [r.id, r.snip.replace(/\s+/g, " ").trim()])
      : [],
  );
  const from = new Map<string, string[]>();
  for (const i of watching) for (const id of refIds(i.sourceRefs)) from.set(id, [...(from.get(id) ?? []), i.title]);
  // Where an item came from first: a reply there is the likeliest thing to matter.
  const ordered = [...fresh].sort((a, b) => Number(from.has(b.id)) - Number(from.has(a.id)));
  return {
    关注和等待中的事项: watching.map((i) => `- [${i.kind === "waiting" ? "等待" : "关注"}] ${i.title}${i.waitingOn ? `（等 ${i.waitingOn}）` : ""}${i.watch?.query ? `：关注 ${i.watch.query}` : ""}`).join("\n"),
    上次巡检以来的新材料: ordered
      .map((s) => `- ${s.space_id}「${s.title}」(${s.kind})${from.has(s.id) ? `，事项「${from.get(s.id)!.join("」「")}」的来源` : ""}${snippets.get(s.id) ? `：${s.kind === "chat" ? "…" : ""}${snippets.get(s.id)}` : ""}`)
      .join("\n"),
    这段时间已经发给本人的通知: sent.map((n) => `- ${n.title}`).join("\n") || "（无）",
    ...ownerContextParts(app, { now: true, state: true }),
  };
}

const INSTRUCTIONS =
  "这是定期巡检前的预筛。材料里有本人关注或在等的事项，和上次巡检以来新增或变化的材料（标题和一小段内容；聊天给的是最新的一段）。判断这些新材料里有没有值得助手读一遍的：对方回复了本人在等的事、关注的项目有新进展或新阻塞、有人点名本人或给本人派了事、截止时间变了、和某个事项说的是同一件事。有任何一份可能是，就选“要看”。新材料都和这些事项无关（别的群的闲聊、系统通知、无关的文档），或者说的是本人此刻就在场、已经知道的事，选“不用看”。拿不准选“要看”。";

export type Gate = { look: boolean; why: string };

/** Whether the agent should look at this tick's new material; `why` goes on the run. */
export async function heartbeatGate(app: App, watching: Item[], fresh: Fresh[], sent: { title: string }[], signal?: AbortSignal): Promise<Gate> {
  if (app.config.heartbeat.gate === "off") return { look: true, why: "" };
  if (fresh.length > MAX_FRESH) return { look: true, why: `新材料 ${fresh.length} 份，超过预筛能看的 ${MAX_FRESH} 份，直接交给助手` };
  const { decide, decisionReady, describeDecision } = await import("../core/decision.ts");
  if (!decisionReady(app)) return { look: true, why: "" };
  try {
    const r = await decide(app, gateMaterial(app, watching, fresh, sent), { type: "yesno", instructions: INSTRUCTIONS, yes: "要看", no: "不用看" }, { signal });
    if (!r) return { look: true, why: "" };
    const said = describeDecision(r, { yes: "要看", no: "不用看" });
    return r.choice === "yes" ? { look: true, why: `预筛：${said}` } : { look: false, why: `预筛：新材料和关注、等待的事项无关（${said}）` };
  } catch (e) {
    return { look: true, why: `预筛没成（${(e as Error).message.slice(0, 120)}），直接交给助手` };
  }
}

/** Remember what a "no" skipped, for the next sweep. */
export function keepSkipped(app: App, fresh: Fresh[]) {
  const ids = [...new Set([...skippedIds(app), ...fresh.map((s) => s.id)])].slice(-KEEP);
  setKv(app, SKIPPED, JSON.stringify(ids));
  if (!kv(app, SWEEP_AT)) setKv(app, SWEEP_AT, now());
}

function skippedIds(app: App): string[] {
  try {
    const v = JSON.parse(kv(app, SKIPPED) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The skipped sources a sweep is due for: those still there, once `sweepHours` have passed since the
 * last sweep (or since the first skip). Empty when no sweep is due.
 */
export function sweepDue(app: App): Fresh[] {
  const ids = skippedIds(app);
  if (!ids.length) return [];
  const since = Date.parse(kv(app, SWEEP_AT) ?? "");
  if (Number.isFinite(since) && Date.now() - since < app.config.heartbeat.sweepHours * 3600_000) return [];
  return all<Fresh>(app.db, `select id, space_id, uri, title, kind from sources where deleted_at is null and id in (${ids.map(() => "?").join(",")}) order by updated_at desc`, ...ids);
}

/**
 * The agent looked at these skipped sources. Whatever of the list it was not handed (a tick takes
 * only so many) stays, and the sweep stays due: the next tick takes the rest. Sources deleted in
 * the meantime drop out. Only when nothing is left does the clock start again.
 */
export function swept(app: App, handed: Fresh[]) {
  const done = new Set(handed.map((s) => s.id));
  const ids = skippedIds(app).filter((id) => !done.has(id));
  const live = ids.length ? new Set(all<{ id: string }>(app.db, `select id from sources where deleted_at is null and id in (${ids.map(() => "?").join(",")})`, ...ids).map((r) => r.id)) : new Set<string>();
  const left = ids.filter((id) => live.has(id));
  setKv(app, SKIPPED, JSON.stringify(left));
  if (!left.length) setKv(app, SWEEP_AT, now());
}
