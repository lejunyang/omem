import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withPinnedBinds } from "../src/agents/bwrap-spawn.ts";
import { bwrapArgs } from "../src/agents/sandbox.ts";

// A member HOME reached through a symlink (for example /home/<name> -> /data/home/<name>).
describe.skipIf(process.platform !== "linux")("sandbox with a linked HOME", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omem-linked-home-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("masks logins by their real path, so pinned mounts start", () => {
    const real = join(root, "data", "home");
    mkdirSync(join(real, ".config", "gh"), { recursive: true });
    mkdirSync(join(real, ".config", "tool"), { recursive: true });
    writeFileSync(join(real, ".config", "gh", "hosts.yml"), "token: x\n");
    symlinkSync(join(root, "data"), join(root, "linked"));
    const linked = join(root, "linked", "home");

    const { args, pinned } = bwrapArgs({ hide: [], ro: [], rw: [real], cwd: real, command: "/bin/true", args: [],
      masked: [join(linked, ".config", "gh"), join(linked, ".config", "missing", "token")] });

    expect([...pinned].every(path => path.startsWith(real + "/"))).toBe(true);
    expect(pinned.has(join(real, ".config", "tool"))).toBe(true);
    expect(args.join(" ")).toContain(`--tmpfs ${join(real, ".config", "gh")}`);
    expect(args.join(" ")).not.toContain(linked);
    expect(() => withPinnedBinds(args, pinned, () => true)).not.toThrow();
  });
});
