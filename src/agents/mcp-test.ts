import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { App } from "../core/app.ts";
import { mcpServersFor } from "./mcp-servers.ts";

/** An owner-initiated probe: no tools are called, credentials never leave the host. */
export async function testMcpServer(app: App, name: string) {
  try { return await probe(app, name); }
  catch { return { ok: false as const, error: "无法连接 MCP 服务，请检查命令或网址" }; }
}

async function probe(app: App, name: string) {
  const spec = mcpServersFor(app, [name])[name];
  if (!spec) return { ok: false as const, error: "没有这个 MCP 服务" };
  const secrets = Object.values("command" in spec ? spec.env : spec.headers).filter(Boolean);
  const redact = (text: string) => secrets.flatMap((v) => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)])
    .sort((a, b) => b.length - a.length).reduce((s, v) => s.split(v).join("[密钥]"), text);
  const abort = new AbortController();
  const client = new Client({ name: "omem-probe", version: "1" });
  let transport: Transport;
  let child: StdioClientTransport | undefined;
  if ("command" in spec) {
    child = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: "pipe" });
    // Drain stderr without exposing it to logs or the response, even when it echoes credentials.
    child.stderr?.on("data", () => {});
    transport = child;
  } else {
    transport = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers, signal: abort.signal } });
  }
  const kill = () => { if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch {} } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); kill(); reject(new Error("检测超时（20 秒）")); }, 20_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      try {
        await client.connect(transport);
      } catch (e) {
        if ("url" in spec && [404, 405].includes(Number((e as { code?: number }).code)) && !abort.signal.aborted) {
          await client.close();
          transport = new SSEClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers, signal: abort.signal }, eventSourceInit: { fetch: (url, init) => { const headers = new Headers(init?.headers); for (const [key, value] of Object.entries(spec.headers)) headers.set(key, value); return fetch(url, { ...init, headers, signal: abort.signal }); } } });
          await client.connect(transport);
        } else throw e;
      }
      const tools: { name: string; description?: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal: abort.signal });
        tools.push(...page.tools.map((t) => ({ name: redact(t.name), description: t.description ? redact(t.description) : undefined })));
        cursor = page.nextCursor;
      } while (cursor && !abort.signal.aborted);
      kill();
      await client.close();
      return { ok: true as const, tools };
    })()]);
  } catch (e) {
    return { ok: false as const, error: redact((e as Error).message || "检测失败") };
  } finally {
    clearTimeout(timer);
    abort.abort();
    kill();
    void client.close().catch(() => {});
    void transport.close().catch(() => {});
  }
}
