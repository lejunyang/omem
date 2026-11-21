import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, now, sha256 } from "../core/util.ts";
import { audit } from "../auth/permissions.ts";
import { reviewProviders } from "../plugins/process-hooks.ts";
import { pluginObjectKind } from "../plugins/objects.ts";
import type { DiffAnchor, ThreadState } from "../plugins/types.ts";
import { itemAccess } from "../items/access.ts";
import { createAsk, cancelHostAsks, registerAskHandler } from "./asks.ts";
import { enqueuePluginEvent } from "../plugins/event-store.ts";
import { addRunEvent, getRun } from "./runs.ts";
import type { FindingRow } from "./review.ts";

type External = Partial<ThreadState> & { url?: string; ref?: string; revision?: string; object?: string; provider?: string;
  anchor?: DiffAnchor; delivery?: "published" | "failed" | "relocate"; error?: string; checkedAt?: string; threadError?: string; syncedAt: string };
const externalOf = (row: FindingRow): External | null => row.external ? JSON.parse(row.external) : null;
const eligible = (f: FindingRow) => ["open", "accepted"].includes(f.state) && !f.merged_into && f.decision !== "wontfix" &&
  f.resolution !== "fixed" && f.resolution !== "moot" && (!f.external || externalOf(f)?.delivery === "failed" && !externalOf(f)?.url);
function findings(app: App, id: string) {
  return all<FindingRow>(app.db, "select f.* from reviews r join review_findings f on f.review_id=r.id where r.code_run_id=? order by f.id", id);
}
function targets(app: App, id: string, user: string) {
  const review = getRun(app, id);
  if (!review.input.itemId || !review.spaceId) return [];
  const item = one<{ userId: string; spaceId: string }>(app.db, "select user_id userId,space_id spaceId from items where id=?", String(review.input.itemId));
  if (!item || !itemAccess(app, user, item, "read")) return [];
  const objects = all<{ id: string; key: string; kind: string; title: string; link: string }>(app.db,
    "select o.id,o.key,o.kind,o.title,o.link from item_materials m join flow_objects o on o.id=m.ref where item_id=? and m.kind='object'", String(review.input.itemId));
  return objects.flatMap(o => {
    const plugin = pluginObjectKind(o.kind)?.plugin;
    const provider = [...reviewProviders].find(([, e]) => e.plugin === plugin && o.kind === e.plugin + ":" + e.def.objectKind &&
      (!e.spaces.length || [item.spaceId, review.spaceId!].every(s => e.spaces.includes(s))));
    return provider ? [{ ...o, provider: provider[0], label: provider[1].def.label }] : [];
  });
}
function pending(app: App, id: string) {
  return all<{ id: string; action: string }>(app.db, `select id,json_extract(context,'$.action') action from asks where run_id=? and status='pending'
    and json_extract(context,'$.handler') in ('review-publish','review-resolve') order by created_at`, id);
}
export function reviewSyncView(app: App, id: string, user: string) {
  return { objects: targets(app, id, user).map(({ key, kind, ...o }) => o),
    findings: [...findings(app, id), ...checkedFindings(app, id)].map(f => ({ id: f.id, eligible: !f.resolved_run && eligible(f), external: externalOf(f) })), pending: pending(app, id) };
}

function anchorFor(file: string | null, line: number | null, head: string | null | undefined, repos: string[]): DiffAnchor | undefined {
  if (!file || !line) return;
  const spaces = repos;
  const space = spaces.length === 1 ? spaces[0] : spaces.find(s => file.startsWith(s + "/"));
  const path = spaces.length > 1 && space ? file.slice(space.length + 1) : file;
  if (!space || !head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) || path.startsWith("/") || path.split("/").includes("..")) return;
  return { path, line, side: "RIGHT", head };
}

