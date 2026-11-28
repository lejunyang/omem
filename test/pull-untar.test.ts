import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setTarForTests, untar } from "../src/core/pull-transfer.ts";

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

  it("keeps Chinese file names whichever tar unpacks it (the one Windows ships read them in the system code page)", () => {
    // A header as GNU tar on Linux writes it: the name as UTF-8 bytes, no pax record beside it.
    const header = (name: string, size: number, type: "0" | "5") => {
      const h = Buffer.alloc(512);
      h.write(name, 0, "utf8");
      h.write(type === "5" ? "0000755\0" : "0000644\0", 100, "ascii");
      h.write("0000000\0", 108, "ascii");
      h.write("0000000\0", 116, "ascii");
      h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
      h.write("00000000000\0", 136, "ascii");
      h.write("        ", 148, "ascii");
      h.write(type, 156, "ascii");
      h.write("ustar  \0", 257, "ascii");
      h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      return h;
    };
    const text = Buffer.from("# 说明\n");
    const body = Buffer.alloc(512);
    text.copy(body);
    // An odd number of bytes ("示例库" is nine): not a valid name at all in a double-byte code page.
    const archive = Buffer.concat([header("library/", 0, "5"), header("library/示例库/", 0, "5"), header("library/示例库/说明.md", text.length, "0"), body, Buffer.alloc(1024)]);
    const system = "C:\\Windows\\System32\\tar.exe";
    for (const program of [null, ...(process.platform === "win32" && existsSync(system) ? [system] : [])]) {
      const dir = mkdtempSync(join(tmpdir(), "omem-untar-"));
      writeFileSync(join(dir, "snapshot.tar"), archive);
      setTarForTests(program);
      try { untar(dir, "snapshot.tar"); } finally { setTarForTests(null); }
      expect(readFileSync(join(dir, "library", "示例库", "说明.md"), "utf8"), program ?? "tar").toBe("# 说明\n");
    }
  });

  it("still fails on an archive that is not one", () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-untar-"));
    writeFileSync(join(dir, "snapshot.tar"), "not an archive");
    expect(() => untar(dir, "snapshot.tar")).toThrow();
  });
});
