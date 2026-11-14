import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { untar } from "../src/core/pull-transfer.ts";

/** Unpacking a pulled snapshot (core/pull-transfer.ts). */
describe("unpacking a snapshot", () => {
  it("goes on without a link whose target is gone: Windows cannot make one, the rest is there", () => {
    const base = mkdtempSync(join(tmpdir(), "omem-untar-"));
    const from = join(base, "from");
    const to = join(base, "to");
    mkdirSync(join(from, "repo/log"), { recursive: true });
    mkdirSync(to);
    writeFileSync(join(from, "repo/app.txt"), "kept\n");
    // A rotated log's link, as a service leaves it in a working tree.
    try {
      symlinkSync("app.log.2026-01-01", join(from, "repo/log/app.log"));
    } catch {
      return; // Windows without the privilege to make links: nothing to pack
    }
    // Relative to the directory: GNU tar on Windows reads "C:\…" as a remote host.
    execFileSync("tar", ["-cf", "../to/snapshot.tar", "."], { cwd: from });
    untar(to, "snapshot.tar");
    expect(readFileSync(join(to, "repo/app.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(to, "snapshot.tar"))).toBe(false);
  });

  it("still fails on an archive that is not one", () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-untar-"));
    writeFileSync(join(dir, "snapshot.tar"), "not an archive");
    expect(() => untar(dir, "snapshot.tar")).toThrow();
  });
});