export function offerReviewPublish(app: App, id: string, selection?: { object: string; findings: number[] }) {
  const review = getRun(app, id);
  if (review.output.reviewStage !== "done") {
    if (selection) throw new HttpError(409, "评审还在进行");
    return null;
  }
  const objects = targets(app, id, OWNER).filter(o => !selection || o.id === selection.object);
  if (!objects.length) {
    if (selection) throw new HttpError(400, "对象未关联或提供者已停用");
    return null;
  }
  const rows = findings(app, id).filter(f => eligible(f) && (!selection || selection.findings.includes(f.id)));
  if (selection && rows.length !== new Set(selection.findings).size) throw new HttpError(409, "所选问题已变化");
  if (!rows.length) return null;
  cancelHostAsks(app, id, "review-publish");
  const objectNames = objects.map((o,i) => `${i+1}. ${o.title.slice(0,150)}`);
  const ask = createAsk(app, { runId: id, userId: OWNER, conversationId: null, allowText: false,
    question: `把这次评审的 ${rows.length} 条问题发到${objects.length === 1 ? "《" + objects[0].title + "》" : "哪个对象"}上？`,
    options: [...(objects.length === 1 ? [{ label: "全部发布" }] : []), { label: "不发布" }],
    ui: { submitLabel: "发布选中的问题", fields: [
      ...(objects.length === 1 ? [] : [{ id: "object", type: "choice" as const, label: "目标对象", required: true, options: objectNames }]),
      { id: "findings", type: "checklist", label: "要发布的问题", choices: ["发布", "跳过"], note: false, required: false,
        items: rows.map(f => ({ id: String(f.id), title: "#" + f.id + " " + f.title, detail: [f.file_path, f.line].filter(Boolean).join(":") })) },
    ] }, context: { handler: "review-publish", action: "publish", objects: objects.map(o => o.id), objectNames, findings: rows.map(f => f.id) } });
  return { askId: ask.id, state: "pending" };
}

const active = new WeakMap<App, Set<number>>();
async function exclusive(app: App, fid: number, fn: () => Promise<void>) {
  let busy = active.get(app);
  if (!busy) active.set(app, busy = new Set());
  if (busy.has(fid)) return;
  busy.add(fid);
  try { await fn(); } finally { busy.delete(fid); }
}
function requireOwner(by: string) {
  if (by !== OWNER) throw new HttpError(403, "外部评审操作须由本人确认");
}
const ownerGuard = (_app: App, _ask: unknown, _ctx: unknown, by: string) => requireOwner(by);
registerAskHandler("review-publish", async (app, ask, ctx) => {
  const objects = ctx.objects as string[], names = ctx.objectNames as string[], ids = ctx.findings as number[];
  const allSelected = objects.length === 1 && ask.choice === 0;
  if ((!allSelected && ask.choice !== null) || (!allSelected && !ask.value)) return;
  const object = objects.length === 1 ? objects[0] : objects[names.indexOf(String(ask.value?.object))];
  const choices = ask.value?.findings as Record<string, { choice: string }> | undefined;
  await publish(app, ask.runId!, ask.answeredBy!, object, ids.filter(id => allSelected || choices?.[id]?.choice === "发布"));
}, ownerGuard);

function checkedFindings(app: App, runId: string) {
  return all<FindingRow>(app.db, `select f.* from review_findings f join reviews r on r.id=f.review_id
    where f.checked_run=? and r.code_run_id<>?`, runId,runId);
}

