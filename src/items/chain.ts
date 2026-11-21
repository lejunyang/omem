import { can, runAudience } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { listCodeWorks, type CodeWork } from "../agents/code-works.ts";
import { listDesigns, findDesign } from "../designs/store.ts";
import { STATUS_LABELS as DESIGN_STATUS, ORIGIN_LABELS } from "../designs/types.ts";
import { objectView } from "../flows/plugin-objects.ts";
import { fixVerified } from "../studies/fix.ts";
import { findings as studyFindings } from "../studies/store.ts";
import { requireItem } from "./access.ts";
import { findReq, reqStatuses } from "./requirements.ts";
import { testState, testsOf, testsOfWork } from "./req-tests.ts";
import { visibleBranchIds } from "./member-work.ts";

/**
 * 需求 → 发现 → 方案 → 交付 on one work item (docs/v2/next.md 分期三): a read-only projection of what is
 * linked already, so the owner sees in one place how far a thing has come instead of choosing between the
 * item page, the requirement tree and a study's ledger. Only links that are stored count — nothing is
 * matched by its words:
 *
 * - 需求: the item's `req` materials (items/materials.ts), with their latest review state (req_status) and
 *   the tests reported under them (req_tests).
 * - 发现: the study's findings on the item (studies/store.ts). No finding names a requirement node, so a
 *   finding links on only to the work it started (`study_findings.work_id`).
 * - 方案: the item's designs and those of its works (designs.item_id / work_id); a decision's `reqs` that
 *   name one of the item's nodes link back to it.
 * - 交付: the coding works done for it (its `run` materials, plus the works a finding or design names),
 *   as the run page's “编码” describes them (agents/code-works.ts), with their tests (req_tests.work_id)
 *   and a finding's reruns (studies/fix.ts); the nodes a work's rounds reported on (req_status.run_id) and
 *   its tests' nodes link back. The item's platform objects (a merge request) come last, unlinked: none
 *   records which work it belongs to.
 *
 * A line (an item with items under it) is its children's chains, grouped by child, each entry once.
 * Readable by whoever may read the item; another space's requirement, design or work is left out.
 */

export type ChainKind = "req" | "finding" | "design" | "work" | "object";
export type ChainEntry = {
  /** `<kind>:<its id>`. */
  key: string;
  kind: ChainKind;
  title: string;
  /** Its own status word, as its page says it. */
  status: string;
  cls: "" | "ok" | "warn" | "danger" | "accent";
  /** One line: where it stands. */
  now: string;
  /** Its page (`#/…`) or, for a platform object, its address there. */
  href: string;
  /** Keys of the entries in earlier segments it is linked to. */
  links: string[];
  /** A work's: who it waits on (agents/code-works.ts WorkGroup) and whether a review of it is running. */
  waits?: string;
  reviewing?: boolean;
};
export type ChainSegments = { reqs: ChainEntry[]; findings: ChainEntry[]; designs: ChainEntry[]; works: ChainEntry[] };
export type ChainGroup = ChainSegments & { item: { id: string; title: string }; more: number };
export type ItemChain = {
  itemId: string;
  line: boolean;
  groups: ChainGroup[];
  counts: { reqs: number; findings: number; designs: number; works: number; reviewing: number; waiting: number };
  /** Children with a chain that did not fit (CHAIN_MAX.groups). */
  moreGroups: number;
};

/** At most this many entries per segment of a group, groups of a line, and children of a line looked at. */
export const CHAIN_MAX = { segment: 12, groups: 12, children: 60 } as const;

const REQ_STATE: Record<string, [string, ChainEntry["cls"]]> = { done: ["已实现", "ok"], partial: ["部分实现", "warn"], missing: ["没实现", "danger"], extra: ["需求外", ""] };
const FINDING_STATE: Record<string, [string, ChainEntry["cls"]]> = { new: ["等你看", "warn"], confirmed: ["认可", "accent"], rejected: ["不算", ""], later: ["以后再说", ""] };
const FINDING_KIND: Record<string, string> = { defect: "缺陷", gap: "缺口", idea: "想法" };
const DESIGN_CLS: Record<string, ChainEntry["cls"]> = { drafting: "accent", review: "warn", approved: "ok", assessed: "ok", recorded: "" };
const VERIFIED: Record<string, string> = { passed: "改后重跑通过", failed: "改后重跑仍然没通过", blocked: "改后没能重跑", unclear: "改后重跑说不清" };
const TEST_WORD = (t: NonNullable<ReturnType<typeof testState>>) => [`测试`, t.passed ? `通过 ${t.passed}` : "", t.failed ? `失败 ${t.failed}` : "", t.skipped ? `跳过 ${t.skipped}` : ""].filter(Boolean).join(" ");

type Ctx = { app: App; userId: string; spaces: string[] | null; owner: boolean };
const inSpace = (c: Ctx, space: string | null | undefined) => !c.spaces || !space || c.spaces.includes(space);

