import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { pluginConnection } from "../auth/connections.ts";
import { registerTool, saveSourceFor, watchesFor, type ToolContext } from "../agents/tools.ts";
import { OWNER } from "../core/users.ts";
import { platformList, registerPlatform } from "./platforms.ts";
import { ensureService } from "./services.ts";
import { pluginStore } from "./store.ts";
import type { PluginConnection, PluginPlatform } from "./types.ts";

/**
 * Running a plugin's code in its own process (docs/v2/plugins.md, “隔离运行”): Node's permission model
 * lets it read its directory and omem's package, write <data>/plugin-data/<id>, and nothing else; no
 * child processes. Its tools and platform readers register here as stand-ins that ask the process;
 * what the process asks back (a platform request with someone's token, its records, saving a source)
 * is answered as the person and space of the call in progress, never as whoever it names.
 */
const here = dirname(fileURLToPath(import.meta.url));
const runner = () => ["sandbox-runner.js", "sandbox-runner.ts"].map((f) => join(here, f)).find((f) => existsSync(f))!;

type Declared = {
  tools: { name: string; description: string; jsonSchema: Record<string, unknown>; write: boolean; page: boolean; approval: boolean; whenConnected: boolean }[];
  platforms: (Omit<PluginPlatform, "readers"> & { readers: { kind: string; label: string; id: string; read: boolean; changes: boolean }[] })[];
};
type Pending = { ok: (v: any) => void; fail: (e: Error) => void; ctx?: ToolContext; timer: NodeJS.Timeout };

export type Sandbox = { tools: Declared["tools"]; platforms: string[]; stop(): void };

const CALL_MS = 5 * 60_000;

