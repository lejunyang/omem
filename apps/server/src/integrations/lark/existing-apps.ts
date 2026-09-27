import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LarkRegistrationCredentials } from "./registration.js";

export type ReusableLarkApp = {
  appId: string;
  name: string;
  tenantBrand: "feishu" | "lark";
  source: "botmux";
};

export interface ExistingLarkAppProvider {
  list(): ReusableLarkApp[];
  credentials(appId: string): LarkRegistrationCredentials;
}

type BotmuxEntry = {
  larkAppId?: unknown;
  larkAppSecret?: unknown;
  name?: unknown;
  brand?: unknown;
  ownerOpenId?: unknown;
};

export class BotmuxExistingAppProvider implements ExistingLarkAppProvider {
  readonly configPath: string;

  constructor(path?: string) {
    const configured =
      path || process.env.OMEM_BOTMUX_CONFIG || process.env.BOTS_CONFIG;
    this.configPath = configured
      ? resolve(configured)
      : join(homedir(), ".botmux", "bots.json");
    if (!isAbsolute(this.configPath)) throw Error("BOTMUX_CONFIG_PATH_INVALID");
  }

  private entries() {
    if (!existsSync(this.configPath)) return [];
    const stat = statSync(this.configPath);
    if (!stat.isFile() || stat.size > 5_000_000)
      throw Error("BOTMUX_CONFIG_INVALID");
    const parsed = JSON.parse(readFileSync(this.configPath, "utf8"));
    if (!Array.isArray(parsed)) throw Error("BOTMUX_CONFIG_INVALID");
    const entries = parsed as BotmuxEntry[];
    const seen = new Map<string, string>();
    for (const entry of entries) {
      if (
        typeof entry.larkAppId !== "string" ||
        !/^cli_[a-zA-Z0-9]+$/.test(entry.larkAppId) ||
        typeof entry.larkAppSecret !== "string" ||
        !entry.larkAppSecret
      )
        throw Error("BOTMUX_CONFIG_INVALID");
      const prior = seen.get(entry.larkAppId);
      if (prior && prior !== entry.larkAppSecret)
        throw Error("BOTMUX_APP_CREDENTIAL_CONFLICT");
      seen.set(entry.larkAppId, entry.larkAppSecret);
    }
    return entries;
  }

  list(): ReusableLarkApp[] {
    const unique = new Map<string, ReusableLarkApp>();
    for (const entry of this.entries()) {
      const appId = String(entry.larkAppId);
      if (!unique.has(appId))
        unique.set(appId, {
          appId,
          name:
            typeof entry.name === "string" && entry.name
              ? entry.name
              : `Botmux ${appId.slice(-6)}`,
          tenantBrand: entry.brand === "lark" ? "lark" : "feishu",
          source: "botmux",
        });
    }
    return [...unique.values()];
  }

  credentials(appId: string): LarkRegistrationCredentials {
    const entry = this.entries().find(
      (candidate) => candidate.larkAppId === appId,
    );
    if (!entry) throw Error("BOTMUX_APP_NOT_FOUND");
    return {
      clientId: appId,
      clientSecret: String(entry.larkAppSecret),
      userInfo: {
        openId:
          typeof entry.ownerOpenId === "string" ? entry.ownerOpenId : undefined,
        tenantBrand: entry.brand === "lark" ? "lark" : "feishu",
      },
    };
  }
}
