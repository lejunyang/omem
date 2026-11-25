import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { commitLibrary, git } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, truncate, webLink } from "../core/util.ts";
import { findRule, saveRule, deleteRule } from "../rules/store.ts";
import { contextRevision, getContext, restoreContextRevision } from "../channels/listen.ts";
import { playbookPath } from "../channels/listen-cases.ts";
import { workUri, writeWorkFile } from "../sources/work.ts";
import { deleteSource } from "../sources/store.ts";
import { addMessage, findThread } from "./threads.ts";
import { listSkillFiles } from "./specs.ts";
import { cancelAsk, conversationOfRun, createAsk, registerAskHandler, uiLink } from "./asks.ts";
import type { ToolContext } from "./tools.ts";

export const BEHAVIOR_CHANGE = "behavior-change";
export const changeWords = {
  change_reason: z.string().trim().max(200).optional().describe("为什么要改这份长期做法，一句话写清依据"),
  owner_request: z.string().trim().min(4).max(240).optional().describe("仅当本人在本轮直接要求改这份东西时，摘录点名它和要改什么的一句本人原话"),
};
type Words = { change_reason?: string; owner_request?: string };
type Target = { kind: "skill" | "agent" | "role" | "skill-groups" | "rule" | "watch" | "playbook"; id: string };
type Text = { text: string | null; revision?: string };
type Snapshot = Record<string, Text>;
type Delta = { before: Text; after: Text };
type Change = { target: Target; files: Record<string, Delta>; runIds: string[]; explicit: boolean };
const label = { skill: "技能", agent: "Agent 档案", role: "角色说明", "skill-groups": "技能分组", rule: "规则", watch: "关注", playbook: "关注经验" };
const absent = { text: null };
const oneline = (s: string, n = 100) => truncate(s.replace(/\s+/g, " ").trim(), n);

/** Never follow a symlink: the owner may have reorganized the data directory since the write. */
function libraryPath(app: App, path: string) {
  const root = realpathSync(app.libraryDir);
  const full = resolve(root, path);
  const parts = path.split("/");
  if (!full.startsWith(root + sep) || path.includes("\\") || parts.some((p) => !p || p === "." || p === ".." || p === ".git")) throw new HttpError(400, "行为设置文件路径无效");
  let p = root;
  for (const part of parts) {
    p = join(p, part);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() || (st && p === full && !st.isFile())) throw new HttpError(409, "行为设置文件的位置已更改");
  }
  return full;
}

function pathsOf(t: Target, files: string[]) {
  if (t.kind === "skill-groups") return ["skill-groups.json"];
  if (!["skill", "agent", "role"].includes(t.kind)) return [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) throw new HttpError(400, "设置名称无效");
  if (t.kind === "skill") return ["SKILL.md", ...files].map((f) => `_skills/${t.id}/${f}`);
  if (t.kind === "agent") return [`_agents/${t.id}.md`];
  return [`_roles/${t.id}.md`, `_roles/.base/${t.id}.md`, `_roles/${t.id}.overlay.yaml`];
}

function ruleText(app: App, id: string) {
  const r = findRule(app, id);
  if (!r) return null;
  const { hits: _hits, lastFiredAt: _fired, createdAt: _created, updatedAt: _updated, ...settings } = r;
  return JSON.stringify(settings);
}
function storedText(app: App, t: Target): string | null {
  if (t.kind === "rule") return ruleText(app, t.id);
  const watch = contextRevision(app, t.id);
  return watch && JSON.stringify(watch);
}
function playbook(app: App, id: string) {
  const c = getContext(app, id);
  if (!c) return null;
  const space = c.spaceId ?? "personal", path = playbookPath(c);
  const row = one<{ id: string; title: string; text: string }>(app.db, "select id,title,text from sources where space_id=? and uri=? and kind='work' and deleted_at is null", space, workUri(path));
  return row && { ...row, space, path } || null;
}
function storedPiece(app: App, t: Target, key: string) {
  if (key === "settings") return storedText(app, t);
  const p = playbook(app, t.id);
  return p && JSON.stringify(p);
}
function fileText(app: App, path: string, revision?: string): Text {
  const full = libraryPath(app, path);
  const text = existsSync(full) ? readFileSync(full).toString("base64") : null;
  // Keep the exact bytes as fallback (an uncommitted edit, or Git not installed).
  return { text, ...(revision && text !== null ? { revision } : {}) };
}
function snapshot(app: App, target: Target, files: string[]): Snapshot {
  if (target.kind === "watch" || target.kind === "rule") return { settings: { text: storedText(app, target) } };
  if (target.kind === "playbook") return { playbook: { text: storedPiece(app, target, "playbook") } };
  const revision = existsSync(join(app.libraryDir, ".git")) ? git(app.libraryDir, ["rev-parse", "--verify", "HEAD"]).stdout.trim() : undefined;
  return Object.fromEntries(pathsOf(target, files).map((path) => [path, fileText(app, path, revision)]));
}

