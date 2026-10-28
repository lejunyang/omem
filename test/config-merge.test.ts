import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig, mergeConfig, saveConfig } from "../src/core/config.ts";

it("merges only what changed since loading", () => {
  const base = { a: 1, b: { c: 2, d: [1] }, e: { f: 1 } };
  const ours = { a: 1, b: { c: 3, d: [1] }, e: {} };
  const theirs = { a: 5, b: { c: 2, d: [1, 2] }, e: { f: 1, g: 2 }, x: true };
  expect(mergeConfig(base, ours, theirs)).toEqual({ a: 5, b: { c: 3, d: [1, 2] }, e: { g: 2 }, x: true });
});

it("a save from a process that loaded earlier keeps what another hand wrote since", () => {
  const home = mkdtempSync(join(tmpdir(), "omem-config-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ notify: { quietStart: 23 } }));
  const service = loadConfig(home);
  // Someone else (omem setup, a CLI command, a hand edit) changes the file while the service runs.
  const edited = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  edited.notify.quietEnd = 9;
  edited.lark = { enabled: true, appId: "cli_demo" };
  writeFileSync(join(home, "config.json"), JSON.stringify(edited));
  // The service then saves one setting of its own.
  const next = structuredClone(service);
  next.notify.quietStart = 22;
  saveConfig(next, home);
  const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(onDisk.notify).toEqual({ quietStart: 22, quietEnd: 9 });
  expect(onDisk.lark).toEqual({ enabled: true, appId: "cli_demo" });
  // The saved object is the merged config, so the caller's copy picks up the other change too.
  expect(next.lark.appId).toBe("cli_demo");
  expect(loadConfig(home).notify.quietStart).toBe(22);
});