/** The requirement nodes under each of `roots` (each with itself), active only. */
function subtrees(app: App, roots: string[]) {
  const under = new Map<string, string>();
  if (!roots.length) return under;
  const rows = all<{ root: string; id: string }>(app.db, `with recursive sub(root, id) as (select value, value from json_each(?)
    union select sub.root, n.id from req_nodes n join sub on n.parent_id = sub.id where n.status = 'active') select root, id from sub limit 2000`, JSON.stringify(roots));
  for (const r of rows) if (!under.has(r.id)) under.set(r.id, r.root);
  return under;
}

/** One item's own chain, without what `seen` holds already (a line's earlier children). */
function chainOf(c: Ctx, itemId: string, seen: Set<string>): ChainSegments & { more: number } {
  const { app } = c;
  let more = 0;
  const take = (list: ChainEntry[]) => {
    const fresh = list.filter((e) => !seen.has(e.key));
    more += Math.max(0, fresh.length - CHAIN_MAX.segment);
    const kept = fresh.slice(0, CHAIN_MAX.segment);
    for (const e of kept) seen.add(e.key);
    return kept;
  };

  // 需求
  const nodes = all<{ ref: string }>(app.db, "select ref from item_materials where item_id = ? and kind = 'req' order by id", itemId)
    .map((m) => findReq(app, m.ref))
    .filter((n): n is NonNullable<typeof n> => !!n && n.status === "active" && inSpace(c, n.spaceId) && can(app, c.userId, "requirements.view", n.spaceId));
  const reqIds = nodes.map((n) => n.id);
  const under = subtrees(app, reqIds);
  const states = reqStatuses(app, [...under.keys()]);
  const tests = testsOf(app, [...under.keys()], 20);
  const reqs: ChainEntry[] = nodes.map((n) => {
    const own = states.get(n.id);
    const parts = [...under].filter(([, root]) => root === n.id).map(([id]) => id).filter((id) => id !== n.id);
    const feat = parts.map((id) => states.get(id)).filter(Boolean);
    const t = testState([...under].filter(([, root]) => root === n.id).flatMap(([id]) => tests.get(id) ?? []));
    const [status, cls]: [string, ChainEntry["cls"]] = own ? REQ_STATE[own.status] ?? [own.status, ""] : n.confirmed ? ["已确认", ""] : ["待确认", "accent"];
    const now = [parts.length ? `下面 ${parts.length} 个点${feat.length ? `，${feat.filter((s) => s!.status === "done").length} 个已实现` : ""}` : "", t ? TEST_WORD(t) : ""].filter(Boolean).join(" · ");
    return { key: `req:${n.id}`, kind: "req", title: n.title, status, cls, now: now || (own?.note ? own.note : "还没有评审结论"), href: `#/reqs/${encodeURIComponent(n.id)}`, links: [] };
  });

  // 发现
  const fs = studyFindings(app, itemId).filter((f) => f.state !== "duplicate");
  const findingHref = c.owner ? `#/work/${encodeURIComponent(itemId)}?tab=flow` : `#/items/${encodeURIComponent(itemId)}/flow`;

  // 交付: the works done for the item, and those a finding or a design started.
  const designs = listDesigns(app, { item: itemId, spaces: c.spaces, limit: 50 });
  const linked = all<{ id: string }>(app.db, `select distinct coalesce(json_extract(r.input, '$.continueFrom'), r.id) id from item_materials m join runs r on r.id = m.ref
    where m.item_id = ? and m.kind = 'run' and r.kind = 'code' limit 100`, itemId).map((r) => r.id);
  const roots = [...new Set([...linked, ...fs.map((f) => f.work_id), ...designs.map((d) => d.workId)].filter((x): x is string => !!x))];
  const works: CodeWork[] = roots.length ? listCodeWorks(app, { roots, ended: true, visibleTo: runAudience(app, c.userId, "code.work.view") }) : [];
  const workKeys = new Set(works.map((w) => `work:${w.rootId}`));
  // A work's designs that are not the item's own (a design written for the delegation).
  for (const w of works) for (const d of listDesigns(app, { work: w.rootId, spaces: c.spaces, limit: 5 })) if (!designs.some((x) => x.id === d.id)) designs.push(d);

  const findings: ChainEntry[] = fs.map((f) => {
    const [status, cls] = FINDING_STATE[f.state] ?? [f.state, ""];
    const v = f.work_id ? fixVerified(app, f).verified : null;
    return {
      key: `finding:${f.id}`, kind: "finding", title: f.title, status, cls,
      now: [FINDING_KIND[f.kind] ?? f.kind, f.round ? `第 ${f.round} 轮` : "", f.work_id && workKeys.has(`work:${f.work_id}`) ? (v ? VERIFIED[v] : "已发起修改") : ""].filter(Boolean).join(" · "),
      href: findingHref, links: [],
    };
  });

  const designEntries: ChainEntry[] = designs.filter((d) => d.origin !== "derived" || d.revision > 0).map((d) => {
    const body = findDesign(app, d.id)?.body;
    const named = new Set((body?.decisions ?? []).flatMap((x) => x.reqs ?? []).map((r) => r.replace(/^req:/, "")));
    const asked = d.counts.questions;
    return {
      key: `design:${d.id}`, kind: "design", title: d.title, status: DESIGN_STATUS[d.status] ?? d.status, cls: DESIGN_CLS[d.status] ?? "",
      now: [ORIGIN_LABELS[d.origin], `${d.counts.decisions} 个决定`, asked ? `${asked} 个要问` : ""].filter(Boolean).join(" · "),
      href: `#/design/${encodeURIComponent(d.id)}`, links: reqIds.filter((id) => named.has(id)).map((id) => `req:${id}`),
    };
  });

  // Which work each round belongs to, for the review states and tests reported on the item's nodes.
  const roundOf = new Map<string, string>();
  if (works.length) for (const r of all<{ id: string; root: string }>(app.db, `select id, coalesce(json_extract(input, '$.continueFrom'), id) root from runs
    where kind = 'code' and (id in (select value from json_each(?)) or json_extract(input, '$.continueFrom') in (select value from json_each(?)))`, JSON.stringify(roots), JSON.stringify(roots))) roundOf.set(r.id, r.root);
  const reqOfWork = new Map<string, Set<string>>();
  const mark = (work: string | undefined | null, node: string) => {
    const root = under.get(node);
    if (!work || !root) return;
    if (!reqOfWork.has(work)) reqOfWork.set(work, new Set());
    reqOfWork.get(work)!.add(`req:${root}`);
  };
  if (under.size && roundOf.size) for (const s of all<{ node_id: string; run_id: string }>(app.db, `select node_id, run_id from req_status where node_id in (select value from json_each(?))`, JSON.stringify([...under.keys()]))) mark(roundOf.get(s.run_id), s.node_id);
  for (const list of tests.values()) for (const t of list) mark(t.workId, t.nodeId ?? "");

  const workEntries: ChainEntry[] = works.map((w) => {
    const t = testState(testsOfWork(app, { workId: w.rootId }));
    const links = [
      ...reqOfWork.get(w.rootId) ?? [],
      ...fs.filter((f) => f.work_id === w.rootId).map((f) => `finding:${f.id}`),
      ...designs.filter((d) => d.workId === w.rootId).map((d) => `design:${d.id}`),
    ];
    return {
      key: `work:${w.rootId}`, kind: "work", title: w.title, status: w.stage.text, cls: w.stage.cls,
      now: [t ? TEST_WORD(t) : "", w.now].filter(Boolean).join(" · "), href: `#/runs/${encodeURIComponent(w.latestId)}`, links: [...new Set(links)],
      waits: w.stage.group, reviewing: w.stage.key === "reviewing" || /评审中/.test(w.stage.text),
    };
  });
  // Platform objects (a merge request): their status at the platform, linked to nothing.
  for (const o of all<{ ref: string }>(app.db, "select ref from item_materials where item_id = ? and kind = 'object' order by id desc limit 20", itemId)) {
    const v = objectView(app, o.ref);
    if (v) workEntries.push({ key: `object:${v.id}`, kind: "object", title: v.title, status: v.statusLabel, cls: v.final ? "ok" : "", now: v.label, href: v.link, links: [] });
  }
  return { reqs: take(reqs), findings: take(findings), designs: take(designEntries), works: take(workEntries), more };
}

