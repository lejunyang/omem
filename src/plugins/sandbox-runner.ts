import { pathToFileURL } from "node:url";
import { z } from "zod";
import { htmlToMarkdown } from "../sources/html.ts";
import type { PlatformReader, PluginApi, PluginConnection, PluginPlatform, PluginTool, PluginObject, PluginHook } from "./types.ts";
import { validateObject } from "./objects.ts";
import { validateHook } from "./hooks.ts";

/**
 * A plugin's code in its own process (src/plugins/sandbox.ts): started with Node's permission model,
 * it may read its own directory and omem's package, write its own data directory, and nothing else on
 * this machine; no child processes. It holds no token or database: every call that needs one (a
 * platform request as someone, the plugin's records, saving a source) goes back to omem over IPC.
 */
type Msg = { t: string; id?: number; [k: string]: any };
const send = (m: Msg) => process.send!(m);

let seq = 0;
const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
/** Ask omem for something only it can do. */
const rpc = <T = any>(op: string, args: Record<string, unknown>) =>
  new Promise<T>((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    send({ t: "rpc", id, op, args });
  });

const unsupported = (what: string) => () => {
  throw new Error(`隔离运行的插件不能用${what}；需要的话请主人在设置 → 插件里选“在 omem 进程里运行”`);
};

/** A connection's view: its fetch goes through omem, which adds the token. */
function connectionOf(c: { handle: string; account: string; scopes: string[]; base: string | null }, call: number): PluginConnection {
  return {
    account: c.account,
    scopes: c.scopes,
    base: c.base,
    async fetch(path, init = {}) {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : String(init.body);
      const r = await rpc<{ status: number; headers: [string, string][]; body: string }>("fetch", { call, handle: c.handle, path, init: { method: init.method, headers, body } });
      return new Response(r.status === 204 || r.status === 304 ? null : Buffer.from(r.body, "base64"), { status: r.status, headers: r.headers });
    },
  };
}

/**
 * The context of one call. Everything it asks omem for names the call (`call`): omem answers as the
 * person and space of that call, whatever else the plugin might send.
 */
function contextOf(c: { call: number; userId: string; spaceId: string; runId: string | null; actor: "agent" | "user"; conversationId: string | null; settings: Record<string, unknown> }, plugin: string): any {
  const call = c.call;
  const store = (op: string) => (...args: unknown[]) => rpc(`store.${op}`, { args, call });
  return {
    plugin,
    userId: c.userId,
    spaceId: c.spaceId,
    runId: c.runId,
    actor: c.actor,
    emit: (signal: unknown) => rpc("emit", { signal, call }),
    conversationId: c.conversationId,
    settings: () => c.settings,
    store: { get: store("get"), put: store("put"), list: store("list"), delete: store("delete") },
    block: unsupported("内容块"),
    setBlockResult: unsupported("内容块"),
    present: unsupported("内容块"),
    connection: async (provider: string) => {
      const info = await rpc<{ handle: string; account: string; scopes: string[]; base: string | null } | null>("connection", { provider, call });
      return info ? connectionOf(info, call) : null;
    },
    saveSource: (input: unknown) => rpc("saveSource", { input, call }),
    watches: {
      add: (input: unknown) => rpc("watches.add", { input, call }),
      remove: (id: string) => rpc("watches.remove", { id, call }),
      list: (provider?: string) => rpc("watches.list", { provider, call }),
    },
  };
}

const tools = new Map<string, PluginTool>();
const readers = new Map<string, PlatformReader>();
const objects = new Map<string, PluginObject>();
const notifiers = new Map<string, import('./types.ts').Notifier>();
const items = new Map<string, import("./types.ts").ItemProvider>();
const retrievers = new Map<string, import("./types.ts").Retriever>();
const rerankers = new Map<string, import("./types.ts").Reranker>();
const activeSearch = new Map<number, AbortController>();
const parsers = new Map<string, import("./types.ts").SourceParser>();
const kinds = new Map<string, import("./types.ts").WikiPageKind>();
const reviews = new Map<string, import("./types.ts").ReviewProvider>();
const subscriptions = new Map<string, import("./types.ts").Subscription>();
const hooks = new Map<string, PluginHook>();

