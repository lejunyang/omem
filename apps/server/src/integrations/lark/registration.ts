import { defaultHttpInstance, registerApp } from "@larksuiteoapi/node-sdk";
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

const registrationPath = "/oauth/v1/app/registration";
const retryMarker = "__omemRegistrationRetry";
let registrationRetryInstalled = false;

/** Keep the same RFC 8628 device_code alive across transient poll failures.
 * The upstream SDK treats one network error as terminal; retrying its Axios
 * request here preserves the exact poll request instead of issuing a new QR. */
export function installLarkRegistrationRetry(maxRetries = 5) {
  if (registrationRetryInstalled) return;
  registrationRetryInstalled = true;
  defaultHttpInstance.interceptors.response.use(undefined, async (error) => {
    const candidate = error as {
      code?: string;
      config?: Record<string, unknown> & {
        url?: string;
        signal?: AbortSignal;
      };
      response?: { status?: number };
    };
    const config = candidate.config;
    const retryableStatus =
      typeof candidate.response?.status === "number" &&
      candidate.response.status >= 500;
    const retryableTransport =
      !candidate.response &&
      /^(?:ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ECONNABORTED)$/.test(
        candidate.code ?? "",
      );
    const attempt = Number(config?.[retryMarker] ?? 0);
    if (
      !config?.url?.includes(registrationPath) ||
      config.signal?.aborted ||
      attempt >= maxRetries ||
      (!retryableStatus && !retryableTransport)
    )
      return Promise.reject(error);
    config[retryMarker] = attempt + 1;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(4_000, 500 * 2 ** attempt)),
    );
    return defaultHttpInstance.request(config);
  });
}

export class OfficialLarkRegistrationAdapter
  implements LarkRegistrationAdapter
{
  constructor(private readonly sdkRegister: typeof registerApp = registerApp) {
    installLarkRegistrationRetry();
  }

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
    eventVerification?: "runtime";
  };
  missing: string[];
  repairHint?: string;
};

type FetchLike = typeof fetch;

const stringList = (value: unknown, field?: string) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (
          field &&
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>)[field] === "string"
        )
          return [String((item as Record<string, unknown>)[field])];
        return [];
      })
    : [];

/** Public OpenAPI capability probe. Event subscriptions are confirmed by the
 * first matching WebSocket delivery (pairing requires im.message.receive_v1),
 * because the public application endpoint does not expose the event list. */
export class OfficialLarkCapabilityProbe implements LarkCapabilityProbe {
  constructor(private readonly request: FetchLike = fetch) {}

  async probe(
    credentials: { appId: string; clientSecret: string },
    requested: LarkRequestedConfig,
  ): Promise<LarkCapabilityResult> {
    const base = "https://open.feishu.cn";
    const tokenResponse = await this.request(
      `${base}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: credentials.appId,
          app_secret: credentials.clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const tokenBody = (await tokenResponse.json()) as {
      code?: number;
      tenant_access_token?: string;
    };
    if (
      !tokenResponse.ok ||
      tokenBody.code !== 0 ||
      !tokenBody.tenant_access_token
    )
      throw Error(`LARK_CAPABILITY_TOKEN_FAILED:${tokenBody.code ?? "http"}`);
    const headers = {
      Authorization: `Bearer ${tokenBody.tenant_access_token}`,
    };
    const [botResponse, appResponse] = await Promise.all([
      this.request(`${base}/open-apis/bot/v3/info/`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      }),
      this.request(
        `${base}/open-apis/application/v6/applications/${credentials.appId}?lang=zh_cn`,
        { headers, signal: AbortSignal.timeout(15_000) },
      ),
    ]);
    const botBody = (await botResponse.json()) as any;
    const appBody = (await appResponse.json()) as any;
    if (!botResponse.ok || botBody?.code !== 0)
      throw Error(`LARK_CAPABILITY_BOT_FAILED:${botBody?.code ?? "http"}`);
    if (!appResponse.ok || appBody?.code !== 0)
      throw Error(`LARK_CAPABILITY_APP_FAILED:${appBody?.code ?? "http"}`);
    const app = appBody?.data?.app ?? appBody?.data?.application ?? {};
    const scopes = [...new Set(stringList(app?.scopes, "scope"))].sort();
    const callbacks = [
      ...new Set(
        stringList(app?.callback_info?.subscribed_callbacks).concat(
          stringList(app?.callbacks),
        ),
      ),
    ].sort();
    const requiredScopes = [
      ...new Set([
        ...requested.addons.scopes.tenant,
        ...requested.addons.scopes.user,
      ]),
    ];
    const missing = [
      ...requiredScopes.filter((scope) => !scopes.includes(scope)),
      ...requested.addons.callbacks.items.filter(
        (callback) => !callbacks.includes(callback),
      ),
    ].sort();
    return {
      actual: {
        scopes,
        events: [],
        callbacks,
        botOpenId:
          botBody?.bot?.open_id ?? botBody?.data?.bot?.open_id ?? undefined,
        eventVerification: "runtime",
      },
      missing,
      repairHint: missing.length
        ? "Grant the missing app scopes/callbacks and retry capability checking. Event subscriptions are verified by WebSocket delivery during pairing."
        : "Scopes and callbacks verified by OpenAPI; event subscriptions are verified by WebSocket delivery during pairing.",
    };
  }
}

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