/** Capture before calling the existing persistence API. No extra work for a person's own edit. */
export function beforeBehavior(ctx: Pick<ToolContext, "app" | "runId" | "actor" | "shadow">, target: Target, files: string[] = []) {
  if (ctx.actor !== "agent" || !ctx.runId || ctx.shadow) return undefined;
  return snapshot(ctx.app, target, files);
}

function wasRequested(app: App, id: string, quote: string | undefined, target: Target, name: string) {
  if (!quote || ![name, target.id].some((n) => n && quote.includes(n))) return false;
  const r = one<{ input: string; output: string }>(app.db, "select input,output from runs where id=? and kind='ask' and coalesce(user_id,'owner')='owner'", id);
  if (!r) return false;
  const input = json<{ coordinate?: unknown; handoff?: unknown; fromAsk?: unknown; userId?: string; conversationId?: string; messageIds?: string[] }>(r.input, {});
  if (input.coordinate || input.handoff || input.fromAsk || (input.userId ?? OWNER) !== OWNER || !input.conversationId) return false;
  const ids = [...(input.messageIds ?? []), ...(json<{ steered?: string[] }>(r.output, {}).steered ?? [])];
  return ids.some((msg) => one(app.db, `select 1 from messages where id=? and conversation_id=? and role='user' and instr(text, ?) > 0
    and json_extract(meta,'$.speaker') is null and json_extract(meta,'$.asker') is null and json_extract(meta,'$.wake') is null and coalesce(json_extract(meta,'$.userId'),'owner')='owner'`, msg, input.conversationId!, quote));
}

