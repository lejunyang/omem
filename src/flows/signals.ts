import { checkPluginSignals, pluginSignalWaiting } from "./plugin-signals.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { git, gitAsync } from "../core/git.ts";
import { findSpace } from "../core/spaces.ts";
import { getRun } from "../agents/runs.ts";
import { codePatches, type AppliedTarget } from "../agents/code.ts";
import { workState } from "../agents/code-tasks.ts";
import type { WorktreeRef } from "../agents/worktree-index.ts";
import { listCheckpoints } from "../agents/code-tasks.ts";
import { getItem } from "../items/store.ts";
import { signalIdentity, describeStage, type FlowStage } from "./definitions.ts";
import { completeBySignal } from "./engine.ts";
import { findObject } from "./objects.ts";
import { getStage, itemFlow } from "./store.ts";
import { checkUnclaimedCommits } from "./commits.ts";

export type GitSignal = "git.pushed" | "git.merged";
type Observation = { at: string; outcome: string; keys: string };
type TargetKey = { space: string; branch: string | null; commits: string[] };
const signalOf = (d: FlowStage) => typeof d.done === "object" && "signal" in d.done ? d.done.signal : null;

function lastCheck(app: App, itemId: string, stageId: string, type: string, since: string) {
  return one<Observation>(app.db, "select at,outcome,keys from flow_signals where item_id=? and stage_id=? and type=? and at>=? order by id desc limit 1", itemId, stageId, type, since);
}
export function waitingSignal(app: App, itemId: string, d: FlowStage) {
  const type = signalOf(d);
  if (!type) return undefined;
  const s = getStage(app, itemId, d.id);
  if (s.state !== "doing" || itemFlow(app, itemId)?.endedAt) return undefined;
  if (type.includes(":")) return { ...pluginSignalWaiting(app, s, type), ...signalIdentity(type) };
  const last = lastCheck(app, itemId, d.id, type, s.enteredAt ?? s.since);
  return { type, ...signalIdentity(type), checkedAt: last?.at ?? null, note: last?.outcome ?? describeStage(d).done };
}

/** How many commits after the application are looked at for the one the patch went into. */
const MAX_CANDIDATES = 40;
/** One scan per tip: reading a commit's tree into an index is slow on a large repository. */
const scanned = new Map<string, string[]>();
/**
 * Resolve patch applications against commit trees using an isolated index, never the owner's index.
 * Asynchronous throughout: a tree of tens of thousands of files must not hold the main thread.
 */
