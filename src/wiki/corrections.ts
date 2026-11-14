import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace, relatedIds } from "../core/spaces.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { can } from "../auth/permissions.ts";
import { HttpError, newId, now, truncate } from "../core/util.ts";
import { createRun, registerHandler, runUser } from "../agents/runs.ts";
import { search } from "../search/search.ts";
import { generateWiki, sendPagesBack } from "./generate.ts";
import { readPage } from "./store.ts";
import { checkPublished, getGeneration, pageChecks, type Finding, type Generation } from "./verify.ts";

export const correctionInput = z.object({ slug: z.string().trim().min(1), wrong: z.string().trim().min(1).max(4000), right: z.string().trim().min(1).max(4000) });
export type Correction = { id: string; space_id: string; slug: string; wrong: string; right: string; by: string; at: string; pipeline: string | null; status: "open" | "swept"; sweep_run_id: string | null; checked: number; fixed: number };

export function listCorrections(app: App, spaceId: string, limit = 20) {
  return all<Correction & { title: string }>(app.db,
    `select c.*, coalesce(p.title, c.slug) title from page_corrections c
     left join pages p on p.space_id = c.space_id and p.slug = c.slug
     where c.space_id = ? order by c.at desc, c.rowid desc limit ?`, spaceId, limit);
}

/** The checker learns only the owner's corrections in the space being checked. */
export function correctionLessons(app: App, spaceId: string) {
  const rows = all<{ wrong: string; right: string }>(app.db, "select wrong, right from page_corrections where space_id = ? order by at desc, rowid desc limit 20", spaceId);
  return rows.length ? `## 本人指正过的错误\n\n${rows.map((r) => `- ${truncate(`${r.wrong.replace(/\s+/g, " ")} → ${r.right.replace(/\s+/g, " ")}`, 200)}`).join("\n")}` : "";
}

export function createCorrection(app: App, spaceId: string, input: z.input<typeof correctionInput>, opts: { userId?: string; parentId?: string | null; readable?: string[] | null; writable?: string[] | null } = {}) {
  const userId = opts.userId ?? OWNER;
  const allowed = scopeFor(app, userId, opts.readable ?? null);
  if ((allowed && !allowed.includes(spaceId)) || (opts.writable && !opts.writable.includes(spaceId)) || !can(app, userId, "wiki.write", spaceId) || findSpace(app, spaceId)?.kind === "worktree")
    throw new HttpError(403, `本次任务不能修改空间 ${spaceId} 的 Wiki`);
  const data = correctionInput.parse(input);
  const page = readPage(app, spaceId, data.slug);
  const pipeline = one<{ kind: string | null }>(app.db,
    `select r.kind from page_writes w left join runs r on r.id = w.run_id
     where w.space_id = ? and w.slug = ? order by w.id desc limit 1`, spaceId, page.slug)?.kind ?? null;
  const id = newId("wc"), at = now();
  run(app.db, 'insert into page_corrections(id,space_id,slug,wrong,right,"by",at,pipeline,updated_at) values(?,?,?,?,?,?,?,?,?)', id, spaceId, page.slug, data.wrong, data.right, userId, at, pipeline, at);
  const focus = `本人指出这一页有错：${data.wrong} → 应该是 ${data.right}。按这条指正修改，查阅原件和代码，其余正确内容保留。`;
  const rewrite = generateWiki(app, { spaceId, pages: [page.slug], focus, userId, parentId: opts.parentId, readable: allowed, writable: opts.writable, notify: false }) as ReturnType<typeof generateWiki> & { generation: string; writeRuns: string[] };
  if (!app.config.wiki.corrections.sweep) {
    run(app.db, "update page_corrections set status = 'swept', updated_at = ? where id = ?", now(), id);
    return { id, sweepRunId: null, writeRuns: rewrite.writeRuns };
  }
  const sweep = createRun(app, { kind: "wiki-sweep", spaceId, userId, parentId: opts.parentId, input: { correctionId: id, generation: rewrite.generation, readSpaces: allowed }, title: `按指正排查：《${page.meta.title}》` });
  run(app.db, "update page_corrections set sweep_run_id = ?, updated_at = ? where id = ?", sweep.id, now(), id);
  return { id, sweepRunId: sweep.id, writeRuns: rewrite.writeRuns };
}

const directory = (slug: string) => slug.slice(0, slug.lastIndexOf("/") + 1);

