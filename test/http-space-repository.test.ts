import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createApiToken, createUser } from "../src/core/users.ts";
import { getSpace, listSpaces } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

// Exercise the Web API against a real Git HTTP server, without external accounts.
const app = testApp();
const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
const source = join(app.home, "source");
mkdirSync(source);
execFileSync("git", ["init", "-q", "-b", "main", source]);
writeFileSync(join(source, "hello.ts"), "export const hello = 1;\n");
execFileSync("git", ["-C", source, "add", "."]);
execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
const bare = join(app.home, "served.git");
execFileSync("git", ["clone", "--bare", "-q", source, bare]);
execFileSync("git", ["--git-dir", bare, "update-server-info"]);
let requests = 0;
const remote = createServer((req, res) => {
  requests++;
  const stream = createReadStream(join(bare, new URL(req.url!, "http://localhost").pathname));
  stream.on("error", () => { res.statusCode = 404; res.end(); });
  stream.pipe(res);
});
await new Promise<void>((done) => remote.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(remote.address() as { port: number }).port}/`;
const post = (body: object, token?: string) => fetch(`${app.baseUrl}/api/spaces`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
afterAll(async () => {
  await server.close();
  await new Promise<void>((done) => remote.close(() => done()));
  app.db.close();
});

it("checks permission and rejects unsafe Git addresses before contacting a remote", async () => {
  createUser(app, { id: "member", name: "成员" });
  const token = createApiToken(app, "member", "test");
  expect((await post({ name: "denied", kind: "repo", rootPath: url }, token)).status).toBe(403);
  for (const rootPath of ["https://user:secret@example.com/app.git", "https://token@example.com/app.git", "file:///tmp/app", "ext::sh -c bad"]) {
    expect((await post({ name: "unsafe", kind: "repo", rootPath })).status).toBe(400);
  }
  expect(requests).toBe(0);
  expect(listSpaces(app).some((s) => ["denied", "unsafe"].includes(s.id))).toBe(false);
});

it("automatically clones a Git address and schedules directory import", async () => {
  const response = await post({ id: "remote", name: "远程仓库", kind: "repo", rootPath: `  ${url}  ` });
  expect(response.status).toBe(200);
  const space = await response.json();
  expect(space.rootPath).toContain(join(app.home, "repos"));
  expect(execFileSync("git", ["-C", space.rootPath, "show", "HEAD:hello.ts"], { encoding: "utf8" })).toContain("hello = 1");
  expect(app.db.prepare("select id from runs where kind='sync' and space_id='remote'").get()).toBeTruthy();
  const before = requests;
  expect((await post({ id: "remote", name: "重复", kind: "repo", rootPath: `${url}missing.git` })).status).toBe(409);
  expect(requests).toBe(before);
  expect((await post({ name: "duplicate", kind: "repo", rootPath: url })).status).toBe(409);
  expect(listSpaces(app).some((s) => s.id === "duplicate")).toBe(false);
});

it("keeps local paths and optional directories working, and creates no space after a clone failure", async () => {
  expect((await post({ name: "local", kind: "repo", rootPath: source })).status).toBe(200);
  expect(getSpace(app, "local").rootPath).toBe(source);
  expect((await post({ name: "project", kind: "project" })).status).toBe(200);
  expect(getSpace(app, "project").rootPath).toBeNull();
  const response = await post({ name: "failed", kind: "repo", rootPath: `${url}missing.git` });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("Git 克隆失败");
  expect(listSpaces(app).some((s) => s.id === "failed")).toBe(false);
});
