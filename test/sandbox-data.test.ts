import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { artifactPath, attachPath } from "../src/agents/artifacts.ts";
import { createRun } from "../src/agents/runs.ts";
import { ownRun } from "../src/agents/own-run.ts";
import { launch } from "../src/agents/spawn.ts";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

const support = sandboxSupport();
it.skipIf(!support.ok)("只读视图按空间提供代码、知识和已收取产物 " + (support.reason ?? ""), async () => {
  const home = mkdtempSync(join(tmpdir(), "data-home-"));
  vi.stubEnv("HOME", home);
  const app = testApp(join(home, ".omem"));
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const file = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "sample"); };
  try {
    for (const id of ["one", "two"]) {
      const repo = join(app.home, "repos", "checkout-" + id);
      for (const name of ["code.txt", ".env", "untracked"]) file(join(repo, name));
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "add", "code.txt", ".env"]);
      createSpace(app, { id, name: id, rootPath: repo });
    }
    file(join(app.home, "artifacts", "published", "example.txt"));
    file(join(app.home, "secrets", "login"));
    file(join(app.runsDir, "old", "context.json"));
    file(join(app.runsDir, "old", "patches", "example.patch"));
    app.db.exec("insert into run_artifacts(id,key,run_id,space_id,name,kind,entry,source,created_at) values('published','test','old','two','example.txt','text','example.txt','check','0')");
    createUser(app, { id: "reader", name: "reader" });
    addMember(app, "one", "reader", "reader");
    app.config.agents.ownSandbox.mode = "require";
    const profile = agentProfileSchema.parse({ id: "fixture", command: "/bin/sh", transport: "acp" });
    for (const userId of ["owner", "reader"]) {
      const { box } = ownRun(app, profile, cwd, false, undefined, { userId });
      const script = [
        'cd "$1"', "test -f repos/checkout-one/code.txt", "test ! -w repos/checkout-one/code.txt",
        "test ! -e repos/checkout-one/.env", "test ! -e repos/checkout-one/untracked", "test ! -e omem.db",
        "test ! -e secrets/login", "test ! -e runs/old/context.json", "test -f library/one/SPACE.md",
        ...(userId === "owner" ? ["test -r artifacts/published/example.txt", "test -r runs/old/patches/example.patch"]
          : ["test ! -e repos/checkout-two", "test ! -e library/two", "test ! -e artifacts/published", "test ! -e runs/old"]),
      ].join("\n");
      const child = launch("/bin/sh", ["-exc", script, "sh", app.home], { cwd, ownSandbox: box });
      let errors = ""; child.stderr.on("data", b => errors += b);
      expect((await once(child, "close"))[0], errors).toBe(0);
    }
  } finally { vi.unstubAllEnvs(); app.db.close(); rmSync(home, { recursive: true, force: true }); }
});

it.skipIf(!support.ok)("重复收取的报告只对本人和获准成员可读 " + (support.reason ?? ""), async () => {
  const home = mkdtempSync(join(tmpdir(), "artifact-view-"));
  vi.stubEnv("HOME", home);
  const app = testApp(join(home, ".omem"));
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    createSpace(app, { id: "reports", name: "报告" });
    for (const id of ["reader", "visitor"]) createUser(app, { id, name: id });
    addMember(app, "reports", "reader", "reader");
    const report = join(cwd, "report.txt");
    writeFileSync(report, "same report");
    const run = () => createRun(app, { kind: "agent", title: "交报告", spaceId: "reports", userId: "reader" });
    const submit = (name: string) => attachPath(app, run().id, name, [cwd], { by: "fixture", source: "agent" });
    const paths: string[] = [];
    for (let round = 0; round < 2; round++) {
      const result = await submit(report);
      expect(result.skipped).toEqual([]);
      paths.push(artifactPath(app, result.made[0]));
    }
    expect(statSync(paths[0]).nlink).toBe(2);
    expect(statSync(paths[1]).ino).toBe(statSync(paths[0]).ino);

    // A link beside an authorized entry has no publication record of its own.
    const unknown = join(dirname(paths[0]), "unknown.txt");
    linkSync(report, unknown);
    expect((await submit(report)).made).toEqual([]);
    const page = join(cwd, "site");
    mkdirSync(page);
    writeFileSync(join(page, "index.html"), "report");
    linkSync(report, join(page, "log.txt"));
    expect((await submit(page)).skipped[0]).toContain("log.txt");
    const profile = agentProfileSchema.parse({ id: "fixture", command: "/bin/sh", transport: "acp" });
    app.config.agents.ownSandbox.mode = "require";
    for (const userId of ["owner", "reader", "visitor"]) {
      const { box } = ownRun(app, profile, cwd, false, undefined, { userId });
      const check = userId === "visitor"
        ? 'test ! -e "$1" && test ! -e "$2"'
        : 'test "$(cat "$1")" = "same report" && test "$(cat "$2")" = "same report"';
      const child = launch("/bin/sh", ["-ec", 'test ! -e "$3"; ' + check, "sh", ...paths, unknown], { cwd, ownSandbox: box });
      let errors = ""; child.stderr.on("data", b => errors += b);
      expect((await once(child, "close"))[0], userId + " " + errors).toBe(0);
    }
  } finally { vi.unstubAllEnvs(); app.db.close(); rmSync(home, { recursive: true, force: true }); }
});
