import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
if (process.env.PROBE_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  const server = new Server({ name: "test-probe", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (process.env.PROBE_MODE === "error") {
      console.error(process.env.PROBE_SECRET);
      throw new Error(`检测失败 ${process.env.PROBE_SECRET}`);
    }
    return { tools: [{ name: "lookup", description: "查询示例材料", inputSchema: { type: "object" } }] };
  });
  await server.connect(new StdioServerTransport());
}