/** Bounded metadata queries and one bounded search; page bodies are read only after selection. */
export async function correctionCandidates(app: App, correction: Correction, at = Date.now()) {
  const limit = app.config.wiki.corrections.sweep;
  if (!limit) return [];
  const folder = directory(correction.slug);
  const same = correction.pipeline === null ? [] : all<{ slug: string }>(app.db,
    `select w.slug from page_writes w join pages p on p.space_id = w.space_id and p.slug = w.slug
     join runs r on r.id = w.run_id
     where w.space_id = ? and w.at >= ? and w.slug != ? and r.kind = ?
       and w.id = (select x.id from page_writes x where x.space_id = w.space_id and x.slug = w.slug order by x.id desc limit 1)
     order by (substr(w.slug, 1, ?) = ? and instr(substr(w.slug, ?), '/') = 0) desc, w.at desc, w.id desc limit ?`,
    correction.space_id, new Date(at - 90 * 86400_000).toISOString(), correction.slug, correction.pipeline,
    folder.length, folder, folder.length + 1, limit);
  const hits = await search(app, correction.wrong, { spaces: [correction.space_id], types: ["page"], limit: 20 });
  return [...new Set([...same.map((p) => p.slug), ...hits.filter((h) => h.type === "page" && h.spaceId === correction.space_id).map((h) => h.path)])]
    .filter((slug) => slug !== correction.slug)
    .sort((a, b) => Number(directory(b) === folder) - Number(directory(a) === folder))
    .slice(0, limit);
}

/** Wait for retries too, without occupying the writing task's background slot. */
function settledGeneration(app: App, id: string, signal: AbortSignal): Promise<Generation> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearInterval(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("CANCELLED")); };
    const check = () => {
      const g = getGeneration(app, id);
      if (g?.reportedAt) { cleanup(); resolve(g); }
    };
    const timer = setInterval(check, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

registerHandler("wiki-sweep", async (ctx) => {
  const app = ctx.app, userId = runUser(app, ctx.run.id);
  const c = one<Correction>(app.db, "select * from page_corrections where id = ? and sweep_run_id = ?", String(ctx.run.input.correctionId), ctx.run.id);
  if (!c || c.status === "swept") return { quiet: true };
  const allowed = scopeFor(app, userId, ctx.run.input.readSpaces as string[] | null);
  if ((allowed && !allowed.includes(c.space_id)) || !can(app, userId, "wiki.write", c.space_id)) throw new HttpError(403, "已不能修改这个空间的 Wiki");
  const original = await settledGeneration(app, String(ctx.run.input.generation), ctx.signal);
  ctx.output({ original: original.report });
  const candidates = await correctionCandidates(app, c);
  const readSpaces = [c.space_id, ...relatedIds(app, c.space_id).filter((id) => !allowed || allowed.includes(id))];
  const focus = `本人指出过这类错误：${c.wrong} → 应该是 ${c.right}。这一页有没有同样的问题？本次只提交同类问题的 findings，没有同类问题就交空 findings。`;
  const wrong: { slug: string; findings: Finding[] }[] = [];
  let checked = 0;
  for (const slug of candidates) {
    ctx.signal.throwIfAborted();
    try {
      const page = readPage(app, c.space_id, slug);
      const got = await checkPublished(ctx, c.space_id, { slug: page.slug, title: page.meta.title, summary: page.meta.summary ?? "", kind: page.meta.kind ?? "page", body: page.body }, readSpaces, focus);
      if (got) {
        checked++;
        if (got.findings.length) wrong.push({ slug, findings: got.findings });
      }
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.event("status", { text: `没核完 ${slug}：${truncate((e as Error).message, 160)}` });
    }
    run(app.db, "update page_corrections set checked = ?, updated_at = ? where id = ?", checked, now(), c.id);
  }
  let fixed: string[] = [];
  if (wrong.length) {
    const writes = sendPagesBack(app, { spaceId: c.space_id, pages: wrong, focus: `${focus}\n你负责的是任务开头写的那一页，只修改它名下的问题，其余正确内容保留。`, userId, parentId: ctx.run.id, readable: allowed, notify: false });
    ctx.output({ generation: writes.generation, writeRuns: writes.writeRuns, found: wrong.map((p) => p.slug) });
    const g = await settledGeneration(app, writes.generation, ctx.signal);
    fixed = g.pages.filter((p) => {
      const rec = pageChecks(app, c.space_id, p.slug).find((r) => r.runId === p.runs.at(-1));
      return rec?.status === "passed" && !!g.report?.written.some((w) => w.slug === p.slug);
    }).map((p) => p.slug);
  }
  run(app.db, "update page_corrections set checked = ?, fixed = ?, status = 'swept', updated_at = ? where id = ? and status = 'open'", checked, fixed.length, now(), c.id);
  const title = one<{ title: string }>(app.db, "select title from pages where space_id = ? and slug = ?", c.space_id, c.slug)?.title ?? c.slug;
  const summary = `按你对《${title}》的指正，另外查了 ${checked} 页，其中 ${wrong.length} 页有同样的问题，${fixed.length === wrong.length ? "已经改了" : `已改 ${fixed.length} 页，其余未改成，可查看排查运行`}。`;
  if (checked) notify(app, { title: summary, body: [summary, ...candidates.map((slug) => `- [${slug}](#/wiki/${encodeURIComponent(c.space_id)}/${slug.split("/").map(encodeURIComponent).join("/")})${fixed.includes(slug) ? "（已改）" : wrong.some((p) => p.slug === slug) ? "（未改成）" : ""}`)].join("\n"), link: `#/wiki/${encodeURIComponent(c.space_id)}/${c.slug}`, runId: ctx.run.id, userId: c.by, urgency: "later" });
  return { summary, checked, fixed: fixed.length, quiet: !wrong.length };
});
