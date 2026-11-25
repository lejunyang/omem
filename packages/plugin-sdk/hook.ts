export type PluginHookFormat = "webhook" | "openai-chat";

export type PluginHookJson = null | boolean | number | string | PluginHookJson[] | { [key: string]: PluginHookJson };
export type PluginHookAcceptState = { duplicate: boolean; conflict: boolean; deliveryId: string };
export type PluginHookResponse = { status: number; headers?: Record<string, string>; body: PluginHookJson };
export type PluginHookAccept = (request: PluginHookRequest, state: PluginHookAcceptState) => PluginHookResponse;

export type PluginHookOptions = {
  name: string;
  label?: string;
  ack?: "first";
  format?: PluginHookFormat | "auto";
  secretHeader?: string;
  headers?: string[];
  dedup?: { headers?: string[]; bodyFields?: string[]; requireMatch?: boolean; windowHours?: number };
  rateLimit?: { perMinute: number; burst?: number };
  unauthorizedBody?: PluginHookJson;
  rateLimitedBody?: PluginHookJson;
  unavailableBody?: PluginHookJson;
};

export type PluginHookEvent = {
  format: PluginHookFormat;
  data: unknown;
  trust: "untrusted";
};

export type PluginHookRequest = {
  method: "POST";
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
  event: PluginHookEvent;
  deliveryId: string;
  deliveryKey: string | null;
};
