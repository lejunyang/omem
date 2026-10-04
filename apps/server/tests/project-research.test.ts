import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { prepareAgentResearch } from "../src/knowledge/agent-research.js";

it("discovers explicitly grouped originals and keeps per-question scope frozen through live membership changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-project-research-"));
  const store = new Store(join(root, "data")), repository = new KnowledgeRepository(store);
  const client = new Client({ name: "project-reader", version: "1" });
  let env: Awaited<ReturnType<typeof prepareAgentResearch>> | undefined;
  try {
    const west = store.contexts.create({ name: "周末活动", kind: "project", description: "杭州小组" });
    const east = store.contexts.create({ name: "周末活动", kind: "project", description: "上海小组" });
    const topic = store.contexts.create({ name: "出行", kind: "topic", description: "交通和费用" });
    const hidden = store.contexts.create({ name: "未获准材料的项目", kind: "project", description: "不应出现在目录里" });
    const capture = (id: string, text: string, ids: string[]) => store.capture({
      source: "manual", externalId: id, title: "活动安排", context: {}, parts: [{type: "text", text}],
    }, {contextIds: ids});
    const budget = capture("budget", "# 费用\n每人120元，包含午餐，不含交通费。", [west.id, topic.id]);
    capture("meeting", "# 集合\n九点在南门集合。", [west.id]);
    capture("other", "# 费用\n每人999元，包含交通费。", [east.id]);
    capture("unlinked", "# 费用\n同名活动每人600元。", []);
    capture("hidden", "私有安排", [hidden.id]);
    const materials = repository.materials().filter(m => m.key !== "manual:hidden");
    const schema = z.object({answer: z.string()});
    const workspace = join(root, "task");
    env = await prepareAgentResearch({repository, materials, articles: [], workspace, schema, validate: x=>schema.parse(x), retrievalConfig: {enabled: false}});
    const server = env.servers[0]!;
    if (server.type !== "http") throw Error("Expected MCP server");
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({name, arguments: args});
      expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as {text: string}[])[0]!.text);
    };
    // Later user edits must not silently change an investigation already running.
    store.tx(() => store.contexts.setForSource(budget.revision.sourceId, [east.id]));
    capture("later", "新消息费用300元。", [west.id]);
    const groups = await call("list_material_groups", {filter: "周末活动"});
    expect(groups.groups.map((g: {description: string}) => g.description).sort()).toEqual(["上海小组", "杭州小组"]);
    expect(groups.groups.find((g: {id: string})=>g.id===west.id).sourceCount).toBe(2);
    expect(readFileSync(join(workspace, "groups.json"), "utf8")).not.toContain(hidden.id);
    const members = await call("list_materials", {groupIds: [west.id, topic.id]});
    expect(members.materials.map((m: {key: string})=>m.key).sort()).toEqual(["manual:budget", "manual:meeting"]);
    const search = await call("search_contexts", {questions: [
      {question: "杭州活动费用？", query: "费用", groupIds: [west.id]},
      {question: "上海活动费用？", query: "费用", groupIds: [east.id]},
    ]});
    const texts = search.questions.map((q: {matches: {contextId: string}[]}) => q.matches.map(m=>JSON.stringify(search.contexts.find((c: {id: string})=>c.id===m.contextId))).join("\n"));
    expect(texts[0]).toContain("120元");
    expect(texts[0]).toContain("不含交通费");
    expect(texts[0]).not.toMatch(/999元|600元|300元/);
    expect(texts[1]).toContain("999元");
    expect(texts[1]).not.toContain("120元");
    expect((await call("search_materials", {query: "费用", keys: ["manual:other"], groupIds: [west.id]})).hits).toEqual([]);
    expect((await call("list_materials", {groupIds: []})).materials).toEqual([]);
    expect((await client.callTool({name: "search_materials", arguments: {query: "费用", groupIds: ["unknown"]}})).isError).toBe(true);
  } finally {await client.close(); await env?.close(); store.close(); rmSync(root, {recursive: true, force: true});}
});
