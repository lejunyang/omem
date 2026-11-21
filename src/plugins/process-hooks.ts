import { untilAbort } from "../core/util.ts";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { pluginConnection } from "../auth/connections.ts";
import type { Notifier, CallContext, ItemProvider, MetricProvider, Retriever, Reranker, ReviewProvider, ProcessApi, Subscription } from "../../packages/plugin-sdk/server.ts";
import type { PluginManifest } from "./registry.ts";

import { registerFormats } from "./formats.ts";
import { pluginSpaces } from "./spaces.ts";

type Entry<T> = {
  spaces: readonly string[];
  plugin: string;
  def: T;
  context(app: App, userId: string, spaceId: string, signal: AbortSignal): CallContext;
};
export const notifiers = new Map<string, Entry<Notifier>>();
export const subscriptions = new Map<string, Entry<Subscription>>();
export const itemProviders = new Map<string, Entry<ItemProvider>>();
export const reviewProviders = new Map<string, Entry<ReviewProvider>>();
const comment = z.object({ id: z.string().min(1).max(500), url: z.httpUrl().max(4096), revision: z.string().max(500).optional() });
const thread = z.object({ state: z.enum(["open", "replied", "resolved", "outdated"]), reply: z.object({
  author: z.string().min(1).max(500), at: z.iso.datetime({ offset: true }), summary: z.string().max(1000),
}).optional() });
export const retrievers = new Map<string, Entry<Retriever>>();
export type RegisteredReranker = Entry<Reranker>;
export const rerankers = new Map<string, RegisteredReranker>();
export const metricProviders = new Map<string, Entry<MetricProvider>>();

export function registerProcessHooks(manifest: PluginManifest, undo: (() => void)[], version = manifest.version): Omit<ProcessApi, "answerAsk"> {
  const spaces = pluginSpaces(manifest).map(s => s.id);
  const lifetime = new AbortController();
  undo.push(() => lifetime.abort());
  const context: Entry<Subscription>["context"] = (app, userId, spaceId, callSignal) => {
    const signal = AbortSignal.any([lifetime.signal, callSignal]);
    return {
      userId, spaceId, signal,
      async connection(provider) {
        signal.throwIfAborted();
        if (!manifest.connectors.some(c => c.provider === provider)) throw new Error("连接未获授权");
        const c = pluginConnection(app, userId, provider);
        if (!c) return null;
        return {
          ...c,
          fetch(path, init = {}) {
            signal.throwIfAborted();
            return c.fetch(path, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
          },
        };
      },
    };
  };
  function add<T extends { id: string }>(map: Map<string, Entry<T>>, def: T) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(def.id)) throw new Error("插件能力 id 无效");
    const key = manifest.id + ":" + def.id;
    if (map.has(key)) throw new Error("重复注册 " + key);
    map.set(key, { plugin: manifest.id, def, spaces, context });
    undo.push(() => { map.delete(key); });
  }
  return {
    ...registerFormats(manifest, version, spaces, context, undo),
    notifier(def) {
      if (!manifest.permissions.notify?.deliver) throw new Error("缺少 permissions.notify.deliver");
      if (!def.name?.trim() || typeof def.deliver !== "function") throw new Error("通知出口需要名称与 deliver");
      const interactive = manifest.permissions.notify.ask;
      add(notifiers, { ...def, ask: interactive ? def.ask : undefined, retract: interactive ? def.retract : undefined });
    },
    subscribe(def) {
      if (!def.events.length || !def.events.every(t => manifest.permissions.events.includes(t))) throw new Error("订阅未在 permissions.events 声明");
      add(subscriptions, def);
    },
    itemProvider(def) {
      if (!manifest.permissions.itemProvider) throw new Error("缺少 permissions.itemProvider");
      add(itemProviders, def);
    },
    reviewProvider(def) {
      if (!manifest.permissions.reviewProvider) throw new Error("缺少 permissions.reviewProvider");
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(def.objectKind) || !def.label?.trim() || def.label.length > 128 ||
        typeof def.publish !== "function" || typeof def.readThread !== "function") throw new Error("评审提供者声明无效");
      if ([...reviewProviders.values()].some(e => e.plugin === manifest.id && e.def.objectKind === def.objectKind))
        throw new Error("对象种类已有评审提供者");
      add<ReviewProvider>(reviewProviders, { ...def,
        publish: async (ctx, req) => comment.parse(await untilAbort(ctx.signal, () => def.publish(ctx, req))),
        readThread: async (ctx, ref) => thread.parse(await untilAbort(ctx.signal, () => def.readThread(ctx, ref))),
        resolve: def.resolve && (async (ctx, ref, note) => thread.parse(await untilAbort(ctx.signal, () => def.resolve!(ctx, ref, note)))),
      });
    },
    retriever(def) {
      if (!manifest.permissions.retriever) throw new Error("缺少 permissions.retriever");
      if (!def.label?.trim() || typeof def.search !== "function") throw new Error("retriever 声明无效");
      add(retrievers, def);
    },
    reranker(def) {
      if (!manifest.permissions.reranker) throw new Error("缺少 permissions.reranker");
      if (!def.label?.trim() || typeof def.score !== "function") throw new Error("reranker 声明无效");
      add(rerankers, def);
    },
    metricProvider(def) {
      if (!manifest.permissions.metricProvider) throw new Error("缺少 permissions.metricProvider");
      add(metricProviders, def);
    },
  };
}
