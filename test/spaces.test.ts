import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { repositoryUrl } from "../src/core/repositories.ts";
import { getSpace, listSpaces } from "../src/core/spaces.ts";
import { listSources } from "../src/sources/store.ts";
import { importText, syncDirectorySpace } from "../src/sources/import.ts";
import { testApp } from "./helpers.ts";
import { pageContext, writePage } from "../src/wiki/store.ts";

const app = testApp();
const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
const root = mkdtempSync(join(tmpdir(), "omem-repository-"));
const repo = join(root, "example");
mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main", repo]);
writeFileSync(join(repo, "example.ts"), "export const example = 42;\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
afterAll(() => app.db.close());

it("resolves cross-space wiki links and backlinks without false missing-page reports", async () => {
  await callTool(ctx, "create_space", { id: "wiki-repo", name: "代码知识" });
  writePage(app, "wiki-repo", "entry", { meta: { title: "入口" }, body: "代码说明" });
  writePage(app, "personal", "project-entry", { meta: { title: "项目入口" }, body: "[[wiki-repo:entry]] [[wiki-repo:missing]]" });
  expect(pageContext(app, "personal", "project-entry").missingLinks).toEqual(["wiki-repo/missing"]);
  expect(pageContext(app, "wiki-repo", "entry").backlinks).toContainEqual({ spaceId: "personal", slug: "project-entry", title: "项目入口" });
});

it("creates idempotently, rejects conflicts and caller scope before writes", async () => {
  expect((await callTool(ctx, "create_space", { id: "project", name: "项目", kind: "project" })).isError).toBe(false);
  expect((await callTool(ctx, "create_space", { id: "project", name: "项目", kind: "project" })).text).toContain("已存在");
  expect((await callTool(ctx, "create_space", { id: "project", name: "不同" })).isError).toBe(true);
  for (const restricted of [{ ...ctx, spaces: ["personal"] }, { ...ctx, userId: "stranger" }]) {
    expect((await callTool(restricted, "create_space", { name: "禁止" })).isError).toBe(true);
    expect((await callTool(restricted, "connect_repository", { repository: repo })).isError).toBe(true);
  }
  expect(listSpaces(app).length).toBe(3);
});

it("attaches to a project, reuses canonical roots and preserves other materials", async () => {
  const doc = importText(app, "project", { text: "项目约定", kind: "doc", uri: "https://example.com/prd" });
  const localDoc = importText(app, "project", { text: "其他文档", kind: "doc", uri: "design.md" });
  expect((await callTool(ctx, "connect_repository", { repository: repo, space: "project" })).isError).toBe(false);
  expect(getSpace(app, "project").rootPath).toBe(realpathSync(repo)); // canonical: tmpdir is a symlink on macOS
  const alias = join(root, "alias");
  symlinkSync(repo, alias);
  mkdirSync(join(repo, "subdir"));
  for (const path of [repo, alias, join(repo, "subdir")]) {
    const result = await callTool(ctx, "connect_repository", { repository: path });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("空间 project");
  }
  rmSync(join(repo, "example.ts"));
  await syncDirectorySpace(app, "project");
  const sources = listSources(app, { spaceId: "project" }).sources;
  expect(sources.map((s) => s.id)).toEqual(expect.arrayContaining([doc.id, localDoc.id]));
  expect(sources.some((s) => s.uri === "example.ts")).toBe(false);
  expect(listSpaces(app).length).toBe(3);
  expect((await callTool(ctx, "connect_repository", { repository: root })).isError).toBe(true);
});

it("rejects dangerous or credential-bearing transports", () => {
  for (const url of ["file:///tmp/x", "ext::sh -c bad", "--upload-pack=bad", "https://user:secret@example.com/repo.git", "https://token@example.com/repo.git", "https://example.com/repo?token=secret"])
    expect(() => repositoryUrl(url)).toThrow();
  expect(repositoryUrl("git@example.com:team/repo.git")).toBe("git@example.com:team/repo.git");
  expect(repositoryUrl("ssh://git@example.com/team/repo.git")).toContain("ssh://");
});

it("rejects same-name materials before changing a project's association", async () => {
  await callTool(ctx, "create_space", { id: "collision", name: "同名文档项目", kind: "project" });
  importText(app, "collision", { text: "独立材料", uri: "example.ts", kind: "doc" });
  const other = join(root, "other");
  execFileSync("git", ["clone", "--no-hardlinks", "-q", repo, other]);
  const result = await callTool(ctx, "connect_repository", { repository: other, space: "collision" });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("同名");
  expect(getSpace(app, "collision").rootPath).toBeNull();
});

it("clones HTTP links under omem home, reuses concurrent requests and does not register failures", async () => {
  const bare = join(root, "bare.git");
  execFileSync("git", ["clone", "--bare", "-q", repo, bare]);
  execFileSync("git", ["--git-dir", bare, "update-server-info"]);
  const server = createServer((req, res) => {
    const file = join(bare, new URL(req.url!, "http://localhost").pathname);
    const stream = createReadStream(file);
    stream.on("error", () => { res.statusCode = 404; res.end(); });
    stream.pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const input = { repository: `http://127.0.0.1:${port}/`, id: "remote", name: "远程仓库" };
    const results = await Promise.all([callTool(ctx, "connect_repository", input), callTool(ctx, "connect_repository", input)]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(getSpace(app, "remote").rootPath).toContain(join(app.home, "repos"));
    expect(listSources(app, { spaceId: "remote" }).sources.some((s) => s.uri === "example.ts")).toBe(true);
    expect((await callTool(ctx, "connect_repository", { ...input, space: "project", id: undefined })).isError).toBe(true);
    const count = listSpaces(app).length;
    expect((await callTool(ctx, "connect_repository", { repository: `http://127.0.0.1:${port}/missing.git`, id: "failed" })).isError).toBe(true);
    expect(listSpaces(app).length).toBe(count);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
}, 30000);

it("still prunes files deleted from a repo that were imported before ownership was recorded", async () => {
  const legacyRepo = join(root, "legacy");
  mkdirSync(legacyRepo);
  execFileSync("git", ["init", "-q", "-b", "main", legacyRepo]);
  writeFileSync(join(legacyRepo, "keep.ts"), "export const keep = 1;\n");
  writeFileSync(join(legacyRepo, "gone.ts"), "export const gone = 1;\n");
  execFileSync("git", ["-C", legacyRepo, "add", "."]);
  execFileSync("git", ["-C", legacyRepo, "-c", "user.name=T", "-c", "user.email=t@e.c", "commit", "-qm", "i"]);
  expect((await callTool(ctx, "connect_repository", { repository: legacyRepo, id: "legacy" })).isError).toBe(false);
  // Simulate rows written by older versions: no directoryRoot in meta.
  app.db.prepare("update sources set meta='{}' where space_id='legacy'").run();
  rmSync(join(legacyRepo, "gone.ts"));
  const report = await syncDirectorySpace(app, "legacy");
  expect(report.removed).toBe(1);
  const left = listSources(app, { spaceId: "legacy" }).sources;
  expect(left.map((s) => s.uri)).toEqual(["keep.ts"]);
  expect(JSON.parse(app.db.prepare("select meta from sources where space_id='legacy' and uri='keep.ts'").get()!.meta as string).directoryRoot).toBe(realpathSync(legacyRepo));
});

it("checks out submodules of cloned repositories one by one, indexes their files and reports the ones it cannot fetch", async () => {
  const commit = (dir: string, msg: string) => execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", msg]);
  const serve = join(root, "served");
  mkdirSync(serve);
  const make = (name: string, files: Record<string, string>) => {
    const dir = join(root, `${name}-src`);
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), t);
    }
    execFileSync("git", ["-C", dir, "add", "."]);
    commit(dir, "initial");
    return dir;
  };
  const publish = (name: string, dir: string) => {
    const bare = join(serve, `${name}.git`);
    rmSync(bare, { recursive: true, force: true });
    execFileSync("git", ["clone", "--bare", "-q", dir, bare]);
    execFileSync("git", ["--git-dir", bare, "update-server-info"]);
  };
  const server = createServer((req, res) => {
    const stream = createReadStream(join(serve, decodeURIComponent(new URL(req.url!, "http://localhost").pathname)));
    stream.on("error", () => { res.statusCode = 404; res.end(); });
    stream.pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const inner = make("inner", { "deep.ts": "export const deep = 1;\n" });
    publish("inner", inner);
    const lib = make("lib", { "src/lib.ts": "export const lib = 2;\n" });
    // The HTTP server runs in this process, so synchronous git calls cannot fetch from it:
    // add submodules from local paths, then point .gitmodules at the served URL.
    const addSub = (dir: string, name: string, path: string) => {
      execFileSync("git", ["-C", dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(serve, `${name}.git`), path], { stdio: "ignore" });
      execFileSync("git", ["-C", dir, "config", "-f", ".gitmodules", `submodule.${path}.url`, `${base}/${name}.git`]);
      execFileSync("git", ["-C", dir, "add", ".gitmodules"]);
    };
    addSub(lib, "inner", "deps/inner");
    commit(lib, "add inner");
    publish("lib", lib);
    const gone = make("gone", { "x.ts": "export const x = 3;\n" });
    publish("gone", gone);
    const main = make("main", { "app.ts": "import { lib } from './libs/lib/src/lib';\n" });
    addSub(main, "lib", "libs/lib");
    addSub(main, "gone", "libs/gone");
    commit(main, "add submodules");
    publish("main", main);
    rmSync(join(serve, "gone.git"), { recursive: true, force: true }); // no access any more

    const r = await callTool(ctx, "connect_repository", { repository: `${base}/main.git`, id: "with-subs" });
    expect(r.isError).toBe(false);
    const text = r.text;
    expect(text).toMatch(/子模块：共 3 个，已检出并索引 2 个；拉取失败 1 个（libs\/gone/);
    const uris = listSources(app, { spaceId: "with-subs", limit: 100 }).sources.map((s) => s.uri);
    expect(uris).toEqual(expect.arrayContaining(["app.ts", "libs/lib/src/lib.ts", "libs/lib/deps/inner/deep.ts"]));
    // Gitlinks are directories, not files to index.
    expect(uris).not.toContain("libs/gone");
    expect(uris).not.toContain("libs/lib");
    const sub = getSpace(app, "with-subs").settings.submodules as { total: number; ready: number; managed: boolean; failed: { path: string }[] };
    expect(sub).toMatchObject({ total: 3, ready: 2, managed: true });
    expect(sub.failed.map((f) => f.path)).toEqual(["libs/gone"]);

    // A repository the user manages is never fetched into; only its checked-out submodules are indexed.
    const local = join(root, "local-with-sub");
    execFileSync("git", ["clone", "-q", join(serve, "main.git"), local]);
    const l = await callTool(ctx, "connect_repository", { repository: local, id: "local-subs" });
    expect(l.text).toMatch(/已检出并索引 0 个.*本人在仓库里 git submodule update/);
    expect(listSources(app, { spaceId: "local-subs", limit: 100 }).sources.map((s) => s.uri)).toEqual(expect.arrayContaining(["app.ts"]));
    execFileSync("git", ["-C", local, "config", "submodule.libs/lib.url", join(serve, "lib.git")]);
    execFileSync("git", ["-C", local, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--", "libs/lib"], { stdio: "ignore" });
    await syncDirectorySpace(app, "local-subs");
    expect(listSources(app, { spaceId: "local-subs", limit: 100 }).sources.map((s) => s.uri)).toContain("libs/lib/src/lib.ts");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 60000);
