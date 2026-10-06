import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseConfig } from "../../config.js";
import { assetPath } from "../../paths.js";
import { EncryptedSecretStore } from "./secret-store.js";

/** Explicit local setup only. No platform creation, permissions or message writes. */
export async function prepareLarkSetup(file: string, dataDir: string) {
  const existing = existsSync(file);
  const config = JSON.parse(
    await readFile(
      existing ? file : assetPath("config/omem.default.json"),
      "utf8",
    ),
  );
  parseConfig(config);
  const changed = !existing || !config.lark?.enabled;
  config.lark = { ...config.lark, enabled: true };
  parseConfig(config);
  EncryptedSecretStore.fromEnvironment(dataDir);
  if (changed) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(
      dirname(file),
      `.omem-lark-setup-${randomUUID()}.json`,
    );
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return {
    config: file,
    dataDir,
    changed,
    keySource: process.env.OMEM_SECRET_KEY ? "environment" : "personal-file",
  };
}

export function larkSetupUrl(base: string, onboardingId?: string) {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol))
    throw Error("网页地址必须使用 http 或 https");
  url.hash =
    "/lark" +
    (onboardingId
      ? "?" + new URLSearchParams({ onboarding: onboardingId })
      : "");
  return url.toString();
}
