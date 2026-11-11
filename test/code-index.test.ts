import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { branchSpaceId, indexBranch, runOverlaySpaces, worktreeSpacesOf } from "../src/agents/worktree-index.ts";
import { all, one, run as sql } from "../src/core/db.ts";
import { createSpace, findSpace, getSpace, updateSpace } from "../src/core/spaces.ts";
import { search } from "../src/search/search.ts";
import { syncBaselineLocally } from "../src/sources/code-baseline.ts";
import { adoptRepoSyncDefault, codeVersion, expireOverlays, OVERLAY_DAYS, refreshRepoSpaces } from "../src/sources/code-index.ts";
import { syncDirectoryLocally } from "../src/sources/import.ts";
import { upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env });
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `omem-ci-${name}-`));

/** A bare “remote” with main, a checkout of it omem indexes, and a second checkout someone else pushes from. */
function remoteRepo(files: Record<string, string>) {
  const seed = tmp("seed");
  sh(seed, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(seed, f, ".."), { recursive: true });
    writeFileSync(join(seed, f), text);
  }
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "init");
  const bare = join(tmp("bare"), "shop.git");
  sh(seed, "clone", "-q", "--bare", seed, bare);
  const local = join(tmp("local"), "shop");
  sh(tmpdir(), "clone", "-q", bare, local);
  const other = join(tmp("other"), "shop");
  sh(tmpdir(), "clone", "-q", bare, other);
  return { bare, local, other };
}

function push(dir: string, files: Record<string, string>, message = "change") {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  sh(dir, "push", "-q", "origin", "HEAD:main");
}

const textOf = (space: string, uri: string) => one<{ id: string; text: string; deleted_at: string | null }>(app.db, "select id, text, deleted_at from sources where space_id = ? and uri = ?", space, uri);
const ctxFor = (over: Partial<ToolContext> = {}): ToolContext => ({ app, runId: null, spaceId: "shop", spaces: null, tools: null, actor: "agent", ...over });

