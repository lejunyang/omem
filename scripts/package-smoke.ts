import { taskFlag } from "./task-args.js";
/** A production npm install, not a link to the development node_modules. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const root = process.cwd(),
  pkg = JSON.parse(await readFile("package.json", "utf8"));
const tarball = resolve(".release", `${pkg.name}-${pkg.version}.tgz`);
if (!existsSync(tarball)) throw Error("先运行 osdk run package");
const files = (await exec("tar", ["-tzf", tarball])).stdout
  .split("\n")
  .filter(Boolean);
assert(files.length > 0);
assert(
  !files.some((p) =>
    /(?:^|\/)(?:\.repo-review|\.omem|\.git|node_modules|\.osdk|omem\.local\.json)(?:\/|$)/.test(
      p,
    ),
  ),
);
assert(!files.some((p) => /\.(?:sqlite|db|safetensors|jsonl)$/.test(p)));
const schedulesReference = "skills/omem-cli/references/schedules.md";
assert(
  files.includes(`package/${schedulesReference}`),
  "The tarball must include the conversation and schedule reference",
);
const temp = await mkdtemp(join(tmpdir(), "omem-npm-")),
  prefix = join(temp, "install"),
  cwd = join(temp, "outside"),
  data = join(temp, "data");
await mkdir(cwd);
await mkdir(prefix);
await writeFile(
  join(prefix, "package.json"),
  JSON.stringify({ private: true }),
);
const node = (await exec("node", ["-p", "process.execPath"])).stdout.trim();
const bin = join(prefix, "node_modules/.bin/omem");
const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
await new Promise<void>((r) => server.close(() => r()));
const env = {
  ...process.env,
  OMEM_DATA_DIR: data,
  OMEM_PORT: String(port),
  PATH: dirname(node) + delimiter + process.env.PATH,
};
delete env.OMEM_CONFIG;
delete env.OMEM_URL;
delete env.OMEM_TOKEN;
async function cli(args: string[], ok = true) {
  try {
    return (
      await exec(bin, args, {
        cwd,
        env,
        timeout: args[0] === "ask" ? 0 : 90_000,
        maxBuffer: 2_000_000,
      })
    ).stdout;
  } catch (error) {
    if (ok) throw error;
    return error as { code: number; stdout: string; stderr: string };
  }
}
try {
  console.log(
    "Installing tarball and production dependencies in an isolated directory...",
  );
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      tarball,
    ],
    { cwd, env, timeout: 600_000, maxBuffer: 10_000_000 },
  );
  console.log("Checking installed help, package assets and initialization...");
  for (const args of [
    [],
    ["--help"],
    ["messages", "--help"],
    ["data", "archive", "--help"],
    ["requirements", "track", "--help"],
    ["requirements", "follow", "--help"],
    ["develop", "start", "--help"],
    ["develop", "apply", "--help"],
    ["knowledge", "write", "--help"],
    ["--version"],
  ])
    await cli(args);
  const scheduleCommands = [
    "list",
    "show",
    "add",
    "configure",
    "pause",
    "resume",
    "run",
    "delete",
  ];
  const scheduleHelp = String(await cli(["schedules", "--help"]));
  for (const command of scheduleCommands) {
    assert.match(scheduleHelp, new RegExp(`\\b${command}\\b`));
    assert.match(String(await cli(["schedules", command, "--help"])), /Usage:/);
  }
  assert.match(String(await cli(["messages", "chats", "--help"])), /Usage:/);
  const autoWatchCommands = ["status", "configure", "run"];
  const autoWatchHelp = String(await cli(["messages", "auto-watch", "--help"]));
  for (const command of autoWatchCommands) {
    assert.match(autoWatchHelp, new RegExp(`\\b${command}\\b`));
    assert.match(
      String(await cli(["messages", "auto-watch", command, "--help"])),
      /Usage:/,
    );
  }
  assert(!existsSync(data), "Help must not create data or load configuration");
  assert.equal(((await cli(["nonexistent"], false)) as any).code, 2);
  const first = JSON.parse((await cli(["init", "--json"])) as string);
  assert.equal(first.created, true);
  const second = JSON.parse((await cli(["init", "--json"])) as string);
  assert.equal(second.created, false);
  assert.equal(first.dataDir, data);
  await cli(["config", "validate"]);
  await cli(["skills", "install", join(temp, "skills")]);
  assert(existsSync(join(temp, "skills/omem-cli/references/workflows.md")));
  assert(existsSync(join(temp, "skills/omem-cli/references/development.md")));
  const packagedSchedules = await readFile(
    join(prefix, "node_modules/omem", schedulesReference),
    "utf8",
  );
  assert.equal(
    packagedSchedules,
    await readFile(join(root, schedulesReference), "utf8"),
    "The installed reference must match the current packaged source",
  );
  assert.equal(
    await readFile(join(temp, schedulesReference), "utf8"),
    packagedSchedules,
    "skills install must copy the complete schedule reference",
  );
  assert.match(
    await readFile(join(temp, "skills/omem-cli/SKILL.md"), "utf8"),
    /references\/schedules\.md/,
  );
  const importPath = join(
    prefix,
    "node_modules/omem/dist/apps/server/src/agent-runtime/bundles.js",
  );
  await exec(
    node,
    [
      "--input-type=module",
      "-e",
      `const {RoleBundleRegistry}=await import(${JSON.stringify(importPath)}); const r=new RoleBundleRegistry(); r.load('daily-assistant'); r.load('knowledge-researcher'); r.load('knowledge-writer'); r.load('knowledge-verifier'); r.load('requirement-tracker'); r.load('implementation-planner');`,
    ],
    { cwd, env },
  );
  console.log("Starting installed PM2 service, importing and searching...");
  const service = JSON.parse(
    (await cli(["service", "start", "--json"])) as string,
  );
  assert.equal(service.state, "online");
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  await writeFile(
    join(cwd, "notes.md"),
    "# 发布约定\n\n发布前需要完成回滚方案，并由负责人确认。\n",
  );
  await cli(["import", "file", "notes.md", "--json"]);
  const hits = JSON.parse(
    (await cli(["search", "回滚方案", "--json"])) as string,
  );
  assert(hits.length > 0);
  await cli([
    "import",
    "text",
    "周五前补充设计稿",
    "--title",
    "项目安排",
    "--json",
  ]);
  await cli(["doctor", "--json"]);
  const scope = JSON.parse(
    (await cli([
      "contexts",
      "create",
      "发布项目",
      "--description",
      "发布约定",
      "--json",
    ])) as string,
  );
  assert(scope.id);
  assert.deepEqual(
    JSON.parse((await cli(["requirements", "list", "--json"])) as string),
    [],
  );
  assert.equal(
    ((await cli(["data", "backup", join(temp, "busy-backup")], false)) as any)
      .code,
    1,
  );
  if (taskFlag("agent")) {
    console.log("Checking installed CLI with real Traex ACP / gpt-5.6-sol...");
    const answer = JSON.parse(
      (await cli([
        "ask",
        "发布前需要完成什么？请根据已有材料直接回答。",
        "--research",
        "--json",
      ])) as string,
    );
    assert.equal(answer.turn.inputMessageRefs.status, "done");
    assert.match(answer.turn.result, /回滚/);
    console.log("Real Agent answered from the installed library.");
  }
  const state = JSON.parse(
    (await cli(["messages", "status", "--json"])) as string,
  );
  assert(!state.settings?.enabled);
  await cli(["service", "stop", "--json"]);
  const stopped = (await cli(["service", "status", "--json"], false)) as any;
  assert.equal(stopped.code, 1);
  const backup = join(temp, "backup"),
    restored = join(temp, "restored");
  await cli(["data", "backup", backup, "--json"]);
  await cli(["data", "restore", backup, "--to", restored, "--json"]);
  const storage = JSON.parse(
    (await cli(["--data-dir", restored, "data", "info", "--json"])) as string,
  );
  assert(storage.database.counts.sources >= 2);
  await cli([
    "data",
    "archive",
    "--before",
    "2020-01-01",
    "--to",
    join(temp, "cold"),
    "--apply",
    "--json",
  ]);
  console.log(
    JSON.stringify(
      {
        passed: true,
        files: files.length,
        platform: `${process.platform}/${process.arch}`,
        checks: [
          "production install",
          "nested help and exit codes",
          "schedule and automatic watch help",
          "idempotent init",
          "packaged roles and skills",
          "complete schedule reference installation",
          "Web assets",
          "PM2 start/stop",
          "file/text capture",
          "Chinese search",
          "collector remains disabled",
          "requirement roles and project CLI",
          "live-library maintenance refusal",
          "offline backup, restore and cold-store setup",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  // Only the daemon created for this disposable library; never the user's PM2_HOME.
  const home = join(data, "service/pm2");
  if (existsSync(join(home, "pm2.pid"))) {
    await exec(node, [join(prefix, "node_modules/pm2/bin/pm2"), "kill"], {
      cwd,
      env: { ...env, PM2_HOME: home },
      timeout: 30_000,
    }).catch((e) => {
      console.error("Temporary PM2 cleanup failed", e.message);
      process.exitCode = 1;
    });
  }
  if (!process.exitCode) await rm(temp, { recursive: true, force: true });
  else console.error(`保留失败现场：${temp}`);
}
