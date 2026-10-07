import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applySetupConfiguration,
  readSetupConfigurationSnapshot,
} from "../src/cli/setup-config.js";
import { parseConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(raw?: string) {
  const dir = await mkdtemp(join(tmpdir(), "omem-setup-config-"));
  directories.push(dir);
  const path = join(dir, "config.json");
  if (raw !== undefined) await writeFile(path, raw);
  const snapshot = await readSetupConfigurationSnapshot({ path });
  return { path, snapshot };
}

it("initializes the package default only after the selected features are prepared", async () => {
  const { path, snapshot } = await fixture();
  expect(
    await applySetupConfiguration(snapshot, {
      embedding: true,
      decisions: "9b",
    }),
  ).toEqual({ changed: true, path });
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(parseConfig(saved).retrieval?.enabled).toBe(true);
  expect(saved.decisions.mode).toBe("9b");
  expect(saved.profiles).toHaveLength(1);
  expect(saved).not.toHaveProperty("dataDir");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("changes only selected fields, retaining formatting and personal settings", async () => {
  const raw =
    '{\r\n\t"profiles": [{"id":"personal","name":"Personal","transport":"acp","command":"custom-cli","model":"custom-model"}],\r\n\t"assistant": {"profileId":"personal"},\r\n\t"lark": {"enabled":true,"botmuxConfig":"/private/personal.json"},\r\n\t"retrieval": { "enabled" : false, "osdkModel":"my-model" },\r\n\t"decisions": { "mode" : "off" },\r\n\t"captureRoots": ["/private/retained"]\r\n}\r\n';
  const { path, snapshot } = await fixture(raw);
  await applySetupConfiguration(snapshot, { embedding: true, decisions: "4b" });
  expect(await readFile(path, "utf8")).toBe(
    raw
      .replace('"enabled" : false', '"enabled" : true')
      .replace('"mode" : "off"', '"mode" : "4b"'),
  );
  expect(snapshot.config.profiles[0]?.command).toBe("custom-cli");
  expect(snapshot.config.retrieval?.osdkModel).toBe("my-model");
});

it("rejects unknown configuration fields without deleting them", async () => {
  const { path, snapshot } = await fixture();
  const invalid = JSON.stringify({
    ...JSON.parse(snapshot.template),
    futureField: { keep: true },
  });
  await writeFile(path, invalid);
  await expect(readSetupConfigurationSnapshot({ path })).rejects.toThrow(
    "Unrecognized key",
  );
  expect(await readFile(path, "utf8")).toBe(invalid);
});

it("uses the prepared embedding only when that model is explicitly selected", async () => {
  const raw =
    '{"profiles":[{"id":"custom","name":"Custom","transport":"acp","command":"mine"}],"retrieval":{"enabled":false,"osdkModel":"custom-model","reranker":"custom-reranker"}}';
  const { path, snapshot } = await fixture(raw);
  await applySetupConfiguration(snapshot, {
    embedding: true,
    embeddingModel: "memory-zh",
  });
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.retrieval).toEqual({
    enabled: true,
    osdkModel: "memory-zh",
    reranker: "custom-reranker",
  });
  const second = await readSetupConfigurationSnapshot({ path });
  await expect(
    applySetupConfiguration(second, { embeddingModel: "../invalid" }),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
});

it("rejects a concurrent edit and leaves that newer configuration untouched", async () => {
  const { path, snapshot } = await fixture();
  const newer = snapshot.template.replace('"mode": "off"', '"mode": "2b"');
  await writeFile(path, newer);
  await expect(
    applySetupConfiguration(snapshot, { decisions: "9b" }),
  ).rejects.toThrow("未覆盖");
  expect(await readFile(path, "utf8")).toBe(newer);
});

it("preparing resources alone creates or changes no configuration", async () => {
  const missing = await fixture();
  expect(await applySetupConfiguration(missing.snapshot, {})).toEqual({
    changed: false,
    path: missing.path,
  });
  await expect(readFile(missing.path)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const existing = await fixture(missing.snapshot.template);
  expect(await applySetupConfiguration(existing.snapshot, {})).toEqual({
    changed: false,
    path: existing.path,
  });
  expect(await readFile(existing.path, "utf8")).toBe(existing.snapshot.raw);
});

it("allows the completed wizard to initialize missing configuration without enabling a feature", async () => {
  const { path, snapshot } = await fixture();
  expect(
    await applySetupConfiguration(snapshot, {}, { createIfMissing: true }),
  ).toEqual({ changed: true, path });
  expect(await readFile(path, "utf8")).toBe(snapshot.template);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.retrieval.enabled).toBe(false);
  expect(saved.decisions.mode).toBe("off");
});

it("inserts missing options without replacing the user's profiles or adding dataDir", async () => {
  const raw =
    '{\n  "profiles": [{"id":"custom","name":"Custom","transport":"acp","command":"mine"}]\n}\n';
  const { path, snapshot } = await fixture(raw);
  await applySetupConfiguration(snapshot, {
    embedding: true,
    decisions: "auto",
  });
  const text = await readFile(path, "utf8");
  expect(text).toContain('  "retrieval": {"enabled":true}');
  expect(text).toContain('  "decisions": {"mode":"auto"}');
  const saved = JSON.parse(text);
  expect(saved.profiles[0].command).toBe("mine");
  expect(saved).not.toHaveProperty("dataDir");
  expect(parseConfig(saved).decisions?.mode).toBe("auto");
});
