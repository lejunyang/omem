/** The part of the host context used by object readers and tools. */
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
/**
 * A button on the object's card (merge, rerun failed checks): one of the plugin's own tools
 * (`<plugin id>_…`), called with the object's key in `arg` (default `key`). An agent calling the same
 * tool goes through the same approval rung. `statuses`: shown only in these; `confirm`: one more
 * sentence for the confirmation dialog.
 */
export type PluginObjectAction = { id: string; label: string; tool: string; arg?: string; statuses?: string[]; confirm?: string };
export type PluginObject = {
  kind: string; label: string;
  match(url: string): string | null;
  read(ctx: PluginObjectContext, key: string): Promise<PluginObjectState>;
  statuses: Record<string, string>; final: string[]; poll?: { minutes: number };
  actions?: PluginObjectAction[];
};
export type PluginObjectApi = { object(def: PluginObject): void };
