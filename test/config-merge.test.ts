import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configSchema, loadConfig, mergeConfig, saveConfig } from "../src/core/config.ts";
import { groupItems } from "../src/agents/ai-policy.ts";

it("merges only what changed since loading", () => {
  const base = { a: 1, b: { c: 2, d: [1] }, e: { f: 1 } };
  const ours = { a: 1, b: { c: 3, d: [1] }, e: {} };
  const theirs = { a: 5, b: { c: 2, d: [1, 2] }, e: { f: 1, g: 2 }, x: true };
  expect(mergeConfig(base, ours, theirs)).toEqual({ a: 5, b: { c: 3, d: [1, 2] }, e: { g: 2 }, x: true });
});

it("旧流程配置补齐提交检查默认值，并保持各次加载独立", () => {
  const home = mkdtempSync(join(tmpdir(), "omem-commits-config-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ flows: {} }));
  const first = loadConfig(home), second = loadConfig(home);
  expect(first.flows.commits).toEqual({ enabled: true, quietMinutes: 30 });
  first.flows.commits.enabled = false;
  expect(second.flows.commits.enabled).toBe(true);
  saveConfig(first, home);
  expect(loadConfig(home).flows.commits.enabled).toBe(false);
});

it("旧配置不配流程档位，各档可独立保存并合并其他进程的设置", () => {
  const home = mkdtempSync(join(tmpdir(), "omem-tiers-"));
  const first = loadConfig(home), second = loadConfig(home);
  expect(first.agents.tiers).toEqual({});
  first.agents.tiers.cheap = { profile: "example-ai", model: "small", effort: "low" };
  expect(second.agents.tiers).toEqual({});
  // Simulate another process; this process's merge baseline stays at what it loaded.
  writeFileSync(join(home, "config.json"), JSON.stringify(first));
  second.agents.tiers.strong = { profile: "example-ai", model: "large" };
  saveConfig(second, home);
  expect(loadConfig(home).agents.tiers).toEqual({ cheap: { profile: "example-ai", model: "small", effort: "low" }, strong: { profile: "example-ai", model: "large" } });
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

it("accepts a search API on localhost or the LAN and only http(s)", () => {
  const url = (value: string) => configSchema.safeParse({ embeddings: { provider: "api", url: value }, rerank: { provider: "api", api: { model: "m", url: value } } }).success;
  for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "http://192.168.1.5/v1", "https://api.example.com/v1"]) expect(url(ok), ok).toBe(true);
  for (const bad of ["ftp://example.com/v1", "javascript:alert(1)", "api.example.com/v1"]) expect(url(bad), bad).toBe(false);
});

it("旧档位与任务候选留在原处，空的组读它们；保存过的组重新加载后保留", () => {
  const home = mkdtempSync(join(tmpdir(), "omem-ai-policy-"));
  const ai = { profile: "example", model: "small", effort: "low" };
  writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { tiers: { cheap: ai }, routing: { candidates: [{ ...ai, when: "短任务" }] } } }));
  const config = loadConfig(home);
  // Not copied: the settings page that still edits tiers and candidates keeps taking effect.
  expect(config.agents.groups.map(g => [g.id, g.items])).toEqual([["strong", []], ["standard", []], ["cheap", []]]);
  expect(groupItems({ config }, "cheap")).toEqual([ai]);
  expect(groupItems({ config }, "candidates")).toEqual([{ ...ai, note: "短任务" }]);
  config.agents.tiers.cheap = { profile: "edited" };
  expect(groupItems({ config }, "cheap")).toEqual([{ profile: "edited" }]);
  config.agents.groups[2].items.push({ profile: "second" });
  saveConfig(config, home);
  expect(loadConfig(home).agents.groups).toEqual(config.agents.groups);
  expect(groupItems({ config: loadConfig(home) }, "cheap")).toEqual([{ profile: "second" }]);
  expect(config.agents.policy).toEqual({ deny: [], classes: {} });
});