const redact = (s: string) => s.replace(/^([^\n]*(?:api[-_]?key|token|secret|password|authorization|headers|env)\s*[:=]).*$/gim, "$1 [已省略]");
function paragraphs(s: string) { return s.trim().split(/\n[ \t]*\n/).flatMap((p) => p.length <= 320 ? [p] : p.split("\n")).filter(Boolean); }
function display(value: Text, path: string) {
  if (value.text === null) return "";
  if (path === "playbook") return redact(json<{ text: string }>(value.text, { text: "" }).text);
  if (path !== "settings") {
    const text = Buffer.from(value.text, "base64").toString("utf8");
    if (text.includes("\0")) return "（非文本文件）";
    // MCP and inline scripts may carry credentials. Keep the bytes for undo; don't copy them onto cards.
    const safe = path.startsWith("_agents/") ? text.replace(/^(mcp:\s*).*?(?=^[^ \t]|$(?![\s\S]))/ms, "$1[已省略]\n") : text;
    return redact(safe);
  }
  const obj = json<Record<string, unknown>>(value.text, {});
  const parts = (obj: Record<string, unknown>, prefix = ""): string[] => Object.entries(obj).flatMap(([k, v]) => {
    if (["id", "conversation_id", "createdBy", "playbookAt", "since", "at", "confirmedAt"].includes(k)) return [];
    const key = `${prefix}${k}`;
    if (v && typeof v === "object" && !Array.isArray(v)) return parts(v as Record<string, unknown>, `${key}.`);
    const safe = k === "actions" && Array.isArray(v) ? v.map((a) => a?.type === "script" ? { ...a, code: "[已省略]" } : a) : v;
    return [`${key}: ${Array.isArray(safe) ? JSON.stringify(safe) : safe ?? ""}`];
  });
  return redact(parts(obj).join("\n\n"));
}
/** One paragraph of a file's before/after comparison. `rewrite`: a deleted paragraph and the added one that rewrites it. */
type Block = { kind: "same" | "del" | "add"; text: string; rewrite?: boolean; section?: string | null };
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/;
/** The nearest `#` heading above each paragraph (its own first line when it is one); fenced code doesn't count. */
function sectionsOf(ps: string[]) {
  let current: string | null = null, fenced = false;
  return ps.map((p) => {
    const lines = p.split("\n");
    const own = !fenced && HEADING.exec(lines[0])?.[1];
    const at = own || current;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced && HEADING.test(line)) current = HEADING.exec(line)![1];
    }
    return at;
  });
}
const bigrams = (s: string) => { const t = s.replace(/\s+/g, ""); return Array.from({ length: Math.max(t.length - 1, 0) }, (_, i) => t.slice(i, i + 2)); };
/** Character-bigram overlap: a paragraph counts as rewritten only when about half of it is kept. */
function similar(a: string, b: string) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.length || !y.length) return false;
  const count = new Map<string, number>();
  for (const g of x) count.set(g, (count.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of y) { const n = count.get(g) ?? 0; if (n) { shared++; count.set(g, n - 1); } }
  return (2 * shared) / (x.length + y.length) >= 0.5;
}
/** Paragraph diff in document order (longest common subsequence, after the shared head and tail). */
function diffParagraphs(a: string[], b: string[]): Block[] {
  const secA = sectionsOf(a), secB = sectionsOf(b);
  let s = 0, e = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const n = a.length - s - e, m = b.length - s - e;
  const steps: ["same" | "del" | "add", number, number][] = [];
  if (n * m > 4_000_000) {
    for (let i = 0; i < n; i++) steps.push(["del", s + i, -1]);
    for (let j = 0; j < m; j++) steps.push(["add", -1, s + j]);
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[s + i] === b[s + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[s + i] === b[s + j]) steps.push(["same", s + i++, s + j++]);
      else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) steps.push(["del", s + i++, -1]);
      else steps.push(["add", -1, s + j++]);
    }
  }
  const out: Block[] = a.slice(0, s).map((text, i) => ({ kind: "same", text, section: secB[i] }));
  // Each run of changes: deleted paragraphs in order, each followed by the added one that rewrites it.
  for (let k = 0; k < steps.length;) {
    if (steps[k][0] === "same") { out.push({ kind: "same", text: b[steps[k][2]], section: secB[steps[k][2]] }); k++; continue; }
    const dels: number[] = [], adds: number[] = [];
    for (; k < steps.length && steps[k][0] !== "same"; k++) steps[k][0] === "del" ? dels.push(steps[k][1]) : adds.push(steps[k][2]);
    let next = 0;
    for (const i of dels) {
      const hit = adds.slice(next, next + 3).findIndex((j) => similar(a[i], b[j]));
      if (hit < 0) { out.push({ kind: "del", text: a[i], section: secA[i] }); continue; }
      for (const j of adds.slice(next, next + hit)) out.push({ kind: "add", text: b[j], section: secB[j] });
      const j = adds[next + hit];
      out.push({ kind: "del", text: a[i], rewrite: true, section: secA[i] }, { kind: "add", text: b[j], rewrite: true, section: secB[j] });
      next += hit + 1;
    }
    for (const j of adds.slice(next)) out.push({ kind: "add", text: b[j], section: secB[j] });
  }
  for (let i = a.length - e; i < a.length; i++) out.push({ kind: "same", text: a[i], section: secB[b.length - (a.length - i)] });
  return out;
}

