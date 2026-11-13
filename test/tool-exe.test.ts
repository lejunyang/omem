import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exeOnPath } from "../src/core/tools.ts";

// On Windows a program spawned without a shell must be an .exe: osdk's .cmd shim on PATH is not one.
describe("exeOnPath", () => {
  const root = mkdtempSync(join(tmpdir(), "omem-exe-"));
  const shims = join(root, "shims");
  const bin = join(root, "bin");
  mkdirSync(shims);
  mkdirSync(bin);
  writeFileSync(join(shims, "aad.cmd"), "@echo off\n");
  writeFileSync(join(shims, "aad"), "#!/bin/sh\n");
  writeFileSync(join(bin, "aad.exe"), "");

  it("skips a .cmd shim and finds the .exe further along PATH", () => {
    expect(exeOnPath("aad", `${shims};"${bin}"`, "win32")).toBe(join(bin, "aad.exe"));
  });
  it("finds nothing when PATH has only the shim, so osdk's install directory is used", () => {
    expect(exeOnPath("aad", shims, "win32")).toBeNull();
  });
  it("is not used on other systems", () => {
    expect(exeOnPath("aad", `${shims};${bin}`, "linux")).toBeNull();
  });
});
