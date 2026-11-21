import { z } from "zod";
import type { App } from "../core/app.ts";
import { OWNER } from "../core/users.ts";
import { readableSourceIds } from "../auth/visibility.ts";
import { capabilityAccess } from "../auth/capabilities.ts";
import { retrievers, rerankers, untilAbort, type RegisteredReranker } from "../plugins/process-hooks.ts";
import type { CallContext, RetrievalKind, RetrievalRef } from "../plugins/types.ts";
import type { Hit, HitType, SearchOptions } from "./search.ts";

type Status = { lastMs: number; lastError: string | null };
const recent = new WeakMap<object, Status>();
type Entry = { plugin: string; def: { id: string; label: string }; spaces: readonly string[];
  context(app: App, userId: string, space: string, signal: AbortSignal): CallContext };

async function invoke<T>(app: App, entry: Entry, userId: string, space: string, timeout: number, call: (ctx: CallContext) => Promise<T>) {
  const start = performance.now();
  const ctx = entry.context(app, userId, space, AbortSignal.timeout(timeout));
  try {
    const result = await untilAbort(ctx.signal, () => call(ctx));
    recent.set(entry, { lastMs: Math.round(performance.now() - start), lastError: null });
    return result;
  } catch (e) {
    const first = !recent.get(entry)?.lastError;
    const error = String(e instanceof Error ? e.message : e).slice(0, 500) || "提供者调用失败";
    recent.set(entry, { lastMs: Math.round(performance.now() - start), lastError: error });
    if (first) {
      try {
        const { notify } = await import("../core/notify.ts");
        notify(app, { title: `检索提供者调用失败：${entry.def.label}`, body: error, urgency: "later", plain: true });
      } catch (error) {
        console.warn("[omem] 检索失败提醒未送达", error);
      }
    }
    return null;
  }
}

const ref = z.strictObject({ type: z.enum(["chunk", "page", "memory", "source"]), id: z.string().min(1).max(1024), score: z.number().finite().optional() });
export type Retrieved = { via: string; refs: RetrievalRef[]; spaces: string[]; kinds: RetrievalKind[] };
const kinds: RetrievalKind[] = ["chunk", "page", "memory"];
const viewCap = { chunk: "sources.view", symbol: "sources.view", memory: "memories.view", page: "wiki.view", requirement: "requirements.view" } as const;
export type ReadableHit = Pick<Hit, "type" | "spaceId" | "sourceId" | "sourceKind">;
export type SharedSearchAccess = {
  spaces: string[];
  allows(space: string, kind: RetrievalKind): boolean;
  visible(hit: ReadableHit): boolean;
};
export function pluginHitFilter(app: App, hits: Iterable<ReadableHit>, userId = OWNER, shared?: SharedSearchAccess) {
  if (shared) return shared.visible;
  if (userId === OWNER) return () => true;
  const access = capabilityAccess(app, userId);
  const ids = [...new Set(Array.from(hits).flatMap(h => h.sourceId ?? []))];
  const readable = ids.length ? readableSourceIds(app, userId, ids) : new Set<string>();
  return (h: ReadableHit) => !!access.source(viewCap[h.type], h.spaceId) && (!h.sourceId || readable.has(h.sourceId));
}
function memberSearchAccess(app: App, userId: string) {
  const access = capabilityAccess(app, userId);
  return { spaces: access.spaces.map(s => s.id), allows: (id: string, k: RetrievalKind) => !!access.source(viewCap[k], id) };
}

export async function retrieve(app: App, query: string, opts: SearchOptions, types: Set<HitType>, excluded: Set<string>): Promise<Retrieved[]> {
  const userId = opts.userId ?? OWNER;
  const access = opts.shared ?? memberSearchAccess(app, userId);
  const scope = access.spaces.filter(id => (!opts.spaces || opts.spaces.includes(id)) && !excluded.has(id));
  const routes = await Promise.all(app.config.search.retrievers.map(async cfg => {
    const entry = retrievers.get(cfg.provider);
    if (!entry) return;
    const requested = kinds.filter(k => types.has(k) && (!cfg.kinds || cfg.kinds.includes(k)));
    const spaces = scope.filter(id => requested.some(k => access.allows(id, k)) && (!cfg.spaces || cfg.spaces.includes(id)) && (!entry.spaces.length || entry.spaces.includes(id)));
    if (!spaces.length || !requested.length) return;
    const allowedKinds = requested.filter(k => spaces.some(id => access.allows(id, k)));
    const refs = await invoke(app, entry, userId, spaces[0], cfg.timeoutMs, async ctx => {
      const raw = await entry.def.search(ctx, { query, spaces: [...spaces], kinds: [...allowedKinds], limit: cfg.limit });
      if (!Array.isArray(raw)) throw new Error("召回结果需要是数组");
      return z.array(ref).parse(raw.slice(0, cfg.limit));
    });
    if (refs?.length) return { via: "plugin:" + cfg.provider, refs, spaces, kinds: allowedKinds };
  }));
  return routes.filter((r): r is Retrieved => !!r);
}

export type RerankCandidate = ReadableHit & { id: string; text: string };
export function selectedReranker(app: App) {
  const selected = app.config.rerank.provider;
  return selected.startsWith("plugin:") ? rerankers.get(selected.slice(7)) : undefined;
}
export async function pluginScores(app: App, entry: RegisteredReranker, query: string, batch: RerankCandidate[], userId: string, timeout: number) {
  return invoke(app, entry, userId, batch[0].spaceId, timeout, async ctx => {
    const candidates = batch.map(({ id, text }) => ({ id, text: text.slice(0, 4000) }));
    const scores = await entry.def.score(ctx, { query: query.slice(0, 1000), candidates });
    if (!Array.isArray(scores) || scores.length !== batch.length) throw new Error("重排分数个数与候选数不符");
    return z.array(z.number().finite()).parse(scores);
  });
}

export function searchProviderStatus(app: App) {
  const describe = ([id, entry]: [string, Entry]) => ({ id, label: entry.def.label, plugin: entry.plugin, spaces: entry.spaces,
    ...(recent.get(entry) ?? { lastMs: null, lastError: null }) });
  return { retrievers: [...retrievers].map(describe), rerankers: [...rerankers].map(describe),
    config: { search: app.config.search, rerank: app.config.rerank } };
}
