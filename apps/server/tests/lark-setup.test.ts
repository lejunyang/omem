import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareLarkSetup,
  larkSetupUrl,
} from "../src/integrations/lark/setup.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";

const directories: string[] = [];
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "omem-bot-setup-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("prepares a personal config once, preserves other settings, and reuses the key across restarts", async () => {
  vi.stubEnv("OMEM_SECRET_KEY", "");
  const directory = temporary();
  const configFile = join(directory, "config.json");
  const first = await prepareLarkSetup(configFile, directory);
  expect(first).toMatchObject({ changed: true, keySource: "personal-file" });
  const keyFile = join(directory, "secrets/master.key");
  const key = readFileSync(keyFile, "utf8");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.captureRoots = [join(directory, "notes")];
  writeFileSync(configFile, JSON.stringify(config));
  const before = readFileSync(configFile, "utf8");
  const secret = {
    appId: "cli_localsetup",
    clientSecret: "private-test-secret",
  };
  const reference = EncryptedSecretStore.fromEnvironment(directory).put(secret);
  expect(await prepareLarkSetup(configFile, directory)).toMatchObject({
    changed: false,
  });
  expect(readFileSync(configFile, "utf8")).toBe(before);
  expect(readFileSync(keyFile, "utf8")).toBe(key);
  expect(
    EncryptedSecretStore.fromEnvironment(directory).get(reference),
  ).toEqual(secret);
  expect(JSON.stringify(first)).not.toContain(key.trim());
  if (process.platform !== "win32")
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
});

it("keeps legacy environment credentials protected instead of replacing a missing original key", async () => {
  const directory = temporary();
  const configFile = join(directory, "config.json");
  vi.stubEnv("OMEM_SECRET_KEY", randomBytes(32).toString("hex"));
  EncryptedSecretStore.fromEnvironment(directory).put({
    appId: "cli_legacy",
    clientSecret: "original",
  });
  vi.stubEnv("OMEM_SECRET_KEY", "");
  await expect(prepareLarkSetup(configFile, directory)).rejects.toThrow(
    "原来的 OMEM_SECRET_KEY",
  );
  expect(existsSync(configFile)).toBe(false);
  expect(existsSync(join(directory, "secrets/master.key"))).toBe(false);
});

it("links CLI and browser to the same onboarding without putting secrets in the URL", () => {
  expect(larkSetupUrl("http://localhost:65092/", "same-id")).toBe(
    "http://localhost:65092/#/lark?onboarding=same-id",
  );
});