const empty = (s: ChainSegments) => !s.reqs.length && !s.findings.length && !s.designs.length && !s.works.length;

/** GET /api/items/:id/chain: the item's chain, or a line's children's chains grouped by child. */
export function itemChain(app: App, itemId: string, userId: string): ItemChain {
  const item = requireItem(app, itemId, userId, "read");
  const c: Ctx = { app, userId, spaces: accessibleSpaces(app, userId), owner: userId === OWNER };
  const ids = visibleBranchIds(app, item, userId).slice(0, CHAIN_MAX.children + 1);
  const titles = new Map(all<{ id: string; title: string }>(app.db,
    "select id,title from items where id in (select value from json_each(?))", JSON.stringify(ids)).map(r => [r.id, r.title]));
  const seen = new Set<string>();
  const groups: ChainGroup[] = [];
  let moreGroups = 0;
  for (const id of ids) {
    if (groups.length >= CHAIN_MAX.groups) {
      // Counted only: a full chain for each would be the work the cap is there to avoid.
      if (!empty(chainOf(c, id, new Set(seen)))) moreGroups++;
      continue;
    }
    const s = chainOf(c, id, seen);
    if (!empty(s)) groups.push({ item: { id, title: titles.get(id)! }, ...s });
  }
  const every = groups.flatMap((g) => [...g.reqs, ...g.findings, ...g.designs, ...g.works]);
  const works = groups.flatMap((g) => g.works.filter((e) => e.kind === "work"));
  return {
    itemId, line: ids.length > 1, groups, moreGroups,
    counts: {
      reqs: every.filter((e) => e.kind === "req").length, findings: every.filter((e) => e.kind === "finding").length,
      designs: every.filter((e) => e.kind === "design").length, works: works.length,
      reviewing: works.filter((e) => e.reviewing).length, waiting: works.filter((e) => e.waits === "owner").length,
    },
  };
}