async function patchCommit(path: string, base: string, tip: string, patch: string): Promise<string[]> {
  if (!patch.trim() || !(await gitAsync(path, ["merge-base", "--is-ancestor", base, tip], { timeoutMs: 15_000 })).ok) return [];
  const key = createHash("sha256").update(`${path}\n${base}\n${tip}\n${patch}`).digest("hex");
  const known = scanned.get(key);
  if (known) return known;
  const dir = mkdtempSync(join(tmpdir(), "omem-signal-"));
  try {
    const file = join(dir, "change.patch"), env = { GIT_INDEX_FILE: join(dir, "index") };
    writeFileSync(file, patch);
    const contains = async (commit: string) => (await gitAsync(path, ["read-tree", commit], { env, timeoutMs: 60_000 })).ok &&
      (await gitAsync(path, ["apply", "--cached", "--reverse", "--check", "--whitespace=nowarn", file], { env, timeoutMs: 60_000 })).ok;
    let found: string[] = [];
    // An already-present patch is not evidence that this delegation was committed.
    if (!(await contains(base))) {
      // The newest commits after the application, oldest of them first: the patch is committed soon after it is applied.
      const candidates = await gitAsync(path, ["rev-list", "--ancestry-path", `--max-count=${MAX_CANDIDATES}`, `${base}..${tip}`], { timeoutMs: 15_000 });
      if (candidates.ok) for (const commit of candidates.stdout.trim().split("\n").filter(Boolean).reverse()) if (await contains(commit)) { found = [commit]; break; }
    }
    if (scanned.size > 200) scanned.clear();
    scanned.set(key, found);
    return found;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function commitsOf(app: App, rootId: string, latestId: string, target: Omit<AppliedTarget, "path">, path: string): Promise<string[]> {
  const root = getRun(app, rootId), latest = getRun(app, latestId);
  const wt = (root.output.worktrees as WorktreeRef[] | undefined)?.find((w) => w.space === target.space);
  if (target.head) return /^[a-f0-9]{40,64}$/.test(target.head) ? [target.head] : [];
  // Older branch confirmations already recorded the exact pushed head; never follow a later branch tip.
  if (wt?.commits) {
    const pushed = (root.output.pushed as { space: string; head?: string }[] | undefined)?.find((p) => p.space === target.space)?.head;
    const checked = (latest.output.repos as { space: string; check?: { commit?: string } }[] | undefined)?.find((r) => r.space === target.space)?.check?.commit;
    if (pushed) return [pushed];
    if (checked && target.branch && (await gitAsync(path, ["merge-base", "--is-ancestor", checked, `refs/heads/${target.branch}`], { timeoutMs: 15_000 })).ok) return [checked];
  }
  const tip = target.branch && await gitAsync(path, ["rev-parse", "--verify", `refs/heads/${target.branch}^{commit}`], { timeoutMs: 15_000 });
  const base = target.base ?? (wt?.commits ? wt.diffBase : wt?.syncHead) ?? wt?.start ?? wt?.base;
  if (!tip || !tip.ok || !base) return [];
  const patch = codePatches(app, latestId, { storedOnly: true }).find((p) => p.space === target.space)?.patch;
  if (patch?.trim()) return patchCommit(path, base, tip.stdout.trim(), patch);
  // A sync-only application fast-forwards real commits without a patch.
  return wt?.syncHead && (await gitAsync(path, ["merge-base", "--is-ancestor", wt.syncHead, tip.stdout.trim()], { timeoutMs: 15_000 })).ok ? [wt.syncHead] : [];
}

function remoteRefs(path: string, remotes: string[], type: GitSignal, targetBranch?: string) {
  if (type === "git.merged" && !targetBranch) return remotes.flatMap((remote) => {
    // A single fetch can observe remote HEAD without an extra ls-remote round trip.
    const observed = `refs/flow-signals/${remote}/HEAD`;
    if (git(path, ["show-ref", "--verify", "--quiet", observed]).ok) return [observed];
    const head = git(path, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]).stdout.trim();
    return head ? [head] : [];
  });
  const refs = git(path, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]).stdout.trim().split("\n");
  return refs.filter((ref) => remotes.some((remote) => {
    const prefix = `refs/remotes/${remote}/`;
    if (!ref.startsWith(prefix) || ref === `${prefix}HEAD`) return false;
    if (type === "git.pushed") return true;
    return ref === `${prefix}${targetBranch}`;
  }));
}
/**
 * Whether every commit is in one of the refs. A repository can have thousands of remote branches,
 * so the refs are handed to one `for-each-ref --contains` per commit instead of one process per ref.
 */
async function contained(path: string, commits: string[], refs: string[]) {
  if (!refs.length) return false;
  // Many refs become their remotes' prefixes (a pattern matches everything under it): the command line stays short.
  const patterns = refs.length > 50 ? [...new Set(refs.map((r) => r.split("/").slice(0, 3).join("/")))] : refs;
  for (const commit of commits) {
    const r = await gitAsync(path, ["for-each-ref", "--count=1", "--contains", commit, "--format=%(refname)", ...patterns], { timeoutMs: 30_000 });
    if (!r.ok || !r.stdout.trim()) return false;
  }
  return true;
}

