import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type ToolBackend = {
  list(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>;
  call(name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
};

/** An MCP server whose tools are served by a backend (in-process registry or HTTP). */
export function createMcpServer(backend: ToolBackend) {
  const server = new Server(
    { name: "omem", version: "0.2.0" },
    { capabilities: { tools: {} }, instructions: "omem 知识库工具：检索与阅读原件/Wiki/记忆/事项，并在任务允许时写入。" },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await backend.list()) as never }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const r = await backend.call(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text", text: r.text }], isError: r.isError };
  });
  return server;
}
