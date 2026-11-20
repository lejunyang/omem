import type { App } from "../core/app.ts";
import { pluginConnection } from "../auth/connections.ts";
import type { CallContext, ItemProvider, MetricProvider, ProcessApi, Subscription } from "../../packages/plugin-sdk/server.ts";
import type { PluginManifest } from "./registry.ts";
import { pluginSpaces } from "./spaces.ts";

type Entry<T> = {
  plugin: string;
  def: T;
  spaces: readonly string[];
  context(app: App, userId: string, spaceId: string, signal: AbortSignal): CallContext;
};
export const subscriptions = new Map<string, Entry<Subscription>>();
export const itemProviders = new Map<string, Entry<ItemProvider>>();
export const metricProviders = new Map<string, Entry<MetricProvider>>();

export function registerProcessHooks(manifest: PluginManifest, undo: (() => void)[]): ProcessApi {
  const spaces = pluginSpaces(manifest).map(s => s.id);
  const context: Entry<Subscription>["context"] = (app, userId, spaceId, signal) => ({
    userId, spaceId, signal,
    async connection(provider) {
      signal.throwIfAborted();
      if (!manifest.connectors.some(c => c.provider === provider)) throw new Error("连接未获授权");
      return pluginConnection(app, userId, provider);
    },
  });
  function add<T extends { id: string }>(map: Map<string, Entry<T>>, def: T) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(def.id)) throw new Error("插件能力 id 无效");
    const key = manifest.id + ":" + def.id;
    if (map.has(key)) throw new Error("重复注册 " + key);
    map.set(key, { plugin: manifest.id, def, spaces, context });
    undo.push(() => { map.delete(key); });
  }
  return {
    subscribe(def) {
      if (!def.events.length || !def.events.every(t => manifest.permissions.events.includes(t))) throw new Error("订阅未在 permissions.events 声明");
      add(subscriptions, def);
    },
    itemProvider(def) {
      if (!manifest.permissions.itemProvider) throw new Error("缺少 permissions.itemProvider");
      add(itemProviders, def);
    },
    metricProvider(def) {
      if (!manifest.permissions.metricProvider) throw new Error("缺少 permissions.metricProvider");
      add(metricProviders, def);
    },
  };
}
