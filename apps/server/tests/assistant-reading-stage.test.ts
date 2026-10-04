import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { AcpAssistantModel } from "../src/assistant/acp-model.js";
import { evidenceForRange } from "../src/assistant/research.js";
import { acp } from "../src/agents.js";

vi.mock("../src/agents.js", async (original) => ({
  ...(await original<typeof import("../src/agents.js")>()),
  acp: vi.fn(),
}));

it.each(["answer", "handoff", "unavailable", "cancel"] as const)(
  "reading stage %s uses the real MCP scope and preserves the handoff snapshot",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "omem-reading-stage-"));
    const store = new Store(join(root, "data"));
    const capture = (text: string) =>
      store.capture({
        source: "manual",
        externalId: "schedule",
        title: "日程",
        parts: [{ type: "text", text }],
        context: {},
      });
    capture("周五开会。\n地址待确认。");
    const repository = new KnowledgeRepository(store),
      material = repository.materials()[0]!;
    const controller = new AbortController();
    const calls: string[] = [];
    let workspace = "";
    vi.mocked(acp).mockImplementation(
      async (profile, cwd, _blocks, _emit, _signal, options) => {
        workspace = cwd;
        calls.push(profile.id);
        if (mode === "unavailable" && profile.id === "reader")
          throw Error("reader unavailable");
        if (mode === "cancel") {
          controller.abort();
          throw Error("cancelled");
        }
        const client = new Client({
          name: "reading-stage-check",
          version: "1",
        });
        try {
          const server = options!.mcpServers![0]!;
          if (server.type !== "http") throw Error("Expected HTTP MCP");
          await client.connect(
            new StreamableHTTPClientTransport(new URL(server.url)),
          );
          const reply = {
            answer: "周五开会。[[cite_1]]",
            citations: [
              { id: "cite_1", key: material.key, startLine: 1, endLine: 1 },
            ],
            create_task: null,
            update_task: null,
          };
          if (profile.id === "reader" && mode === "handoff") {
            const action = await client.callTool({
              name: "submit_result",
              arguments: {
                result: {
                  ...reply,
                  create_task: {
                    title: "开会",
                    detail: "",
                    citation_ids: [],
                    due_at: null,
                    due_expression: null,
                    follow_up: null,
                  },
                },
              },
            });
            expect(action.isError).toBe(true);
            const handed = await client.callTool({
              name: "handoff_to_research",
              arguments: {
                known: `${material.key}:1 周五开会`,
                missing: "需要核对地址",
              },
            });
            expect(handed.isError).not.toBe(true);
            capture("安排改为周六，地址已确认。");
          } else {
            if (mode === "handoff") {
              expect(
                readFileSync(join(cwd, "reading-handoff.json"), "utf8"),
              ).toContain("需要核对地址");
              const read = await client.callTool({
                name: "read_material",
                arguments: { key: material.key },
              });
              expect(JSON.stringify(read)).toContain("周五开会");
              expect(JSON.stringify(read)).not.toContain("周六");
            }
            const submitted = await client.callTool({
              name: "submit_result",
              arguments: { result: reply },
            });
            expect(submitted.isError).not.toBe(true);
          }
        } finally {
          await client.close();
        }
        return {
          sessionId: profile.id,
          configOptions: [
            { id: "model", category: "model", currentValue: profile.model },
            {
              id: "reasoning_effort",
              category: "reasoning_effort",
              currentValue: profile.effort,
            },
          ],
          timings: {
            initializeMs: 0,
            sessionSetupMs: 0,
            promptMs: 0,
            firstToolMs: 0,
            toolCalls: 1,
            failedToolCalls: 0,
          },
        } as Awaited<ReturnType<typeof acp>>;
      },
    );
    try {
      const profile = (id: string) =>
        profileSchema.parse({
          id,
          name: id,
          transport: "acp",
          command: "traex",
          model: "fixture",
          effort: id === "reader" ? "low" : "medium",
        });
      const adapter = new AcpAssistantModel({
        profile: profile("researcher"),
        readingProfile: profile("reader"),
        workspaceRoot: root,
        repository,
        retrievalConfig: { enabled: false },
      });
      const pending = adapter.generate({
        userText: "会议安排？",
        priorTurns: [],
        evidence: [evidenceForRange(material, 1, 2, () => true)],
        visibility: "private",
        signal: controller.signal,
      });
      if (mode === "cancel") await expect(pending).rejects.toThrow("cancelled");
      else {
        const result = await pending;
        expect(result.researchedEvidence?.[0]?.text).toBe("周五开会。");
        expect(result.researchTrace?.stages?.map((s) => s.outcome)).toEqual(
          mode === "handoff"
            ? ["handoff", "answered"]
            : mode === "unavailable"
              ? ["failed", "answered"]
              : ["answered"],
        );
      }
      expect(calls).toEqual(
        mode === "handoff" || mode === "unavailable"
          ? ["reader", "researcher"]
          : ["reader"],
      );
      expect(existsSync(join(workspace, "snapshot.sqlite"))).toBe(false);
    } finally {
      vi.mocked(acp).mockReset();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
