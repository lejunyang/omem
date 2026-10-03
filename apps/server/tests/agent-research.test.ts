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
import { parseFile } from "../src/code/parse.js";

it("exposes aliases, receivers and branch context without asserting that a call runs", () => {
  const parsed = parseFile(
    "shipping.ts",
    [
      'import { Dispatcher as Delivery } from "./dispatch.js";',
      "export function boot(config) {",
      "  const worker = config.enabled ? new Delivery(config) : null;",
      "  if (config.ready) { worker?.start(); }",
      "}",
    ].join("\n"),
  );
  expect(parsed.imports[0]?.bindings).toEqual([
    { local: "Delivery", imported: "Dispatcher" },
  ]);
  expect(parsed.calls.find((c) => c.callee === "Delivery")).toMatchObject({
    kind: "construct",
    callerQName: "boot",
    context: expect.arrayContaining([
      {
        kind: "surrounding-condition:true",
        text: "config.enabled",
        rangeStart: { line: 3, col: 17 },
        rangeEnd: { line: 3, col: 31 },
      },
    ]),
  });
  expect(parsed.calls.find((c) => c.callee === "start")).toMatchObject({
    receiver: "worker",
    expression: "worker?.start",
    context: expect.arrayContaining([
      expect.objectContaining({
        kind: "surrounding-condition:then",
        text: "config.ready",
      }),
    ]),
  });
});

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

it("lets a research agent request caller candidates and read their fixed enclosing operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-research-callers-"));
  const store = new Store(join(root, "data"));
  const client = new Client({ name: "caller-flow", version: "1" });
  let env: Awaited<ReturnType<typeof prepareAgentResearch>> | undefined;
  try {
    store.capture({
      source: "file",
      externalId: "shipping",
      title: "shipping.ts",
      context: { filePath: "shipping.ts" },
      parts: [
        {
          type: "text",
          text: 'export function reserveParcel() { return "reserved"; }\nexport function checkout() { return reserveParcel(); }',
        },
      ],
    });
    const repository = new KnowledgeRepository(store);
    const schema = z.object({ summary: z.string() });
    env = await prepareAgentResearch({
      repository,
      materials: repository.materials(),
      articles: [],
      workspace: join(root, "task"),
      schema,
      validate: (x) => schema.parse(x),
      retrievalConfig: { enabled: false },
    });
    const server = env.servers[0]!;
    if (server.type !== "http") throw Error("HTTP MCP expected");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    const result = await client.callTool({
      name: "search_materials",
      arguments: {
        query: "reserveParcel",
        codeIntent: "callers",
        keys: ["originals/shipping.ts"],
      },
    });
    const data = JSON.parse(
      (result.content as { type: string; text: string }[]).find(
        (c) => c.type === "text",
      )!.text,
    );
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0].codeMatches).toEqual([
      {
        symbol: "reserveparcel",
        kind: "call",
        status: "candidate",
        lines: [2],
      },
    ]);
    const read = await client.callTool({
      name: "read_section",
      arguments: {
        key: data.hits[0].path,
        atLine: data.hits[0].codeMatches[0].lines[0],
      },
    });
    expect(JSON.stringify(read)).toContain("return reserveParcel()");
    const body = JSON.parse((read.content as { text: string }[])[0]!.text);
    expect(body.startLine).toBe(2);
    expect(body.endLine).toBe(2);
    expect(body.key).toBe(data.hits[0].key);
    const unknown = await client.callTool({
      name: "search_materials",
      arguments: { query: "reserveParcel", keys: ["invented:shipping.ts"] },
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).toContain("Unknown material locator");
  } finally {
    await client.close();
    await env?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
