import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
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
