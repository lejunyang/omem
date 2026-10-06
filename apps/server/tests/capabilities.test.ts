import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { CapabilitySession } from "../src/capabilities/session.js";
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
  delete process.env.OMEM_CAPABILITY_TEST_SECRET;
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "omem-capabilities-test-"));
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new CapabilityRegistry(join(directory, "data"));
  const skill = join(directory, "skill");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "Read references/nodes.md before the design.",
  );
  writeFileSync(join(skill, "references/nodes.md"), "Use node PANEL-7.");
  const definition = {
    version: 1,
    id: "design",
    name: "Design",
    description: "Read design nodes",
    skills: [{ name: "design-reading", directory: skill }],
  };
  return {
    directory,
    registry,
    skill,
    definition,
    session() {
      const s = new CapabilitySession(
        registry,
        registry.references(["design"]),
        { directory: join(directory, "receipts"), cwd: directory },
      );
      clean.push(() => s.close());
      return s;
    },
  };
}
it("pins skill resources and tool declarations; disabling also stops already selected capabilities", async () => {
  const s = setup();
  const first = s.registry.register(s.definition);
  const session = s.session();
  writeFileSync(join(s.skill, "references/nodes.md"), "Use node PANEL-9.");
  const next = s.registry.register(s.definition);
  expect(next.revision).not.toBe(first.revision);
  const read = session.tools().find((t) => t.name === "capability_read_skill")!;
  expect(
    await read.run(
      { id: "design", skill: "design-reading", path: "references/nodes.md" },
      {} as any,
    ),
  ).toEqual({ text: "Use node PANEL-7." });
  expect(
    s.registry.readSkill(
      s.registry.read("design"),
      "design-reading",
      "references/nodes.md",
    ),
  ).toBe("Use node PANEL-9.");
  s.registry.disable("design");
  await expect(session.inspect("design")).rejects.toThrow("停用");
});
it("runs declared CLI argv without shell interpolation, preserves failure and redacts credentials in receipts", async () => {
  const s = setup();
  process.env.OMEM_CAPABILITY_TEST_SECRET = 'secret"\\private';
  s.registry.register({
    ...s.definition,
    checks: [
      {
        name: "login",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
      },
    ],
    cli: [
      {
        name: "read",
        description: "Read",
        command: process.execPath,
        readOnly: true,
        env: { TOKEN: "OMEM_CAPABILITY_TEST_SECRET" },
        args: [
          "-e",
          "console.log(JSON.stringify({arg:process.argv[1],token:process.env.TOKEN}));process.exit(7)",
          { input: "node", description: "Node" },
        ],
      },
    ],
  });
  const session = s.session();
  expect((await session.inspect("design")).available).toBe(false);
  const receipt: any = await session.call("design", "cli", "read", {
    node: "$(touch accidental);x",
  });
  expect(receipt.result.exitCode).toBe(7);
  expect(JSON.parse(receipt.result.stdout)).toEqual({
    arg: "$(touch accidental);x",
    token: "[REDACTED]",
  });
  expect(
    readFileSync(join(session.directory, receipt.recordId + ".json"), "utf8"),
  ).not.toContain("private");
  expect(
    ((await session.call("design", "cli", "undeclared", {})) as any).result
      .isError,
  ).toBe(true);
  s.registry.register({
    ...s.definition,
    cli: [
      {
        name: "missing",
        description: "Missing",
        command: "omem-not-an-installed-executable",
        readOnly: true,
        args: [],
      },
    ],
  });
  const missing: any = await s.session().inspect("design");
  expect(missing.available).toBe(false);
  expect(missing.missingExecutables).toEqual(["missing"]);
});
it("discovers paginated MCP tools, enforces the configured selection, and keeps images and receipts for independent reading", async () => {
  const s = setup();
  s.registry.register({
    ...s.definition,
    mcp: {
      transport: "stdio",
      command: process.execPath,
      args: [resolve("apps/server/tests/fixtures/capability-mcp.mjs")],
      readOnlyTools: ["read_design"],
    },
  });
  const session = s.session();
  const status: any = await session.inspect("design");
  expect(status.available).toBe(true);
  expect(status.tools.map((t: any) => t.name)).toEqual(["read_design"]);
  expect(
    ((await session.call("design", "mcp", "edit_design", {})) as any).result
      .isError,
  ).toBe(true);
  const receipt: any = await session.call("design", "mcp", "read_design", {
    node: "PANEL-7",
  });
  expect(JSON.parse(receipt.result.content[0].text).gap).toBe(24);
  expect(
    readFileSync(receipt.result.content[1].path).subarray(1, 4).toString(),
  ).toBe("PNG");
  await session.close();
  const independent = s.session();
  const read = independent
    .tools()
    .find((t) => t.name === "capability_receipts")!;
  expect(await read.run({ recordId: receipt.recordId }, {} as any)).toEqual(
    receipt,
  );
});
it("connects to Streamable HTTP with referenced bearer credentials and closes transports", async () => {
  const s = setup();
  let authorized = false;
  const http = createServer(async (req, res) => {
    authorized = req.headers.authorization === "Bearer private-token";
    if (!authorized) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = new McpServer({ name: "http-fixture", version: "1" });
    server.registerTool("read_project", { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "Project status: active" }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    await server.connect(transport);
    await transport.handleRequest(
      req,
      res,
      JSON.parse(Buffer.concat(chunks).toString()),
    );
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  clean.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });
  process.env.OMEM_CAPABILITY_TEST_SECRET = "private-token";
  s.registry.register({
    ...s.definition,
    mcp: {
      transport: "http",
      url: `http://127.0.0.1:${(http.address() as any).port}/mcp`,
      bearerTokenEnv: "OMEM_CAPABILITY_TEST_SECRET",
      readOnlyTools: ["read_project"],
    },
  });
  const session = s.session();
  expect((await session.inspect("design")).available).toBe(true);
  expect(
    ((await session.call("design", "mcp", "read_project", {})) as any).result
      .content[0].text,
  ).toBe("Project status: active");
  expect(authorized).toBe(true);
});
