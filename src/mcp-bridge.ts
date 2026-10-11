/**
 * stdio MCP server that forwards to a running omem service. Agents that only
 * speak stdio MCP launch this; it carries the per-run token, so the service
 * still decides which tools and spaces the agent may use.
 *
 * Env: OMEM_URL (e.g. http://127.0.0.1:4317), OMEM_TOKEN.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./agents/mcp-server.ts";

export async function runBridge(url = process.env.OMEM_URL ?? "http://127.0.0.1:4317", token = process.env.OMEM_TOKEN ?? "") {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const server = createMcpServer({
    async list() {
      const res = await fetch(`${url}/api/tools`, { headers });
      if (!res.ok) throw new Error(`omem 服务不可用：HTTP ${res.status}`);
      return ((await res.json()) as { tools: never[] }).tools;
    },
    async call(name, args) {
      const res = await fetch(`${url}/api/tools/${encodeURIComponent(name)}`, { method: "POST", headers, body: JSON.stringify(args ?? {}) });
      if (!res.ok) return { text: `调用失败：HTTP ${res.status} ${await res.text()}`, isError: true };
      return (await res.json()) as { text: string; isError: boolean };
    },
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("mcp-bridge.ts") || process.argv[1]?.endsWith("mcp-bridge.js")) {
  runBridge().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