/** At most one network attempt per repository in ten minutes, shared by all waiting stages. */
async function refreshRemote(app: App, path: string, remotes: string[], defaultNeeded: boolean, branch?: string) {
  const common = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
  const key = `flow-git-checked:${createHash("sha256").update(common).digest("hex")}`;
  const previous = one<{ value: string }>(app.db, "select value from kv where key=?", key)?.value;
  if (previous && Date.now() - Date.parse(previous) < 600_000) return;
  run(app.db, "insert or replace into kv(key,value) values(?,?)", key, new Date().toISOString());
  const cursorKey = key.replace("flow-git-checked:", "flow-git-next-remote:");
  const savedCursor = Number(one<{ value: string }>(app.db, "select value from kv where key=?", cursorKey)?.value ?? 0);
  const cursor = Number.isSafeInteger(savedCursor) && savedCursor >= 0 ? savedCursor : 0;
  const ordered = [...remotes].sort((a, b) => Number(b === "origin") - Number(a === "origin") || a.localeCompare(b));
  const remote = ordered[cursor % ordered.length];
  run(app.db, "insert or replace into kv(key,value) values(?,?)", cursorKey, String(cursor + 1));
  // One command, one remote per repository per interval. Multiple remotes take turns.
  await gitAsync(path, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", remote,
    branch ? `+refs/heads/${branch}:refs/remotes/${remote}/${branch}` : `+refs/heads/*:refs/remotes/${remote}/*`, ...(defaultNeeded ? [`+HEAD:refs/flow-signals/${remote}/HEAD`] : [])], { timeoutMs: 15_000 });
}

const checks = new WeakMap<App, Promise<void>>();
export async function checkGitSignalsAfterPush(app: App) {
  // A patrol already reading refs may have observed the branch before the push.
  await checks.get(app)?.catch(() => {});
  await checkGitSignals(app);
}

export function checkGitSignals(app: App): Promise<void> {
  const active = checks.get(app);
  if (active) return active;
  const check = checkNow(app).then(() => checkUnclaimedCommits(app)).finally(() => { checks.delete(app); });
  checks.set(app, check);
  return check;
}
async function checkNow(app: App) {
  // Piggyback on patrol/repository checks; no timer or projection is needed.
  run(app.db, "delete from flow_signals where at<?", new Date(Date.now() - 30 * 86400_000).toISOString());
  const rows = all<{ item_id: string; stage_id: string; signal: string }>(app.db, `select s.item_id,s.stage_id,
    json_extract(d.value,'$.done.signal') as signal from item_stages s join item_flows f on f.item_id=s.item_id,
    json_each(f.definition,'$.stages') d where s.state='doing' and f.ended_at is null and json_extract(d.value,'$.id')=s.stage_id
    and signal is not null order by s.item_id,s.stage_id`);
  checkPluginSignals(app, rows.filter(row => row.signal.includes(":")));
  for (const row of rows) {
    if (row.signal.includes(":")) continue;
    const { item_id: itemId, stage_id: stageId } = row;
    const f = itemFlow(app, itemId);
    if (!f || f.endedAt) continue;
    const d = f.definition.stages.find((s) => s.id === stageId);
    if (!d) continue;
    const type = signalOf(d);
    if (!type) continue;
    const s = getStage(app, itemId, stageId), since = s.enteredAt ?? s.since;
    if (s.state !== "doing") continue;
    if (type !== "git.pushed" && type !== "git.merged") continue;
    const checked = await inspectGitSignal(app, itemId, type);
    const { object, note, evidence } = checked;
    const currentFlow = itemFlow(app, itemId);
    if (!currentFlow || currentFlow.endedAt || currentFlow.startedAt !== f.startedAt) continue;
    const current = getStage(app, itemId, stageId);
    if (current.state !== "doing" || current.attempt !== s.attempt || current.enteredAt !== s.enteredAt) continue;
    if (checked.ready && !await completeBySignal(app, itemId, stageId, note, evidence, { startedAt: f.startedAt, attempt: s.attempt, enteredAt: s.enteredAt, type, work: object!.ref, current: () => findObject(app, getItem(app, itemId), "code-work")?.link === object!.link })) continue;
    recordGitSignal(app, itemId, stageId, type, since, checked);
  }
}

export function recordGitSignal(app: App, itemId: string, stageId: string, type: GitSignal, since: string, { keys, note }: Awaited<ReturnType<typeof inspectGitSignal>>) {
  const encoded = JSON.stringify(keys), last = lastCheck(app, itemId, stageId, type, since);
  if (last?.outcome !== note || last.keys !== encoded) run(app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,?,?,?,?,?)", new Date().toISOString(), type, encoded, itemId, stageId, note);
}

