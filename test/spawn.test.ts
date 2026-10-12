import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { npmShimTarget } from "../src/agents/spawn.ts";

it("finds the script behind npm and pnpm .cmd shims", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  mkdirSync(join(dir, "node_modules", "x", "bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "bin", "x.js"), "");
  writeFileSync(join(dir, "npm.cmd"), '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\x\\bin\\x.js" %*\r\n');
  writeFileSync(join(dir, "pnpm.cmd"), '@"%~dp0\\node.exe" "%~dp0\\node_modules\\x\\bin\\x.js" %*\r\n');
  writeFileSync(join(dir, "other.cmd"), "@echo hi\r\n");
  expect(npmShimTarget(join(dir, "npm.cmd"))).toBe(join(dir, "node_modules/x/bin/x.js"));
  expect(npmShimTarget(join(dir, "pnpm.cmd"))).toBe(join(dir, "node_modules/x/bin/x.js"));
  expect(npmShimTarget(join(dir, "other.cmd"))).toBeNull();
});