async function publish(app: App, id: string, user: string, object: string, ids: number[]) {
  requireOwner(user);
  const review = getRun(app, id);
  if (review.output.reviewStage !== "done") throw new HttpError(409, "评审已变化");
  for (const fid of ids) await exclusive(app, fid, async () => {
    const target = targets(app, id, user).find(o => o.id === object);
    if (!target) throw new HttpError(409, "目标对象已变化");
    const entry = reviewProviders.get(target.provider)!;
    const f = one<FindingRow>(app.db, "select f.* from review_findings f join reviews r on r.id=f.review_id where f.id=? and r.code_run_id=?", fid,id);
    if (!f || !eligible(f)) return;
    const anchor = anchorFor(f.file_path, f.line, f.reviewed_head, review.input.repos as string[] ?? [review.spaceId!]);
    const ext: External = { object, provider: target.provider, anchor, syncedAt: now() };
    try {
      if (!anchor) throw Object.assign(new Error("缺少评审时的提交、文件或行号"), { code: "REVIEW_ANCHOR_OUTDATED" });
      const ctx = entry.context(app, user, review.spaceId!, AbortSignal.timeout(15000));
      const ref = await entry.def.publish({ ...ctx, idempotencyKey: sha256(JSON.stringify([id, fid, object])) },
        { objectKey: target.key, findingId: fid, anchor, body: [f.title, f.detail, f.owner_suggestion || f.suggestion].filter(Boolean).join("\n\n") });
      Object.assign(ext, { url: ref.url, ref: ref.id, revision: ref.revision, state: "open", delivery: "published" });
    } catch (e) {
      ext.delivery = (e as {code?: string})?.code === "REVIEW_ANCHOR_OUTDATED" ? "relocate" : "failed";
      ext.error = String((e as Error)?.message ?? e).slice(0,500);
    }
    withinTx(app.db, () => {
      run(app.db, "update review_findings set external=? where id=? and external is ?", JSON.stringify(ext), fid, f.external ?? null);
      audit(app, user, "review.publish", object, { run: id, finding: fid, object, result: ext.delivery });
    });
  });
}

const openThread = "json_extract(f.external,'$.delivery')='published' and json_extract(f.external,'$.state') in ('open','replied')";
const lastCheck = "coalesce(json_extract(f.external,'$.checkedAt'),'')";
type ThreadRow = FindingRow & { origin: string; space: string; kind: string | null; itemSpace: string; itemUser: string };
const threadRows = `select f.*,r.code_run_id origin,u.space_id space,o.kind,i.space_id itemSpace,i.user_id itemUser
  from review_findings f join reviews r on r.id=f.review_id join runs u on u.id=r.code_run_id
  left join items i on i.id=json_extract(u.input,'$.itemId')
  left join item_materials m on m.item_id=i.id and m.kind='object' and m.ref=json_extract(f.external,'$.object')
  left join flow_objects o on o.id=m.ref where ${openThread}`;
function threadProvider(row: ThreadRow, ext: External) {
  const entry = reviewProviders.get(ext.provider!);
  if (entry && row.kind === entry.plugin + ":" + entry.def.objectKind && pluginObjectKind(row.kind) &&
      (!entry.spaces.length || [row.space,row.itemSpace].every(s => entry.spaces.includes(s)))) return entry;
}

function saveThread(app: App, row: ThreadRow, ext: External, update: Partial<External>, event: boolean) {
  const next = { ...ext, ...update, checkedAt: now() };
  return withinTx(app.db, () => {
    if (!run(app.db, "update review_findings set external=? where id=? and external=?", JSON.stringify(next), row.id, row.external!).changes) return false;
    if (event && (next.state === "resolved" && ext.state !== "resolved" || next.reply && JSON.stringify(next.reply) !== JSON.stringify(ext.reply) ||
      next.state === "replied" && ext.state !== "replied")) {
      const data = { runId: row.origin, finding: row.id, object: ext.object, url: ext.url, state: next.state, reply: next.reply };
      enqueuePluginEvent(app, "finding.thread", row.space, () => ({ userId: OWNER, entity: { kind: "finding", id: String(row.id) }, actor: { kind: "host" }, data }));
      addRunEvent(app, row.origin, "finding.thread", data);
    }
    return true;
  });
}