/** Card wording drops Markdown marks: a line of what changed, not its source. */
function plain(s: string, n: number) {
  const t = s.replace(/```[^\n]*\n?/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, "").replace(/(\*\*|__|~~|`)/g, "").replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1$2");
  return oneline(t, n) || "（空白）";
}
const fileLabel = (t: Target, path: string) =>
  path === "settings" ? "设置" : path === "playbook" ? "经验" : path.startsWith(`_skills/${t.id}/`) ? path.slice(`_skills/${t.id}/`.length)
    : path === `_agents/${t.id}.md` ? "档案文件" : path === `_roles/${t.id}.md` ? "角色说明文件" : path === `_roles/${t.id}.overlay.yaml` ? "挂载设置" : path;
/** Structured text gets a summary by section; settings, YAML and JSON line by line. */
const code = (path: string) => path === "settings" || /\.(ya?ml|json)$/.test(path);
const structured = (path: string, blocks: Block[]) => !code(path) && blocks.some((b) => b.section);
function counts(blocks: Block[]) {
  const rewrite = blocks.filter((b) => b.kind === "add" && b.rewrite).length;
  return { removed: blocks.filter((b) => b.kind === "del" && !b.rewrite).length, added: blocks.filter((b) => b.kind === "add" && !b.rewrite).length, rewrite };
}
function countText(c: ReturnType<typeof counts>) {
  return [c.removed && `删了 ${c.removed} 段`, c.added && `加了 ${c.added} 段`, c.rewrite && `改写 ${c.rewrite} 段`].filter(Boolean).join("、");
}

type FileView = { path: string; name: string; status: "added" | "removed" | "changed"; counts: ReturnType<typeof counts>; blocks: Block[] };
function fileViews(change: Change): FileView[] {
  return Object.entries(change.files).filter(([path]) => !path.startsWith("_roles/.base/")).map(([path, { before, after }]) => {
    const blocks = diffParagraphs(paragraphs(display(before, path)), paragraphs(display(after, path)));
    return { path, name: fileLabel(change.target, path), status: before.text === null ? "added" : after.text === null ? "removed" : "changed", counts: counts(blocks), blocks };
  });
}

const SHOWN = 6;
/** What changed in one file, a few lines; whatever is left out points at the full comparison. */
function fileSummary(f: FileView, more: string) {
  const changed = f.blocks.filter((b) => b.kind !== "same" && !(b.kind === "del" && b.rewrite));
  if (!changed.length) return f.status === "changed" ? ["- 只有格式、段落顺序或不显示的内容（密钥、脚本）有变化"] : [];
  if (structured(f.path, f.blocks)) {
    // A rewrite counts once, under the section its new text is in.
    const by = new Map<string, ReturnType<typeof counts>>();
    for (const b of changed) {
      const key = b.section ? `「${plain(b.section, 30)}」` : "开头（第一个标题之前）";
      const c = by.get(key) ?? { removed: 0, added: 0, rewrite: 0 };
      c[b.rewrite ? "rewrite" : b.kind === "del" ? "removed" : "added"]++;
      by.set(key, c);
    }
    const lines = [...by].slice(0, SHOWN).map(([key, c]) => `- ${key}：${countText(c)}`);
    return by.size > SHOWN ? [...lines, `- 另有 ${by.size - SHOWN} 个小节${more}`] : lines;
  }
  // Settings values (a cron, a pattern) are not Markdown: keep their characters.
  const flat = (s: string, n: number) => (code(f.path) ? oneline(s, n) : plain(s, n));
  const lines = changed.map((b) => {
    if (!b.rewrite) return `- ${b.kind === "del" ? "删去" : "加上"}：${flat(b.text, 80)}`;
    const old = f.blocks[f.blocks.indexOf(b) - 1].text;
    const key = /^([\w.-]+):\s/.exec(b.text)?.[1];
    return key && old.startsWith(`${key}: `) ? `- ${key}：${flat(old.slice(key.length + 2), 50)} → ${flat(b.text.slice(key.length + 2), 50)}` : `- 改写：${flat(old, 50)} → ${flat(b.text, 50)}`;
  });
  return lines.length > SHOWN ? [...lines.slice(0, SHOWN), `- 另有 ${lines.length - SHOWN} 处${more}`] : lines;
}
function scale(f: FileView) {
  const n = f.blocks.filter((b) => b.kind !== "same").length;
  return f.status === "added" ? `新建，共 ${n} 段` : f.status === "removed" ? `删除了这个文件（原有 ${n} 段）` : countText(f.counts) || "格式有变化";
}

