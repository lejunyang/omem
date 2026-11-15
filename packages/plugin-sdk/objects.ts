/** The part of the host context used by read-only object readers. */
export type PluginObjectContext = {
  plugin: string; userId: string; spaceId: string; runId: string | null;
  actor: "agent" | "user"; conversationId: string | null;
  connection(provider: string): Promise<PluginConnection | null>;
  emit(signal: PluginSignal): Promise<void>;
  settings(): Record<string, string | number | boolean>;
};
export type PluginConnection = { account: string; scopes: string[]; base: string | null; fetch(path: string, init?: RequestInit): Promise<Response> };
export type PluginSignal = { kind: string; keys: Record<string, unknown>; payload?: unknown };
export type PluginObjectState = { title: string; status: string; link: string; fields?: { label: string; value: string }[] };
export type PluginObject = {
  kind: string; label: string;
  match(url: string): string | null;
  read(ctx: PluginObjectContext, key: string): Promise<PluginObjectState>;
  statuses: Record<string, string>; final: string[]; poll?: { minutes: number };
};
export type PluginObjectApi = { object(def: PluginObject): void };