export async function refreshThreads(app: App, filter: { object?: string; runId?: string; viewer?: string } = {}) {
  const condition = filter.object ? "json_extract(f.external,'$.object')=?" : filter.runId
    ? "f.id in (select x.id from review_findings x join reviews v on v.id=x.review_id where v.code_run_id=? union select id from review_findings where checked_run=?)"
    : lastCheck + "<?";
  const args = filter.object ? [filter.object] : filter.runId ? [filter.runId,filter.runId] : [new Date(Date.now()-300_000).toISOString()];
  const rows = all<ThreadRow>(app.db, threadRows + " and " + condition + " order by " + lastCheck + ",f.id limit 20", ...args);
  let refreshed = 0, failed = 0;
  for (const row of rows) await exclusive(app, row.id, async () => {
    const ext = externalOf(row)!;
    const entry = threadProvider(row, ext);
    if (filter.viewer && !itemAccess(app, filter.viewer, { userId: row.itemUser, spaceId: row.itemSpace }, "read")) return;
    try {
      if (!entry) throw new Error("提供者已停用或对象关联已变化");
      const ctx = entry.context(app, OWNER, row.space, AbortSignal.timeout(15000));
      const state = await entry.def.readThread(ctx, { id: ext.ref!, url: ext.url!, revision: ext.revision });
      if (saveThread(app, row, ext, { ...state, threadError: undefined, syncedAt: now() }, true)) refreshed++;
    } catch (e) {
      saveThread(app, row, ext, { threadError: String((e as Error).message).slice(0,500) }, false);
      failed++;
    }
  });
  return { refreshed, failed };
}

function resolvable(app: App, id: string, ids: number[]) {
  return all<ThreadRow>(app.db, threadRows + " and f.resolution='fixed' and (f.checked_run=? or r.code_run_id=?) and f.id in (select value from json_each(?))",
    id,id,JSON.stringify(ids)).filter(r => threadProvider(r, externalOf(r)!)?.def.resolve);
}
export function offerReviewResolve(app: App, id: string, ids: number[], automatic = false) {
  const rows = resolvable(app, id, ids);
  if (!automatic && rows.length !== new Set(ids).size) throw new HttpError(409, "所选问题的讨论或复审结论已变化");
  if (!rows.length) return null;
  const ask = createAsk(app, { runId: id, userId: OWNER, conversationId: null, allowText: false,
    question: "复审确认已修，结束平台上的讨论吗？\n" + rows.map(f => "#" + f.id + " " + f.title + " " + externalOf(f)!.url).join("\n"),
    options: [{ label: "结束讨论" }, { label: "保持原状" }],
    context: { handler: "review-resolve", action: "resolve", findings: rows.map(f => f.id) } });
  return { askId: ask.id, state: "pending" };
}

registerAskHandler("review-resolve", async (app, ask, args) => {
  if (ask.choice !== 0) return;
  requireOwner(ask.answeredBy!);
  for (const fid of args.findings as number[]) await exclusive(app, fid, async () => {
    const [row] = resolvable(app, ask.runId!, [fid]);
    if (!row) return;
    const ext = externalOf(row)!;
    const entry = threadProvider(row, ext)!;
    const ctx = entry.context(app, OWNER, row.space, AbortSignal.timeout(15000));
    const ref = { id: ext.ref!, url: ext.url!, revision: ext.revision };
    let result: string;
    try {
      const before = await entry.def.readThread(ctx, ref);
      if (before.state === "resolved" || before.state === "outdated") {
        saveThread(app, row, ext, before, true);
        result = "already-" + before.state;
      } else {
        const current = resolvable(app, ask.runId!, [fid])[0];
        if (!current || current.external !== row.external || threadProvider(current, ext) !== entry) throw new Error("讨论或复审结论已变化");
        const after = await entry.def.resolve!({ ...ctx, idempotencyKey: sha256(JSON.stringify(["resolve", row.origin, fid, ext.ref])) }, ref);
        if (after.state !== "resolved" && after.state !== "outdated") throw new Error("平台讨论仍在进行");
        saveThread(app, row, ext, { ...after, threadError: undefined, syncedAt: now() }, false);
        result = after.state;
      }
    } catch (e) {
      result = "failed";
      saveThread(app, row, ext, { threadError: String((e as Error).message).slice(0,500) }, false);
    }
    audit(app, OWNER, "review.resolve", ext.object!, { run: ask.runId, finding: fid, object: ext.object, result });
  });
}, ownerGuard);