export async function startSandbox(
  app: App,
  plugin: { id: string; dir: string; server: string; services: { name: string }[] },
  opts: { prefix: string; packageRoot: string; connected: (app: App, userId: string) => boolean; settings: (userId: string) => Record<string, unknown>; services: (name: string) => Parameters<typeof ensureService>[2] | undefined },
): Promise<Sandbox> {
  const data = join(app.home, "plugin-data", plugin.id);
  mkdirSync(data, { recursive: true });
  const child: ChildProcess = fork(runner(), [], {
    // omem's code and packages only, not the whole checkout: a development data directory can sit inside it.
    execArgv: ["--permission", `--allow-fs-read=${plugin.dir}`, ...["src", "dist", "node_modules", "package.json"].map((x) => `--allow-fs-read=${join(opts.packageRoot, x)}`), `--allow-fs-read=${data}`, `--allow-fs-write=${data}`],
    // Nothing of omem's environment (tokens, keys) goes in.
    env: { OMEM_PLUGIN_ID: plugin.id, OMEM_PLUGIN_DIR: plugin.dir, OMEM_PLUGIN_SERVER: plugin.server, OMEM_PLUGIN_DATA: data, OMEM_PLATFORMS: JSON.stringify(platformList()), NODE_ENV: process.env.NODE_ENV ?? "production" },
    cwd: plugin.dir,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let seq = 0;
  const pending = new Map<number, Pending>();
  const conns = new Map<string, PluginConnection>();
  let dead: string | null = null;

  const ask = (msg: Record<string, unknown>, ctx?: ToolContext) =>
    new Promise<any>((ok, fail) => {
      if (dead) return fail(new Error(`插件 ${plugin.id} 的进程已经退出：${dead}`));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`插件 ${plugin.id} 超过 ${CALL_MS / 60_000} 分钟没有回应`));
      }, CALL_MS);
      pending.set(id, { ok, fail, ctx, timer });
      child.send({ ...msg, id });
    });
  const handle = (c: PluginConnection) => {
    const h = `c${++seq}`;
    conns.set(h, c);
    // Kept for the call or reading that asked; old ones go.
    if (conns.size > 500) conns.delete(conns.keys().next().value!);
    return { handle: h, account: c.account, scopes: c.scopes, base: c.base };
  };

  /** What the process asks back, answered as the call in progress. */
  async function answer(op: string, a: Record<string, any>) {
    const ctx = pending.get(a.call)?.ctx;
    const need = () => {
      if (!ctx) throw new Error("这个请求不属于正在进行的调用");
      return ctx;
    };
    switch (op) {
      case "fetch": {
        const c = conns.get(a.handle);
        if (!c) throw new Error("连接已经失效");
        const r = await c.fetch(a.path, a.init ?? {});
        const headers: [string, string][] = [];
        r.headers.forEach((v, k) => headers.push([k, v]));
        return { status: r.status, headers, body: Buffer.from(await r.arrayBuffer()).toString("base64") };
      }
      case "connection": {
        const x = need();
        const c = pluginConnection(app, x.userId ?? OWNER, String(a.provider));
        return c ? handle(c) : null;
      }
      case "store.get":
      case "store.put":
      case "store.list":
      case "store.delete": {
        const x = need();
        const store = pluginStore(app, plugin.id, x.userId ?? OWNER, x.spaceId) as unknown as Record<string, (...args: unknown[]) => unknown>;
        return store[op.slice(6)](...(a.args ?? []));
      }
      case "saveSource":
        return saveSourceFor(need(), a.input);
      case "watches.add":
        return watchesFor(need()).add(a.input);
      case "watches.remove":
        return watchesFor(need()).remove(String(a.id));
      case "watches.list":
        return watchesFor(need()).list(a.provider);
      case "service.ensure": {
        const spec = opts.services(String(a.name));
        if (!spec) throw new Error(`插件 ${plugin.id} 没有声明服务 ${a.name}`);
        const { port, token } = await ensureService(app, { id: plugin.id, dir: plugin.dir }, spec);
        return { url: `http://127.0.0.1:${port}`, token };
      }
    }
    throw new Error(`不支持的请求 ${op}`);
  }

  const declared = await new Promise<Declared>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`插件 ${plugin.id} 30 秒内没有启动`)), 30_000);
    child.on("message", (m: any) => {
      if (m.t === "ready") {
        clearTimeout(timer);
        ok(m);
      } else if (m.t === "failed") {
        clearTimeout(timer);
        fail(new Error(`插件 ${plugin.id} 启动失败：${m.error}`));
      } else if (m.t === "result") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.ok(m.value);
        else p.fail(new Error(m.error));
      } else if (m.t === "rpc")
        answer(m.op, m.args ?? {}).then(
          (value) => child.connected && child.send({ t: "rpc-result", id: m.id, ok: true, value }),
          (e) => child.connected && child.send({ t: "rpc-result", id: m.id, ok: false, error: (e as Error).message }),
        );
    });
    child.on("exit", (code, signal) => {
      dead = `退出码 ${code ?? signal}`;
      clearTimeout(timer);
      fail(new Error(`插件 ${plugin.id} 的进程退出了（${dead}）`));
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.fail(new Error(`插件 ${plugin.id} 的进程退出了（${dead}）`));
      }
      pending.clear();
    });
  }).catch((e) => {
    child.kill();
    throw e;
  });

  const undo: (() => void)[] = [];
  for (const t of declared.tools) {
    if (!t.name.startsWith(opts.prefix)) throw new Error(`插件 ${plugin.id} 的工具名要以 ${opts.prefix} 开头：${t.name}`);
    registerTool(
      {
        name: t.name,
        description: t.description,
        // The process checks the arguments against its own schema; this one lets them through.
        schema: z.object({}).passthrough(),
        jsonSchema: t.jsonSchema,
        write: t.write,
        available: t.whenConnected ? opts.connected : undefined,
        handler: (ctx, args) => ask({ t: "call", tool: t.name, args, ctx: { userId: ctx.userId ?? OWNER, spaceId: ctx.spaceId, runId: ctx.runId, actor: ctx.actor, conversationId: null, settings: opts.settings(ctx.userId ?? OWNER) } }, ctx).then(String),
      },
      { approval: t.approval },
    );
  }
  for (const def of declared.platforms)
    undo.push(
      registerPlatform(plugin.id, {
        ...def,
        readers: def.readers.map((r) => ({
          kind: r.kind,
          label: r.label,
          id: r.id,
          read: r.read ? (c, target) => ask({ t: "read", provider: def.provider, kind: r.kind, target, conn: handle(c) }) : undefined,
          changes: r.changes ? (c, target, cursor) => ask({ t: "changes", provider: def.provider, kind: r.kind, target, cursor, conn: handle(c) }) : undefined,
        })),
      }),
    );
  return {
    tools: declared.tools,
    platforms: declared.platforms.map((p) => p.provider),
    stop() {
      for (const u of undo.splice(0)) u();
      child.kill();
    },
  };
}
