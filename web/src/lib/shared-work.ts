import type { ChangeLite, Child, EndedLine, FlowLite, Line, NextLite } from "./work";

/**
 * The owner's work lines as someone else with 看工作线 gets them (src/items/work-http.ts `sharedLines`):
 * each line with its items, flow stages, open next steps and key changes, without the owner's own
 * parts (现在, people, groups, what waits for the owner). These turn that into the shapes the work page
 * and a line's page already draw, with the missing parts empty.
 */
export type SharedNode = {
  id: string; parentId: string | null; title: string; kind: string; status: string; spaceId: string; phase: string | null;
  /** Only the closing summary of an ended line (`now.summary`); the current state text is not shared. */
  now: { summary: string } | null;
  children: SharedNode[];
  stages: { id: string; name: string; state: string }[];
  next: { itemId: string; id: string; text: string; why: string; status: string }[];
  timeline?: { itemId: string; id: string; at: string; type: string; summary: string }[];
};
/** GET /api/work for a member: lines and the ended ones, nothing waiting. */
export type SharedOverview = { lines: SharedNode[]; ended: EndedLine[]; endedMore: boolean };

const CLOSED = ["done", "cancelled", "expired"];

function flowOf(n: SharedNode): FlowLite | null {
  if (!n.stages?.length) return null;
  const stages = n.stages.map((s, i) => ({ id: `${n.id}:${i}`, name: s.name, state: s.state, enteredAt: null, doneAt: null, waitingOn: null }));
  const cur = stages.find((s) => !["done", "skipped", "pending"].includes(s.state)) ?? stages.find((s) => s.state === "pending") ?? null;
  return { name: "", stages, current: cur ? { id: cur.id, name: cur.name, state: cur.state } : null };
}
function childOf(n: SharedNode): Child {
  return { id: n.id, title: n.title, kind: n.kind, status: n.status, dueAt: null, parentId: n.parentId, waitingOn: null, flow: flowOf(n), children: (n.children ?? []).map(childOf) };
}
function titles(n: SharedNode, out = new Map<string, string>()) {
  out.set(n.id, n.title);
  for (const c of n.children ?? []) titles(c, out);
  return out;
}
export function sharedNext(n: SharedNode): NextLite[] {
  return (n.next ?? []).map((x) => ({
    id: x.id, itemId: x.itemId, text: x.text, why: x.why, refs: [], kind: undefined as unknown as NextLite["kind"],
    status: x.status as NextLite["status"], runId: null, createdAt: "", updatedAt: "", decidedAt: null,
  }));
}
export function sharedTimeline(n: SharedNode): ChangeLite[] {
  const names = titles(n);
  return (n.timeline ?? []).map((c) => ({
    id: c.id, at: c.at, type: c.type, summary: c.summary, detail: null, risk: null, next: null, refs: [], status: "noted", origin: "", noise: false,
    itemId: c.itemId, itemTitle: names.get(c.itemId) ?? "", lineId: n.id, lineTitle: n.title,
  }));
}
export function sharedChildren(n: SharedNode): Child[] {
  return (n.children ?? []).map(childOf);
}
export { flowOf as sharedFlow };

/** One shared line as a card on the work page. */
export function sharedLine(n: SharedNode): Line {
  const timeline = sharedTimeline(n);
  const today = new Date().toDateString();
  return {
    id: n.id, title: n.title, kind: n.kind, status: n.status, dueAt: null, spaceId: n.spaceId, now: null,
    counts: { changes: timeline.length, today: timeline.filter((c) => new Date(c.at).toDateString() === today).length, lastAt: timeline[0]?.at ?? null },
    // The card shows the last six, oldest first, like the owner's (src/items/work-http.ts); the server sends newest first.
    timeline: timeline.slice(0, 6).reverse(), next: sharedNext(n), children: sharedChildren(n), listen: null,
    phase: n.phase === "watching" ? "watching" : null, phaseSince: null, watchUntil: null,
  };
}
export const sharedClosed = (n: SharedNode) => CLOSED.includes(n.status);