async function main() {
  const dir = process.env.OMEM_PLUGIN_DIR!;
  const file = process.env.OMEM_PLUGIN_SERVER!;
  const plugin = process.env.OMEM_PLUGIN_ID!;
  const declared: { notifiers: unknown[]; parsers: unknown[]; kinds: unknown[]; items: unknown[]; retrievers: unknown[]; rerankers: unknown[]; reviews: unknown[]; subscriptions: unknown[]; tools: unknown[]; platforms: unknown[]; objects: unknown[]; hooks: unknown[] } = { notifiers: [], parsers: [], kinds: [], items: [], retrievers: [], rerankers: [], reviews: [], subscriptions: [], tools: [], platforms: [], objects: [], hooks: [] };
  const platforms = JSON.parse(process.env.OMEM_PLATFORMS ?? "[]") as PluginPlatform[];
  const api: PluginApi = {
    id: plugin,
    answerAsk: input => rpc("answerAsk", { input }),
    notifier(def) {
      if (typeof def.deliver !== "function") throw new Error("通知出口缺少 deliver");
      notifiers.set(def.id, def);
      declared.notifiers.push({ id: def.id, name: def.name, resolves: !!def.resolve, updates: !!def.update, asks: !!def.ask, retracts: !!def.retract });
    },
    sourceParser(def) {
      if (typeof def.parse !== "function") throw new Error("解析器缺少 parse 方法");
      parsers.set(def.id, def);
      declared.parsers.push({ id: def.id, label: def.label, match: def.match });
    },
    wikiPageKind(def) {
      const { check, ...meta } = def;
      kinds.set(def.kind, def);
      declared.kinds.push({ ...meta, checked: !!check });
    },
    subscribe(def) {
      subscriptions.set(def.id, def);
      declared.subscriptions.push({ id: def.id, events: def.events });
    },
    retriever(def) {
      if (typeof def.search !== "function") throw new Error("retriever 缺少 search");
      retrievers.set(def.id, def);
      declared.retrievers.push({ id: def.id, label: def.label });
    },
    reranker(def) {
      if (typeof def.score !== "function") throw new Error("reranker 缺少 score");
      rerankers.set(def.id, def);
      declared.rerankers.push({ id: def.id, label: def.label });
    },
    reviewProvider(def) {
      if (typeof def.publish !== "function" || typeof def.readThread !== "function") throw new Error("评审提供者缺少方法");
      reviews.set(def.id, def);
      declared.reviews.push({ id: def.id, label: def.label, objectKind: def.objectKind, resolves: !!def.resolve });
    },
    itemProvider(def) {
      items.set(def.id, def);
      declared.items.push({ id: def.id, label: def.label, statuses: def.statuses, targetHint: def.targetHint, writable: !!def.setStatus });
    },
    metricProvider: unsupported("指标数据源"),
    object(def) {
      validateObject(def);
      if (objects.has(def.kind)) throw new Error(`对象类型重复注册：${def.kind}`);
      objects.set(def.kind, def);
      const { match, read, ...metadata } = def;
      declared.objects.push(metadata);
    },
    hook(def) {
      validateHook(def);
      if (hooks.has(def.name)) throw new Error(`回调重复注册：${def.name}`);
      hooks.set(def.name, def);
      declared.hooks.push({ name: def.name, ...(def.label ? { label: def.label } : {}) });
    },
    z,
    tool(t) {
      tools.set(t.name, t as PluginTool);
      declared.tools.push({ name: t.name, description: t.description, jsonSchema: z.toJSONSchema(t.schema), write: !!t.write, page: !!t.page, approval: !!t.approval, whenConnected: !!t.whenConnected });
    },
    channel: unsupported("聊天渠道"),
    block: unsupported("内容块"),
    slot: unsupported("界面插槽"),
    connector: unsupported("新的连接器"),
    authenticator: unsupported("鉴权方式"),
    agentLogin: unsupported("AI 账号的登录方式"),
    settings: unsupported("api.settings（隔离运行时在工具的 ctx.settings() 里读）"),
    appConfig: unsupported("连接器的应用配置"),
    service: (name) => ({ ensure: () => rpc("service.ensure", { name }) }),
    fetch: (...a) => fetch(...a),
    platform(def) {
      for (const r of def.readers) readers.set(`${def.provider} ${r.kind}`, r);
      declared.platforms.push({ ...def, readers: def.readers.map((r) => ({ kind: r.kind, label: r.label, id: r.id, read: !!r.read, changes: !!r.changes })) });
    },
    platforms: () => platforms,
    text: { html: htmlToMarkdown },
  };
  const mod = (await import(pathToFileURL(file).href)) as { default?: (api: PluginApi) => unknown };
  if (typeof mod.default !== "function") throw new Error(`插件 ${plugin} 的 server 没有默认导出 register(api)`);
  await mod.default(api);
  send({ t: "ready", ...declared, dir });
}

