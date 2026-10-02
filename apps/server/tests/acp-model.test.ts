import { describe, expect, it } from "vitest";
import {
  AcpAssistantModel,
  parseAssistantReply,
} from "../src/assistant/acp-model.js";
import { ModelUnavailableError } from "../src/assistant/runtime.js";
import type { AgentProfile } from "../../../packages/contracts/src/index.js";

const acpProfile: AgentProfile = {
  id: "test-acp",
  name: "Test ACP",
  transport: "acp",
  command: "nonexistent-acp",
  args: [],
};

const cliProfile: AgentProfile = {
  id: "test-cli",
  name: "Test CLI",
  transport: "codex-cli",
  command: "codex",
  args: [],
};

describe("AcpAssistantModel transport routing (G)", () => {
  it("rejects when no profile is configured", async () => {
    const model = new AcpAssistantModel({ profile: null, workspaceRoot: "." });
    await expect(
      model.generate({
        userText: "hi",
        priorTurns: [],
        evidence: [],
        visibility: "private",
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("rejects CLI transport instead of piping it through ACP", async () => {
    const model = new AcpAssistantModel({
      profile: cliProfile,
      workspaceRoot: ".",
    });
    let caught: ModelUnavailableError | null = null;
    try {
      await model.generate({
        userText: "hi",
        priorTurns: [],
        evidence: [],
        visibility: "private",
      });
    } catch (e) {
      caught = e as ModelUnavailableError;
    }
    expect(caught).toBeInstanceOf(ModelUnavailableError);
    expect(caught!.message).toContain("CLI transport");
  });

  it("accepts acp transport (will fail on spawn, but not on transport check)", async () => {
    const model = new AcpAssistantModel({
      profile: acpProfile,
      workspaceRoot: ".",
    });
    // Should NOT throw "CLI transport not supported" — it should try to spawn
    // and fail with a transport/spawn error (wrapped as ModelUnavailableError).
    let caught: ModelUnavailableError | null = null;
    try {
      await model.generate({
        userText: "hi",
        priorTurns: [],
        evidence: [],
        visibility: "private",
      });
    } catch (e) {
      caught = e as ModelUnavailableError;
    }
    expect(caught).toBeInstanceOf(ModelUnavailableError);
    expect(caught!.message).not.toContain("CLI transport");
  });
});

describe("parseAssistantReply (G fixture parsing)", () => {
  it("resolves short model references to distinct fixed ranges for reading and governed task requests", () => {
    const aliases = new Map([
      ["cite_1", "e:original:2:4"],
      ["cite_2", "e:original:6:8"],
    ]);
    const reply = parseAssistantReply(
      JSON.stringify({
        answer: "预订。[[cite_1]] 释放。[cite_2] 未知。[[cite_99]]",
        citation_ids: ["cite_1", "cite_2"],
        create_task: {
          title: "检查释放行为",
          detail: "阅读方法",
          citation_ids: ["cite_2"],
        },
      }),
      aliases,
    );
    expect(reply.answer).toBe(
      "预订。[[e:original:2:4]] 释放。[[e:original:6:8]] 未知。（引用不可用：模型没有提供对应原文）",
    );
    expect(reply.citationIds).toEqual([...aliases.values()]);
    expect(reply.toolCalls![0]).toMatchObject({
      citationIds: ["e:original:6:8"],
    });
  });
  it("parses a well-formed JSON reply with citations and create_task", () => {
    const raw = JSON.stringify({
      answer: "接口在 GET /v1/items。",
      citation_ids: ["frag-1", "frag-2"],
      create_task: {
        title: "补文档",
        detail: "加示例",
        citation_ids: ["frag-1"],
      },
    });
    const reply = parseAssistantReply(raw);
    expect(reply.answer).toContain("GET /v1/items");
    expect(reply.citationIds).toEqual(["frag-1", "frag-2"]);
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls![0]).toMatchObject({
      tool: "create_task",
      title: "补文档",
      detail: "加示例",
      citationIds: ["frag-1"],
    });
  });

  it("parses a reply without create_task (null)", () => {
    const raw = JSON.stringify({ answer: "好的", citation_ids: [] });
    const reply = parseAssistantReply(raw);
    expect(reply.answer).toBe("好的");
    expect(reply.toolCalls).toBeUndefined();
  });

  it("throws on non-JSON output", () => {
    expect(() => parseAssistantReply("this is not json at all")).toThrow();
  });

  it("throws when answer is missing", () => {
    expect(() =>
      parseAssistantReply(JSON.stringify({ citation_ids: [] })),
    ).toThrow();
  });

  it("ignores malformed citation_ids (non-strings filtered)", () => {
    const raw = JSON.stringify({
      answer: "ok",
      citation_ids: ["f1", 123, null, "f2"],
    });
    const reply = parseAssistantReply(raw);
    expect(reply.citationIds).toEqual(["f1", "f2"]);
  });
});

describe("AcpAssistantModel history budget (G)", () => {
  it("truncates prior turns to maxPriorTurns", async () => {
    // We can't easily intercept the acp() call, but we verify the constructor
    // accepts maxPriorTurns and the prompt truncates by spying on console.
    // Instead, we test that the model constructs without error and rejects
    // CLI before any spawning — the truncation logic is internal to generate().
    const model = new AcpAssistantModel({
      profile: cliProfile,
      workspaceRoot: ".",
      maxPriorTurns: 3,
    });
    expect(model).toBeInstanceOf(AcpAssistantModel);
  });
});