/** “现在的全文”: the page that shows this thing now; none for something deleted. */
function currentLink(change: Change) {
  const { kind, id } = change.target, q = encodeURIComponent(id);
  if (Object.values(change.files).every((d) => d.after.text === null)) return null;
  return { skill: `#/agents?tab=skills&name=${q}`, agent: `#/agents?tab=agents&name=${q}`, role: `#/agents?tab=agents&role=${q}`, "skill-groups": "#/agents?tab=skills",
    rule: `#/rules?id=${q}`, watch: `#/listen/${q}?tab=settings`, playbook: `#/listen/${q}?tab=lessons` }[kind];
}

/**
 * The notice: links first, who changed it and why, how big, then where (by section, or line by line for
 * settings). `link` turns an in-app address into what this text is read in; null drops the link.
 */
function changeBody(askId: string, change: Change, intro: string, link: (path: string) => string | null) {
  const files = fileViews(change);
  const full = link(`#/ui/${encodeURIComponent(askId)}`), now = currentLink(change), current = now && link(now);
  const more = full ? `，[看完整对照](${full})` : "";
  const head = [full && `[看完整对照](${full})`, current && `[现在的全文](${current})`].filter(Boolean).join("　");
  const total = files.reduce((c, f) => ({ removed: c.removed + f.counts.removed, added: c.added + f.counts.added, rewrite: c.rewrite + f.counts.rewrite }), { removed: 0, added: 0, rewrite: 0 });
  const parts = [head, intro];
  if (files.length === 1) parts.push(`改动：${files[0].name} · ${scale(files[0])}`, fileSummary(files[0], more).join("\n"));
  else {
    parts.push(`改动：${files.length} 个文件 · ${countText(total) || "格式有变化"}`);
    for (const f of files.slice(0, 4)) parts.push([`**${plain(f.name, 60)}**：${scale(f)}`, ...fileSummary(f, more)].join("\n"));
    if (files.length > 4) parts.push(`另有 ${files.length - 4} 个文件${more}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The full comparison for the question's page (`#/ui/<askId>`): every paragraph of every file, already
 * through `display()` (decoded, settings spread out, keys and MCP sections left out). Null for other asks.
 */
export function behaviorChangeView(app: App, askId: string) {
  const row = one<{ question: string; context: string | null }>(app.db, "select question, context from asks where id=?", askId);
  const ctx = json<{ handler?: string; change?: Change; title?: string; runTitle?: string; reason?: string; name?: string }>(row?.context ?? null, {});
  if (!row || ctx.handler !== BEHAVIOR_CHANGE || !ctx.change) return null;
  const { change } = ctx;
  // Cards sent before these fields were stored: the title and reason are in the question text.
  const title = ctx.title ?? row.question.split(/\n[ \t]*\n/)[0].trim();
  const reason = ctx.reason ?? /^原因：(.*)$/m.exec(row.question)?.[1]?.replace(/（合并 \d+ 次运行的改动）$/, "") ?? null;
  return {
    title, runTitle: ctx.runTitle ?? null, reason, runs: change.runIds.length, explicit: change.explicit,
    target: { kind: change.target.kind, label: label[change.target.kind], name: ctx.name ?? change.target.id },
    current: currentLink(change),
    files: fileViews(change).map(({ path, name, status, counts, blocks }) => ({ path, name, status, format: code(path) ? "text" : "md", counts, blocks: blocks.map(({ kind, text, rewrite }) => ({ kind, text, ...(rewrite ? { rewrite } : {}) })) })),
  };
}

export function noteBehavior(ctx: Pick<ToolContext, "app" | "runId" | "actor" | "shadow">, target: Target, name: string, before: Snapshot | undefined, words: Words = {}, files: string[] = []) {
  if (!before || !ctx.runId) return;
  const { app, runId } = ctx;
  const after = snapshot(app, target, files);
  const delta = Object.fromEntries(Object.entries(after).filter(([p, v]) => v.text !== (before[p] ?? absent).text).map(([p, v]) => [p, { before: before[p] ?? absent, after: v }]));
  if (!Object.keys(delta).length) return;
  const key = `${target.kind}:${target.id}`;
  const prior = one<{ id: string; ask_id: string; context: string }>(app.db, `select n.id, a.id ask_id, a.context from notifications n join asks a on a.id=json_extract(n.context,'$.askId')
    where n.user_id='owner' and json_extract(n.context,'$.held')=1 and a.status='pending'
      and json_extract(a.context,'$.changeKey')=? order by n.at desc limit 1`, key);
  const old = prior && json<{ change?: Change }>(prior.context, {}).change;
  const explicit = wasRequested(app, runId, words.owner_request, target, name);
  const change: Change = { target, files: delta, runIds: [runId], explicit };
  // Don't merge across an intervening edit on the same file/setting (for example a manual edit).
  const merge = !!old && Object.entries(old.files).every(([p, d]) => (before[p] ?? fileText(app, p)).text === d.after.text);
  if (merge && old) {
    change.runIds = [...new Set([...old.runIds, runId])];
    change.explicit &&= old.explicit;
    change.files = { ...old.files, ...Object.fromEntries(Object.entries(delta).map(([p, d]) => [p, { ...d, before: old.files[p]?.before ?? d.before }])) };
    change.files = Object.fromEntries(Object.entries(change.files).filter(([, d]) => d.before.text !== d.after.text));
  }
  if (merge && prior) {
    cancelAsk(app, prior.ask_id, "已合并到更新的对照");
    // This notice has not left the outbox. Keep the cancelled action for history, not a second notice.
    run(app.db, "delete from notifications where id=? and json_extract(context,'$.held')=1", prior.id);
  }
  if (!Object.keys(change.files).length) return;
  const titleOfRun = one<{ title: string }>(app.db, "select title from runs where id=?", runId)?.title || "助手运行";
  const why = words.change_reason || (explicit ? words.owner_request : undefined) || "更新本次用到的做法";
  // A short, whole title: what and that it changed. Who and why go in the body.
  const what = `${label[target.kind]}「${oneline(name, 30)}」`;
  const whole = ["skill", "agent", "rule", "watch", "playbook"].includes(target.kind);
  const verb = whole && Object.values(change.files).every((d) => d.before.text === null) ? "新建了" : whole && Object.values(change.files).every((d) => d.after.text === null) ? "删除了" : null;
  const title = change.explicit ? `按你说的${verb ?? "改了"}${what}` : verb ? `${verb}${what}` : `${what}更新了`;
  const reason = oneline(redact(why), 400), runTitle = oneline(titleOfRun, 60);
  const intro = `${runTitle}：${reason}${change.runIds.length > 1 ? `（合并 ${change.runIds.length} 次运行的改动）` : ""}`;
  const ask = createAsk(app, { runId: null, conversationId: null, userId: OWNER, question: title, options: [{ label: "保留" }, { label: "撤回" }], allowText: false,
    context: { handler: BEHAVIOR_CHANGE, notificationOnly: true, changeKey: key, change, title, runTitle, reason, name } });
  // The web list opens in-app addresses; the Feishu card needs the full web address, or no link.
  const body = changeBody(ask.id, change, intro, (path) => path);
  const card = changeBody(ask.id, change, intro, (path) => {
    const link = path.startsWith("#/ui/") ? uiLink(app, ask.id) : webLink(app, path);
    return /^https?:/.test(link) ? link : null;
  });
  run(app.db, "update asks set question=? where id=?", `${title}\n\n${card}`, ask.id);
  notify(app, { title, body, askId: ask.id, runId, urgency: "later", link: `#/ui/${ask.id}` });
}

function verifyCurrent(app: App, change: Change) {
  const { target, files } = change;
  const prefix = `_skills/${target.id}/`;
  if (target.kind === "skill" && files[`${prefix}SKILL.md`]?.before.text === null &&
      listSkillFiles(app, target.id).some((f) => f.type === "file" && !files[`${prefix}${f.path}`]))
    throw new HttpError(409, "这个技能后来加过文件，不能撤回它的创建");
  for (const [p, { after }] of Object.entries(files)) {
    const current = p === "settings" || p === "playbook" ? storedPiece(app, target, p) : fileText(app, p).text;
    if (current !== after.text) throw new HttpError(409, "这份设置后来又改过，不能用这次撤回覆盖更新的内容");
  }
}

async function restore(app: App, { target, files }: Change) {
  if (target.kind === "rule") {
    const prior = files.settings.before.text;
    if (prior === null) deleteRule(app, target.id);
    else saveRule(app, JSON.parse(prior), "user", OWNER);
    for (const a of all<{ id: string }>(app.db, "select id from asks where status='pending' and json_extract(context,'$.handler')='rule-enable' and json_extract(context,'$.ruleId')=?", target.id))
      cancelAsk(app, a.id, "本人撤回了规则改动");
    return;
  }
  if (target.kind === "watch") {
    restoreContextRevision(app, target.id, JSON.parse(files.settings.before.text ?? "null"));
    return;
  }
  if (target.kind === "playbook") {
    const prior = json<ReturnType<typeof playbook>>(files.playbook.before.text, null);
    const current = playbook(app, target.id);
    if (prior) writeWorkFile(app, { spaceId: prior.space, path: prior.path, title: prior.title, text: prior.text });
    else if (current) deleteSource(app, current.id);
    return;
  }
  const paths: string[] = [];
  for (const [p, { before }] of Object.entries(files)) {
    const path = libraryPath(app, p);
    if (before.text === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      const fromGit = before.revision && /^[a-f0-9]{40,64}$/.test(before.revision) && git(app.libraryDir, ["show", `${before.revision}:${p}`]);
      if (!fromGit || !fromGit.ok || Buffer.from(fromGit.stdout).toString("base64") !== before.text || !git(app.libraryDir, ["restore", `--source=${before.revision}`, "--worktree", "--", p]).ok)
        writeFileSync(path, Buffer.from(before.text, "base64"));
    }
    paths.push(p);
  }
  commitLibrary(app.libraryDir, `user: undo agent change to ${target.kind} ${target.id}`, paths);
  if (target.kind === "skill-groups") (await import("./agent-skills.ts")).refreshAgentEntries(app);
}

registerAskHandler(BEHAVIOR_CHANGE, async (app, ask, ctx) => {
  const change = ctx.change as Change;
  let result = "已保留这次改动。";
  if (ask.choice === 1) {
    verifyCurrent(app, change);
    await restore(app, change);
    result = "本人撤回了这次改动。";
    const seen = new Set<string>();
    for (const id of change.runIds) {
      const conv = conversationOfRun(app, id);
      if (!conv || seen.has(conv) || !findThread(app, conv)) continue;
      seen.add(conv);
      addMessage(app, conv, "assistant", `${result} ${label[change.target.kind]}「${change.target.id}」已恢复到改动前。`, null, { record: true, behaviorReverted: id });
    }
  }
  run(app.db, "update asks set result=? where id=?", result, ask.id);
  run(app.db, "update notifications set read_at=coalesce(read_at, ?), context=json_remove(context,'$.held') where json_extract(context,'$.askId')=?", now(), ask.id);
}, (app, ask, ctx, by, answer) => {
  if (by !== OWNER || ask.userId !== OWNER) throw new HttpError(403, "只有本人可以保留或撤回");
  if (answer.choice !== 0 && answer.choice !== 1) throw new HttpError(400, "请选择保留或撤回");
  if (answer.choice === 1) verifyCurrent(app, ctx.change as Change);
});
