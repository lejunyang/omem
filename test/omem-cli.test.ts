import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { boot } from "../src/main.ts";

/**
 * The light client (packages/cli, npm @omem-ai/cli): only the remote modules of the app go into its
 * bundle, and its `omem tool` / `omem mcp` work against a real server with a person's own token.
 */
const root = resolve(import.meta.dirname, "..");
const entry = join(root, "packages/cli/src/main.ts");
// Not spawnSync: the server runs in this process and must keep answering.
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
    execFile(process.execPath, [entry, ...args], { env, encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) =>
      done({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

describe("@omem-ai/cli", async () => {
  it("imports nothing of the app but the remote client", () => {
    const allowed = ["src/agents/mcp-server.ts", "src/agents/tool-cli.ts", "src/core/home.ts", "src/remote-client.ts", "src/remote-commands.ts", "packages/cli/src/main.ts"];
    const seen = new Set<string>();
    const walk = (file: string) => {
      const rel = file.slice(root.length + 1).replaceAll("\\", "/");
      if (seen.has(rel)) return;
      seen.add(rel);
      for (const m of readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
        else expect(spec.startsWith("node:") || spec === "commander" || spec.startsWith("@modelcontextprotocol/sdk/"), `${rel} imports ${spec}`).toBe(true);
      }
    };
    walk(entry);
    expect([...seen].sort()).toEqual([...allowed].sort());
  });

  const home = mkdtempSync(join(tmpdir(), "omem-cli-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ webUrl: "http://omem.test", auth: { enabled: true } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  createSpace(app, { id: "proj-a", name: "项目 A" });
  createSpace(app, { id: "proj-b", name: "项目 B" });
  createUser(app, { id: "wang", name: "小王" });
  addMember(app, "proj-a", "wang", "contributor");
  const token = createApiToken(app, "wang", "test");
  // Its own client directory: never the server's.
  const clientHome = mkdtempSync(join(tmpdir(), "omem-cli-client-"));
  const env = { ...process.env, OMEM_HOME: clientHome, OMEM_TOKEN: token, OMEM_URL: "" };

  it("calls a tool on the server as that person", async () => {
    const r = await run(["tool", "list_spaces", "--url", app.baseUrl!], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("proj-a");
    expect(r.stdout).not.toContain("proj-b");
  });

  it("says what to do without an address", async () => {
    const r = await run(["tool", "list_spaces"], { ...env, OMEM_TOKEN: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("没有远程地址");
  });

  it("serves the server's tools over stdio MCP", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "mcp", "--url", app.baseUrl!, "--session", "MCP 测试"], env: env as Record<string, string> });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["search", "list_spaces"]));
      const r = (await client.callTool({ name: "list_spaces", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("proj-a");
    } finally {
      await client.close();
    }
  });
});
