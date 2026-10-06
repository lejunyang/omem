import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { git } from "../../src/development/workspace.js";

/** Actual authenticated, read-only Git HTTP transport over a temporary bare repo.
 * Credentials and all code are synthetic. Nothing outside this fixture is read. */
export async function gitRemoteFixture() {
  const root = mkdtempSync(join(tmpdir(), "omem-git-remote-")),
    source = join(root, "author"),
    bare = join(root, "repo.git");
  mkdirSync(source);
  writeFileSync(
    join(source, "README.md"),
    "# Workshop\nSynthetic repository for read-only remote preparation.\n",
  );
  writeFileSync(
    join(source, "AGENTS.md"),
    "Use ESM. Do not publish or push.\n",
  );
  writeFileSync(join(source, "value.mjs"), "export const value = 1;\n");
  await git(source, "init", "-q", "-b", "main");
  await git(source, "add", ".");
  await git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  await git(root, "clone", "--bare", source, bare);
  await git(bare, "update-server-info");
  const initial = (await git(source, "rev-parse", "HEAD")).trim();
  const counts = { denied: 0, authorized: 0, writes: 0 };
  const server = createServer((req, res) => {
    if (
      req.headers.authorization !==
      "Basic " + Buffer.from("fixture:synthetic-password").toString("base64")
    ) {
      counts.denied++;
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      res.end();
      return;
    }
    counts.authorized++;
    if (req.method !== "GET") {
      counts.writes++;
      res.writeHead(405);
      res.end();
      return;
    }
    const path = resolve(
      root,
      "." + new URL(req.url!, "http://fixture").pathname,
    );
    if (
      !relative(bare, path).startsWith("..") &&
      path.startsWith(bare) &&
      existsSync(path) &&
      statSync(path).isFile()
    ) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(readFileSync(path));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/repo.git`;
  const helper = join(root, "credential.sh");
  const password = join(root, "password"),
    config = join(root, "gitconfig");
  writeFileSync(password, "synthetic-password\n", { mode: 0o600 });
  writeFileSync(config, `[credential]\n\thelper = ${helper}\n`);
  writeFileSync(
    helper,
    '#!/bin/sh\nif [ "$1" = get ]; then\n  echo username=fixture\n  printf password=\n  cat "${0%/*}/password"\nfi\n',
    { mode: 0o700 },
  );
  return {
    root,
    source,
    bare,
    url,
    initial,
    password,
    counts,
    authentication() {
      const settings = {
        GIT_ASKPASS: "/usr/bin/false",
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_SYSTEM: "/dev/null",
      };
      const old = Object.fromEntries(
        Object.keys(settings).map((k) => [k, process.env[k]]),
      );
      Object.assign(process.env, settings);
      return () => {
        for (const [k, v] of Object.entries(old))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
      };
    },
    async update() {
      writeFileSync(join(source, "value.mjs"), "export const value = 2;\n");
      await git(source, "add", "value.mjs");
      await git(
        source,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "next",
      );
      await git(source, "push", bare, "main:main");
      await git(bare, "update-server-info");
      return (await git(source, "rev-parse", "HEAD")).trim();
    },
    async close() {
      await new Promise<void>((r, fail) =>
        server.close((e) => (e ? fail(e) : r())),
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