export async function inspectGitSignal(app: App, itemId: string, type: GitSignal, fetch = true) {
  const object = findObject(app, getItem(app, itemId), "code-work");
  const keys: TargetKey[] = [], missing: string[] = [], evidence: string[] = [];
  if (!object) return { object, keys, note: "没有关联的编码交办，继续等本人", evidence, ready: false };
  const rootId = object.ref.slice("code-work:".length), root = getRun(app, rootId);
  const latestId = object.link.slice("#/runs/".length), latest = getRun(app, latestId);
  const applied = root.output.appliedAt ? root : latest.output.appliedAt ? latest : null;
  const worktrees = (root.output.worktrees ?? []) as WorktreeRef[];
  const heads = !applied && object.done ? listCheckpoints(app, rootId).findLast(checkpoint => checkpoint.by === latestId)?.heads : undefined;
  const branches = worktrees.filter(wt => wt.commits && wt.branch);
  const checkedRepos = (latest.output.repos ?? []) as { space: string; check?: { commit?: string } }[];
  const checkedBranches = !applied && object.done ? branches.map(wt => ({ space: wt.space, branch: wt.branch!, head: heads?.[wt.space] ?? checkedRepos.find(repo => repo.space === wt.space)?.check?.commit })) : [];
  // A batch pushed while the work goes on (code-delivery.ts) is what the owner asked to see on the remote.
  const delivered = !applied && type === "git.pushed" ? workState(app, rootId).delivered?.at(-1)?.branches : undefined;
  // The owner pushed the branch themselves (code-branch.ts settles the work as pushed outside): nothing
  // was applied through omem, and the heads seen on the remote then are what to look for.
  const outside = applied && !applied.output.appliedTo ? [...new Map(((applied.output.pushed ?? []) as { space: string; branch: string | null; head?: string }[])
    .filter(pushed => pushed.head).map(pushed => [pushed.space, { space: pushed.space, branch: pushed.branch, head: pushed.head }])).values()] : [];
  const targets = (applied?.output.appliedTo as AppliedTarget[] | undefined) ?? (outside.length ? outside
    : checkedBranches.length && checkedBranches.every(target => target.head) ? checkedBranches : delivered ?? []);
  evidence.push(rootId, ...(latestId !== rootId ? [latestId] : []));
  if (!targets.length) return { object, keys, note: "编码交办还没应用到仓库，继续等本人", evidence, ready: false };
  for (const target of targets) {
    const path = findSpace(app, target.space)?.rootPath;
    if (!path || !existsSync(path)) { keys.push({ space: target.space, branch: target.branch, commits: [] }); missing.push(`${target.space}：本机没有仓库`); continue; }
    const commits = await commitsOf(app, rootId, latestId, target, path);
    keys.push({ space: target.space, branch: target.branch, commits });
    if (!commits.length) { missing.push(`${target.space}：还没有能核对的应用提交`); continue; }
    const remotes = git(path, ["remote"]).stdout.trim().split("\n").filter(Boolean);
    if (!remotes.length) { missing.push(`${target.space}：仓库没有远端`); continue; }
    const wt = worktrees.find(w => w.space === target.space);
    const targetBranch = wt?.commits ? wt.cutFrom : target.branch ?? undefined;
    let refs = remoteRefs(path, remotes, type, targetBranch);
    let hasCommits = await contained(path, commits, refs);
    if (fetch && !hasCommits) {
      await refreshRemote(app, path, remotes, type === "git.merged" && !targetBranch, type === "git.merged" ? targetBranch : target.branch ?? undefined);
      refs = remoteRefs(path, remotes, type, targetBranch);
      hasCommits = await contained(path, commits, refs);
    }
    if (!hasCommits) missing.push(`${target.space}@${target.branch ?? "游离 HEAD"}：提交还没在${type === "git.merged" ? "目标分支的远端" : "远端"}引用里`);
  }
  const ready = !missing.length;
  const note = ready ? `改动已${type === "git.merged" ? "合进目标分支" : "在远端"}：${keys.map(k => `${k.space}@${k.branch ?? "游离 HEAD"}（${k.commits.map(c => c.slice(0, 7)).join("、")}）`).join("；")}` : `还在等：${missing.join("；")}`;
  return { object, keys, note, evidence, ready };
}
