import { pathToFileURL } from "node:url";
import { z } from "zod";
import { htmlToMarkdown } from "../sources/html.ts";
import type { PlatformReader, PluginApi, PluginConnection, PluginPlatform, PluginTool } from "./types.ts";

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
function connectionOf(c: { handle: string; account: string; scopes: string[]; base: string | null }): PluginConnection {
  return {
    account: c.account,
    scopes: c.scopes,
    base: c.base,
    async fetch(path, init = {}) {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : String(init.body);
      const r = await rpc<{ status: number; headers: [string, string][]; body: string }>("fetch", { handle: c.handle, path, init: { method: init.method, headers, body } });
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
    conversationId: c.conversationId,
    settings: () => c.settings,
    store: { get: store("get"), put: store("put"), list: store("list"), delete: store("delete") },
    block: unsupported("内容块"),
    setBlockResult: unsupported("内容块"),
    present: unsupported("内容块"),
    connection: async (provider: string) => {
      const info = await rpc<{ handle: string; account: string; scopes: string[]; base: string | null } | null>("connection", { provider, call });
      return info ? connectionOf(info) : null;
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

async function main() {
  const dir = process.env.OMEM_PLUGIN_DIR!;
  const file = process.env.OMEM_PLUGIN_SERVER!;
  const plugin = process.env.OMEM_PLUGIN_ID!;
  const declared: { tools: unknown[]; platforms: unknown[] } = { tools: [], platforms: [] };
  const platforms = JSON.parse(process.env.OMEM_PLATFORMS ?? "[]") as PluginPlatform[];
  const api: PluginApi = {
    id: plugin,
    z,
    tool(t) {
      tools.set(t.name, t as PluginTool);
      declared.tools.push({ name: t.name, description: t.description, jsonSchema: z.toJSONSchema(t.schema), write: !!t.write, page: !!t.page, approval: !!t.approval });
    },
    block: unsupported("内容块"),
    connector: unsupported("新的连接器"),
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
  if (m.t === "rpc-result") {
    const w = waiting.get(m.id!);
    waiting.delete(m.id!);
    if (m.ok) w?.ok(m.value);
    else w?.fail(new Error(m.error));
    return;
  }
  try {
    let value: unknown;
    if (m.t === "call") {
      const t = tools.get(m.tool);
      if (!t) throw new Error(`没有工具 ${m.tool}`);
      const parsed = t.schema.safeParse(m.args ?? {});
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      value = await t.handler(contextOf({ ...m.ctx, call: m.id }, process.env.OMEM_PLUGIN_ID!), parsed.data);
    } else if (m.t === "read" || m.t === "changes") {
      const r = readers.get(`${m.provider} ${m.kind}`);
      const conn = connectionOf(m.conn);
      if (m.t === "read" && r?.read) value = await r.read(conn, m.target);
      else if (m.t === "changes" && r?.changes) value = await r.changes(conn, m.target, m.cursor ?? null);
      else throw new Error(`没有读取器 ${m.provider} ${m.kind}`);
    } else return;
    send({ t: "result", id: m.id, ok: true, value });
  } catch (e) {
    send({ t: "result", id: m.id, ok: false, error: (e as Error).message ?? String(e) });
  }
});

main().catch((e) => {
  send({ t: "failed", error: (e as Error).message ?? String(e) });
  process.exitCode = 1;
});
