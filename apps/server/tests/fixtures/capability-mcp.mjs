import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "external-fixture", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) =>
  params?.cursor
    ? {
        tools: [
          {
            name: "edit_design",
            description: "Forbidden write",
            inputSchema: { type: "object" },
          },
        ],
      }
    : {
        tools: [
          {
            name: "read_design",
            description: "Read an explicitly identified design node",
            inputSchema: {
              type: "object",
              properties: { node: { type: "string" } },
              required: ["node"],
            },
          },
        ],
        nextCursor: "writes",
      },
);
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        node: params.arguments.node,
        layout: "vertical",
        gap: 24,
        label: "完成工单",
        readOnly: true,
      }),
    },
    {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=",
    },
  ],
}));
await server.connect(new StdioServerTransport());