process.on("message", async (m: Msg) => {
  if (m.t === "cancel") { activeSearch.get(m.id!)?.abort(); activeSearch.delete(m.id!); return; }
  if (m.t === "rpc-result") {
    const w = waiting.get(m.id!);
    waiting.delete(m.id!);
    if (m.ok) w?.ok(m.value);
    else w?.fail(new Error(m.error));
    return;
  }
  try {
    let value: unknown;
    const search = m.t === "retriever" || m.t === "reranker" ? new AbortController() : null;
    if (search) activeSearch.set(m.id!, search);
    if (m.t === "notifier") {
      const controller = new AbortController();
      activeSearch.set(m.id!, controller);
      const def = notifiers.get(m.name)!;
      const [arg, n] = m.args;
      switch (m.method) {
        case "resolve": value = await def.resolve!(arg, controller.signal); break;
        case "deliver": value = await def.deliver(arg, controller.signal); break;
        case "ask": value = await def.ask!(arg, controller.signal); break;
        case "update": await def.update!(arg, n, controller.signal); break;
        case "retract": await def.retract!(arg, controller.signal); break;
      }
    } else if (search || m.t === "event" || m.t === "review" || m.t === "item" || m.t === "parse" || m.t === "check") {
      const ctx: import("./types.ts").CallContext = {
        userId: m.userId, spaceId: m.spaceId, signal: search?.signal ?? AbortSignal.timeout(15000),
        async connection(provider) {
          const c = await rpc("connection", { call: m.id, provider });
          return c ? connectionOf(c, m.id!) : null;
        },
      };
      if (m.t === "retriever") {
        const refs = await retrievers.get(m.name)!.search(ctx, m.arg);
        if (!Array.isArray(refs)) throw new Error("召回结果需要是数组");
        value = refs.slice(0, m.arg.limit);
      }
      else if (m.t === "reranker") value = await rerankers.get(m.name)!.score(ctx, m.arg);
      else if (m.t === "parse") value = await parsers.get(m.name)!.parse(ctx, { ...m.arg, bytes: Buffer.from(m.arg.bytes, "base64") });
      else if (m.t === "check") value = await kinds.get(m.name)!.check!(ctx, m.arg);
      else if (m.t === "event") await subscriptions.get(m.name)!.handle(ctx, m.event);
      else if (m.t === "item") {
        const def = items.get(m.name)!;
        value = m.method === "pull" ? await def.pull(ctx, m.arg) : await def.setStatus!({ ...ctx, idempotencyKey: m.key }, m.arg);
      } else {
        const def = reviews.get(m.name)!;
        if (m.method === "readThread") value = await def.readThread(ctx, m.arg);
        else {
          const write = { ...ctx, idempotencyKey: m.key };
          value = m.method === "publish" ? await def.publish(write, m.arg) : await def.resolve!(write, m.arg, m.note);
        }
      }
    } else if (m.t === "call") {
      const t = tools.get(m.tool);
      if (!t) throw new Error(`没有工具 ${m.tool}`);
      const parsed = t.schema.safeParse(m.args ?? {});
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      value = await t.handler(contextOf({ ...m.ctx, call: m.id }, process.env.OMEM_PLUGIN_ID!), parsed.data);
    } else if (m.t === "object.match" || m.t === "object.read") {
      const def = objects.get(m.kind);
      if (!def) throw new Error(`没有对象类型 ${m.kind}`);
      value = m.t === "object.match" ? await def.match(m.url) : await def.read(contextOf({ ...m.ctx, call: m.id }, process.env.OMEM_PLUGIN_ID!), m.key);
    } else if (m.t === "hook") {
      const def = hooks.get(m.name);
      if (!def) throw new Error(`没有回调 ${m.name}`);
      value = (await def.handle(contextOf({ ...m.ctx, call: m.id }, process.env.OMEM_PLUGIN_ID!), m.req)) ?? null;
    } else if (m.t === "read" || m.t === "changes") {
      const r = readers.get(`${m.provider} ${m.kind}`);
      const conn = connectionOf(m.conn, m.id!);
      if (m.t === "read" && r?.read) value = await r.read(conn, m.target);
      else if (m.t === "changes" && r?.changes) value = await r.changes(conn, m.target, m.cursor ?? null);
      else throw new Error(`没有读取器 ${m.provider} ${m.kind}`);
    } else return;
    send({ t: "result", id: m.id, ok: true, value });
  } catch (e) {
    send({ t: "result", id: m.id, ok: false, code: (e as {code?: string})?.code, error: (e as Error).message ?? String(e) });
  } finally { activeSearch.delete(m.id!); }
});

main().catch((e) => {
  send({ t: "failed", error: (e as Error).message ?? String(e) });
  process.exitCode = 1;
});