describe("a repository indexed from its baseline", () => {
  const { local, other } = remoteRepo({
    "src/order.ts": "export function orderTotal() {\n  return 1;\n}\n",
    "src/refund.ts": "export function refundPolicy() {\n  return 'mainline';\n}\n",
    "README.md": "# 商城\n",
  });
  createSpace(app, { id: "shop", name: "商城", kind: "repo", rootPath: local });

  it("starts on the baseline for a new space with origin, and the working tree does not leak into it", async () => {
    const first = await syncDirectoryLocally(app, "shop");
    expect(first.created).toBe(3);
    const s = getSpace(app, "shop");
    expect((s.settings.codeIndex as { mode: string }).mode).toBe("baseline");
    const state = s.settings.codeIndexState as { mode: string; ref: string; commit: string };
    expect(state).toMatchObject({ mode: "baseline", ref: "origin/main" });
    expect(state.commit).toBe(sh(local, "rev-parse", "origin/main").trim());
    const refundId = textOf("shop", "src/refund.ts")!.id;

    // The directory moves to a feature branch, with a commit, an uncommitted change and an untracked file.
    sh(local, "checkout", "-q", "-b", "feature/refund");
    writeFileSync(join(local, "src/refund.ts"), "export function refundPolicy() {\n  return 'featureOnlyRule';\n}\n");
    sh(local, "commit", "-qam", "feature");
    writeFileSync(join(local, "src/order.ts"), "export function orderTotal() {\n  return uncommittedTotal;\n}\n");
    writeFileSync(join(local, "src/scratch.ts"), "export const scratchOnly = 1;\n");

    const again = await syncBaselineLocally(app, "shop", undefined, { force: true });
    expect(again).toMatchObject({ created: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(textOf("shop", "src/refund.ts")!.text).toContain("mainline");
    expect(textOf("shop", "src/order.ts")!.text).not.toContain("uncommittedTotal");
    expect(textOf("shop", "src/scratch.ts")).toBeUndefined();
    expect((await search(app, "featureOnlyRule", { spaces: ["shop"] })).some((h) => h.snippet.includes("featureOnlyRule"))).toBe(false);
    // Same source id: citations keep working.
    expect(textOf("shop", "src/refund.ts")!.id).toBe(refundId);
  });

  it("fetches, and reads only the files that changed between the two commits", async () => {
    const before = all<{ uri: string; updated_at: string }>(app.db, "select uri, updated_at from sources where space_id = 'shop'");
    const refundId = textOf("shop", "src/refund.ts")!.id;
    push(other, { "src/refund.ts": "export function refundPolicy() {\n  return 'pushedRule';\n}\n" });
    sh(other, "rm", "-q", "README.md");
    sh(other, "commit", "-qm", "drop readme");
    sh(other, "push", "-q", "origin", "HEAD:main");

    const r = await refreshRepoSpaces(app, { spaces: ["shop"] });
    expect(r.fetches).toBe(1);
    expect(r.spaces[0]).toMatchObject({ id: "shop", fetched: true, synced: true });
    expect(one(app.db, "select 1 from runs where kind = 'sync' and space_id = 'shop' and status = 'queued'")).toBeTruthy();
    sql(app.db, "update runs set status = 'done' where kind = 'sync' and space_id = 'shop'");

    const report = await syncBaselineLocally(app, "shop");
    expect(report).toMatchObject({ created: 0, updated: 1, removed: 1, unchanged: 1 });
    expect(textOf("shop", "src/refund.ts")).toMatchObject({ id: refundId, deleted_at: null });
    expect(textOf("shop", "src/refund.ts")!.text).toContain("pushedRule");
    expect(textOf("shop", "README.md")!.deleted_at).toBeTruthy();
    const order = before.find((b) => b.uri === "src/order.ts")!;
    expect(textOf("shop", "src/order.ts")).toBeTruthy();
    expect(one<{ updated_at: string }>(app.db, "select updated_at from sources where space_id = 'shop' and uri = 'src/order.ts'")!.updated_at).toBe(order.updated_at);

    // Nothing new: no sync is queued, the fetch is all it costs.
    const quiet = await refreshRepoSpaces(app, { spaces: ["shop"] });
    expect(quiet.spaces[0]).toMatchObject({ synced: false, reason: "没有变化" });
    expect(one(app.db, "select 1 from runs where kind = 'sync' and space_id = 'shop' and status = 'queued'")).toBeUndefined();
    expect(codeVersion(app, "shop")).toMatch(/^基线 origin\/main 的提交 [0-9a-f]{8}/);
  });

  it("records a failed fetch on the space", async () => {
    const before = sh(local, "remote", "get-url", "origin").trim();
    sh(local, "remote", "set-url", "origin", join(tmpdir(), "omem-ci-missing", "nothing.git"));
    try {
      const r = await refreshRepoSpaces(app, { spaces: ["shop"] });
      expect(r.spaces[0].fetched).toBe(false);
      const st = getSpace(app, "shop").settings.codeIndexState as { error?: string; errorAt?: string };
      expect(st.error).toMatch(/拉取失败/);
      expect(st.errorAt).toBeTruthy();
    } finally {
      sh(local, "remote", "set-url", "origin", before);
    }
    await refreshRepoSpaces(app, { spaces: ["shop"] });
    expect((getSpace(app, "shop").settings.codeIndexState as { error?: string | null }).error).toBeNull();
    sql(app.db, "update runs set status = 'done' where kind = 'sync' and space_id = 'shop'");
  });

  it("searches only the baseline unless a branch is named or the run belongs to that delegation", async () => {
    sh(local, "push", "-q", "origin", "feature/refund");
    const idx = await indexBranch(app, "shop", "feature/refund");
    expect(idx.space).toBe(branchSpaceId("shop", "feature/refund"));
    // The feature commit is the only change on the branch relative to the baseline it left.
    expect(idx.files).toBe(1);
    // Searching everything: no branch index.
    expect((await search(app, "featureOnlyRule")).some((h) => h.spaceId === idx.space)).toBe(false);
    expect((await search(app, "featureOnlyRule", { spaces: ["shop"] })).some((h) => h.snippet.includes("featureOnlyRule"))).toBe(false);
    // Naming the branch: its version stands in for the repository's.
    const onBranch = await callTool(ctxFor(), "search", { query: "refundPolicy", space: "shop", branch: "feature/refund" });
    expect(onBranch.text).toContain(idx.space);
    // The default tool search says where the code comes from.
    const plain = await callTool(ctxFor(), "search", { query: "refundPolicy", space: "*" });
    expect(plain.text).toMatch(/代码来自：\n- shop：基线 origin\/main 的提交/);
    expect(plain.text).not.toContain(idx.space);
    const read = await callTool(ctxFor(), "read_source", { source: textOf("shop", "src/refund.ts")!.id });
    expect(read.text).toMatch(/代码来自：基线 origin\/main/);

    // A delegation's worktree index, every round's, is searched by that delegation's own runs only.
    const first = createRun(app, { kind: "code", spaceId: "shop", title: "退款", input: { task: "退款" } });
    const second = createRun(app, { kind: "code", spaceId: "shop", title: "退款（续）", input: { task: "退款", continueFrom: first.id } });
    const wt = `wt-${second.id}-shop`;
    sql(app.db, "insert into spaces(id,name,kind,description,root_path,settings,created_at,updated_at) values(?,?,'worktree','',null,?,datetime('now'),datetime('now'))", wt, "交办", JSON.stringify({ runId: second.id, repo: "shop", path: local, base: "x", deleted: [] }));
    upsertSource(app, { spaceId: wt, kind: "code", uri: "src/delegated.ts", title: "src/delegated.ts", text: "export const delegatedOnlyName = 1;\n" });
    expect(worktreeSpacesOf(app, first.id).map((s) => s.id)).toEqual([wt]);
    const review = createRun(app, { kind: "review", spaceId: "shop", title: "评审", parentId: second.id });
    expect(runOverlaySpaces(app, review.id)).toEqual([wt]);
    const mine = await callTool(ctxFor({ runId: review.id }), "search", { query: "delegatedOnlyName", space: "shop" });
    expect(mine.text).toContain("src/delegated.ts");
    const theirs = await callTool(ctxFor(), "search", { query: "delegatedOnlyName", space: "shop" });
    expect(theirs.text).not.toContain("src/delegated.ts");
    expect((await search(app, "delegatedOnlyName")).some((h) => h.spaceId === wt)).toBe(false);
  });

  it("expires overlays: applied delegations at once, sha indexes after days unused, followed branches stay", async () => {
    const sha = sh(local, "rev-parse", "feature/refund").trim();
    const bySha = await indexBranch(app, "shop", sha);
    const old = new Date(Date.now() - (OVERLAY_DAYS.sha + 1) * 86400_000).toISOString();
    sql(app.db, "update spaces set settings = json_set(settings, '$.usedAt', ?) where id = ?", old, bySha.space);
    updateSpace(app, "shop", { settings: { ...getSpace(app, "shop").settings, codeIndex: { mode: "baseline", branches: ["feature/refund"] } } });
    sql(app.db, "update spaces set settings = json_set(settings, '$.usedAt', ?) where id = ?", new Date(Date.now() - 90 * 86400_000).toISOString(), branchSpaceId("shop", "feature/refund"));
    const first = one<{ id: string }>(app.db, "select id from runs where kind = 'code' and json_extract(input, '$.continueFrom') is null and space_id = 'shop'")!.id;
    expect((await expireOverlays(app)).dropped).toEqual([bySha.space]);
    // Applied: its worktree indexes go even though the worktree path is still there.
    setRunOutput(app, first, { appliedAt: new Date().toISOString() });
    const r = await expireOverlays(app);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatch(/^wt-/);
    expect(findSpace(app, branchSpaceId("shop", "feature/refund"))).toBeTruthy();
    // Unfollowed and unused for long: gone too.
    updateSpace(app, "shop", { settings: { ...getSpace(app, "shop").settings, codeIndex: { mode: "baseline" } } });
    expect((await expireOverlays(app)).dropped).toEqual([branchSpaceId("shop", "feature/refund")]);
  });
});

describe("folders of one repository and the directory mode", () => {
  it("fetches a repository once for all its spaces and indexes each folder with paths relative to it", async () => {
    const { local, other } = remoteRepo({ "web/app.ts": "export const webApp = 1;\n", "api/server.ts": "export const apiServer = 1;\n" });
    createSpace(app, { id: "mono-web", name: "前端", kind: "repo", rootPath: join(local, "web") });
    createSpace(app, { id: "mono-api", name: "后端", kind: "repo", rootPath: join(local, "api") });
    await syncDirectoryLocally(app, "mono-web");
    await syncDirectoryLocally(app, "mono-api");
    expect(all<{ uri: string }>(app.db, "select uri from sources where space_id = 'mono-web'").map((r) => r.uri)).toEqual(["app.ts"]);
    expect(all<{ uri: string }>(app.db, "select uri from sources where space_id = 'mono-api'").map((r) => r.uri)).toEqual(["server.ts"]);
    push(other, { "web/app.ts": "export const webApp = 2;\n" });
    const r = await refreshRepoSpaces(app, { spaces: ["mono-web", "mono-api"] });
    expect(r.fetches).toBe(1);
    sql(app.db, "update runs set status = 'done' where kind = 'sync'");
    expect(await syncBaselineLocally(app, "mono-web")).toMatchObject({ updated: 1, unchanged: 0 });
    expect(await syncBaselineLocally(app, "mono-api")).toMatchObject({ updated: 0, unchanged: 1 });
    // A followed branch that exists only here does not fail the fetch; nothing moved means no fetch at all.
    sh(local, "branch", "only-here", "origin/main");
    updateSpace(app, "mono-web", { settings: { ...getSpace(app, "mono-web").settings, codeIndex: { mode: "baseline", branches: ["only-here"] } } });
    expect(await refreshRepoSpaces(app, { spaces: ["mono-web", "mono-api"] })).toMatchObject({ fetches: 0 });
    push(other, { "web/app.ts": "export const webApp = 3;\n" });
    const again = await refreshRepoSpaces(app, { spaces: ["mono-web", "mono-api"] });
    expect(again.fetches).toBe(1);
    expect(again.spaces.every((s) => s.fetched && !s.error)).toBe(true);
    expect((getSpace(app, "mono-web").settings.codeIndexState as { branchErrors?: unknown }).branchErrors).toBeUndefined();
    expect(findSpace(app, branchSpaceId("mono-web", "only-here"))).toBeTruthy();
    sql(app.db, "update runs set status = 'done' where kind = 'sync'");
  });

  it("keeps an existing space on its directory until switched, then keeps the source ids", async () => {
    const dir = tmp("plain");
    sh(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "init");
    createSpace(app, { id: "plain", name: "本地仓库", kind: "repo", rootPath: dir });
    await syncDirectoryLocally(app, "plain");
    const st = getSpace(app, "plain").settings.codeIndexState as { mode: string; ref: string; dirty: boolean };
    expect(st).toMatchObject({ mode: "directory", ref: "main", dirty: false });
    expect(codeVersion(app, "plain")).toMatch(/^按目录索引：当时检出 main/);
    const id = textOf("plain", "a.ts")!.id;
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    await syncDirectoryLocally(app, "plain");
    expect(textOf("plain", "a.ts")!.text).toContain("= 2");
    // Switched to a baseline (no origin: the local main): the committed text, same id.
    updateSpace(app, "plain", { settings: { ...getSpace(app, "plain").settings, codeIndex: { mode: "baseline", ref: "main" } } });
    await syncDirectoryLocally(app, "plain");
    expect(textOf("plain", "a.ts")).toMatchObject({ id, deleted_at: null });
    expect(textOf("plain", "a.ts")!.text).toContain("= 1");
  });

  it("turns repo-sync on once for a library that never ran it", () => {
    sql(app.db, "insert or ignore into schedules(id,kind,cron,config,enabled) values('repo-sync','repo-sync','0 * * * *','{}',0)");
    sql(app.db, "update schedules set enabled = 0, last_run_at = null where id = 'repo-sync'");
    expect(adoptRepoSyncDefault(app)).toBe(true);
    expect(one<{ enabled: number }>(app.db, "select enabled from schedules where id = 'repo-sync'")!.enabled).toBe(1);
    sql(app.db, "update schedules set enabled = 0 where id = 'repo-sync'");
    expect(adoptRepoSyncDefault(app)).toBe(false);
  });
});

describe("the change notification", () => {
  it("needs the hook token, and fetches the repository it names", async () => {
    const { local, bare, other } = remoteRepo({ "lib.ts": "export const libValue = 1;\n" });
    createSpace(app, { id: "hooked", name: "被通知的仓库", kind: "repo", rootPath: local });
    await syncDirectoryLocally(app, "hooked");
    sh(local, "remote", "add", "upstream", "https://code.example.com/team/hooked.git");
    const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
    const ownerToken = app.config.token;
    app.config.token = "owner-secret";
    try {
      const notify = (body: object, headers: Record<string, string> = {}) =>
        fetch(`${app.baseUrl}/api/code-index/notify`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      expect((await notify({ space: "hooked" })).status).toBe(401);
      expect((await notify({ space: "hooked" }, { authorization: "Bearer omh_wrong" })).status).toBe(401);
      const made = await fetch(`${app.baseUrl}/api/code-index/hook`, { method: "POST", headers: { authorization: "Bearer owner-secret" } });
      const { token } = (await made.json()) as { token: string };
      expect(token).toMatch(/^omh_/);
      // The hook token does nothing else.
      expect((await fetch(`${app.baseUrl}/api/spaces`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
      push(other, { "lib.ts": "export const libValue = 2;\n" });
      const res = await notify({ repo: "git@code.example.com:team/hooked.git", ref: "refs/heads/main" }, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ spaces: ["hooked"], queued: true });
      for (let i = 0; i < 100 && !one(app.db, "select 1 from runs where kind = 'sync' and space_id = 'hooked' and status = 'queued'"); i++) await new Promise((r) => setTimeout(r, 50));
      expect(sh(local, "rev-parse", "origin/main").trim()).toBe(sh(bare, "rev-parse", "main").trim());
      expect(one(app.db, "select 1 from runs where kind = 'sync' and space_id = 'hooked' and status = 'queued'")).toBeTruthy();
      const none = await notify({ repo: "https://code.example.com/team/other.git" }, { "x-omem-token": token });
      expect(none.status).toBe(200);
      expect(await none.json()).toMatchObject({ spaces: [], queued: false });
    } finally {
      app.config.token = ownerToken;
      await server.close();
    }
  });
});
