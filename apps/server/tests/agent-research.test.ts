import { it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { prepareAgentResearch } from "../src/knowledge/agent-research.js";

it("serves a fixed original and submission, then releases task copies without removing canonical evidence or audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-research-lifecycle-")),
    store = new Store(join(root, "data")),
    workspace = join(root, "task");
  const client = new Client({ name: "lifecycle-check", version: "1" });
  let env: Awaited<ReturnType<typeof prepareAgentResearch>> | undefined;
  try {
    const original = store.capture({
      source: "manual",
      externalId: "travel-note",
      title: "渡轮安排",
      parts: [{ type: "text", text: "周五乘渡轮，提前预订船票。" }],
      context: {},
    });
    const repository = new KnowledgeRepository(store),
      material = repository.materials()[0]!;
    const schema = z.object({ summary: z.string() });
    env = await prepareAgentResearch({
      repository,
      materials: [material],
      articles: [],
      workspace,
      schema,
      validate: (x) => schema.parse(x),
      retrievalConfig: { enabled: false },
    });
    const server = env.servers[0]!;
    if (server.type !== "http") throw Error("HTTP MCP expected");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    const read = await client.callTool({
      name: "read_material",
      arguments: { key: material.key },
    });
    expect(JSON.stringify(read)).toContain("提前预订船票");
    expect(existsSync(join(workspace, "snapshot.sqlite"))).toBe(true);
    await client.callTool({
      name: "submit_result",
      arguments: { result: { summary: "提前买船票" } },
    });
    expect(env.result()).toEqual({ summary: "提前买船票" });
    await env.close();
    expect(existsSync(join(workspace, "originals"))).toBe(false);
    expect(existsSync(join(workspace, "snapshot.sqlite"))).toBe(false);
    expect(readFileSync(join(workspace, "research.jsonl"), "utf8")).toContain(
      "submission",
    );
    expect(existsSync(join(workspace, "result.json"))).toBe(true);
    expect(
      store.evidence(original.revision.fragments[0]!.id)?.fragment.text,
    ).toContain("预订船票");
  } finally {
    await client.close();
    await env?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
