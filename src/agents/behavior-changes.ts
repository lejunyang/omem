import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { commitLibrary, git } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { findRule, saveRule, deleteRule } from "../rules/store.ts";
import { contextRevision, getContext, restoreContextRevision } from "../channels/listen.ts";
import { playbookPath } from "../channels/listen-cases.ts";
import { workUri, writeWorkFile } from "../sources/work.ts";
import { deleteSource } from "../sources/store.ts";
import { addMessage, findThread } from "./threads.ts";
import { listSkillFiles } from "./specs.ts";
import { cancelAsk, conversationOfRun, createAsk, registerAskHandler } from "./asks.ts";
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
function difference(a: string[], b: string[]) {
  const count = new Map<string, number>();
  for (const line of b) count.set(line, (count.get(line) ?? 0) + 1);
  return a.filter((line) => {
    const n = count.get(line) ?? 0;
    if (n) count.set(line, n - 1);
    return !n;
  });
}
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
function diffBody(files: Change["files"]) {
  return truncate(Object.entries(files).filter(([path]) => !path.startsWith("_roles/.base/")).map(([path, { before, after }]) => {
    const old = paragraphs(display(before, path)), next = paragraphs(display(after, path));
    const removed = difference(old, next), added = difference(next, old);
    const side = (lines: string[], sign: string) => lines.slice(0, 4).map((p) => `${sign} ${oneline(p, 150)}`).concat(lines.length > 4 ? [`…另有 ${lines.length - 4} 段`] : []).join("\n");
    const text = [side(removed, "−"), side(added, "+")].filter(Boolean).join("\n") || "段落顺序、格式或省略的内容有变化。";
    return `${path === "settings" ? "设置" : path === "playbook" ? "经验" : oneline(path, 100)}\n\n    ${text.replace(/\n/g, "\n    ")}`;
  }).join("\n\n"), 1800);
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
  const title = `${oneline(titleOfRun, 35)}：${change.explicit ? "按你说的改成了这样" : "改了"} · ${label[target.kind]}「${oneline(name, 30)}」 · ${oneline(redact(why), 32)}`;
  const body = `原因：${oneline(redact(why), 180)}${change.runIds.length > 1 ? `（合并 ${change.runIds.length} 次运行的改动）` : ""}\n\n${diffBody(change.files)}`;
  const ask = createAsk(app, { runId: null, conversationId: null, userId: OWNER, question: `${title}\n\n${body}`, options: [{ label: "保留" }, { label: "撤回" }], allowText: false,
    context: { handler: BEHAVIOR_CHANGE, notificationOnly: true, changeKey: key, change } });
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
