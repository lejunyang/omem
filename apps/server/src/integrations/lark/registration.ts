import { registerApp } from "@larksuiteoapi/node-sdk";
import type { z } from "zod";
import type { larkRequestedConfigSchema } from "../../../../../packages/contracts/src/index.js";

export type LarkRequestedConfig = z.infer<typeof larkRequestedConfigSchema>;
export type LarkRegistrationCredentials = {
  clientId: string;
  clientSecret: string;
  userInfo?: { openId?: string; tenantBrand?: "feishu" | "lark" };
};
export type LarkRegistrationRequest = {
  createOnly: boolean;
  appId?: string;
  config: LarkRequestedConfig;
  signal: AbortSignal;
  onQrCode: (value: { url: string; expiresInSeconds: number }) => void;
  onStatus: (value: {
    status: "polling" | "slow_down" | "domain_switched";
    intervalSeconds?: number;
  }) => void;
};

export interface LarkRegistrationAdapter {
  register(
    request: LarkRegistrationRequest,
  ): Promise<LarkRegistrationCredentials>;
}

export class OfficialLarkRegistrationAdapter
  implements LarkRegistrationAdapter
{
  constructor(private readonly sdkRegister: typeof registerApp = registerApp) {}

  async register(request: LarkRegistrationRequest) {
    const result = await this.sdkRegister({
      createOnly: request.createOnly,
      appId: request.appId,
      source: request.config.source,
      appPreset: request.config.appPreset,
      addons: request.config.addons,
      signal: request.signal,
      onQRCodeReady: ({ url, expireIn }) =>
        request.onQrCode({ url, expiresInSeconds: expireIn }),
      onStatusChange: ({ status, interval }) =>
        request.onStatus({ status, intervalSeconds: interval }),
    });
    return {
      clientId: result.client_id,
      clientSecret: result.client_secret,
      userInfo: result.user_info
        ? {
            openId: result.user_info.open_id,
            tenantBrand: result.user_info.tenant_brand,
          }
        : undefined,
    };
  }
}

export type LarkCapabilityResult = {
  actual: {
    scopes: string[];
    events: string[];
    callbacks: string[];
    botOpenId?: string;
  };
  missing: string[];
  repairHint?: string;
};

export interface LarkCapabilityProbe {
  probe(
    credentials: { appId: string; clientSecret: string },
    requested: LarkRequestedConfig,
  ): Promise<LarkCapabilityResult>;
}

/** Live capability checks depend on tenant/admin state and are wired by B2-05 callers.
 * Refuse activation when no real probe is configured rather than trusting requested addons. */
export class RefusingCapabilityProbe implements LarkCapabilityProbe {
  async probe(): Promise<LarkCapabilityResult> {
    return {
      actual: { scopes: [], events: [], callbacks: [] },
      missing: ["live_capability_probe_not_configured"],
      repairHint: "Configure a live Lark capability probe before activation.",
    };
  }
}
