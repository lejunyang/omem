import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openAcp } from "../src/agents/acp.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { agentProfileSchema, type OperationRule } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function session(rules: OperationRule[], writable = true) {
  const app = testApp();
  app.config.security.operationRules = rules;
  const token = issueToolToken({ runId: null, userId: "member", spaceId: "sample", spaces: ["sample"], tools: new Set(), actor: "agent", agentProfile: "fake" });
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "permission" } });
  const handle = await openAcp(profile, { app, allowWrites: writable, cwd: app.home,
    mcp: { token, url: "", baseUrl: "", stdio: { command: process.execPath, args: [] } } });
  cleanup.push(() => { handle.close(); revokeToolToken(token); app.db.close(); });
  const request = async (toolCall: RequestPermissionRequest["toolCall"]) => {
    const options = [{ kind: "allow_always", optionId: "allow_session", name: "session" },
      { kind: "allow_once", optionId: "yes", name: "yes" }, { kind: "reject_once", optionId: "no", name: "no" }];
    const result = await handle.prompt(JSON.stringify({ toolCall, options }), () => {});
    return JSON.parse(result.text).optionId;
  };
  return { app, request };
}

const rule = (id: string, action: OperationRule["action"], match: OperationRule["match"]): OperationRule =>
  ({ id, revision: 1, enabled: true, action, match, scope: { members: ["member"], backends: ["fake"], spaces: ["sample"] } });

it("checks command arguments and every file location, keeping opaque requests on the ACP baseline", async () => {
  const { request } = await session([
    rule("command", "deny", { kind: "command", executable: "sample", argv: [{ index: 0, regex: "^publish$" }] }),
    rule("file", "deny", { kind: "file", operations: ["write", "rename"], pathRegex: "private.txt$" }),
  ]);
  const execute = { toolCallId: "cmd", kind: "execute" as const, title: "sample publish" };
  expect(await request({ ...execute, rawInput: { command: ["sample", "publish"] } })).toBe("no");
  expect(await request({ ...execute, rawInput: { executable: "sample", argv: ["status"] } })).toBe("yes");
  expect(await request({ ...execute, rawInput: { executable: "sample" } })).toBe("yes");
  expect(await request({ ...execute, rawInput: { argv: ["sample", "publish"] } })).toBe("no");
  expect(await request(execute)).toBe("yes");
  expect(await request({ toolCallId: "edit", kind: "edit", locations: [{ path: "/example/a" }, { path: "/example/private.txt" }] })).toBe("no");
  expect(await request({ toolCallId: "diff", kind: "edit", content: [{ type: "diff", path: "/example/private.txt", newText: "sample" }] })).toBe("no");
  expect(await request({ toolCallId: "move", kind: "move", rawInput: { source: "a", destination: "private.txt" } })).toBe("no");
});

it("returns the one-shot option only after approval and rejects a timed-out request", async () => {
  const { app, request } = await session([
    { ...rule("read", "approve", { kind: "file", operations: ["read"], pathRegex: "private.txt$" }), approval: { waitSeconds: 1 } },
  ]);
  const read = { toolCallId: "read", kind: "read" as const, rawInput: { file_path: "private.txt" } };
  const decision = request(read);
  const pending = () => listAsks(app, { status: "pending" }).find(ask => ask.handler === "command-gate");
  await vi.waitFor(() => expect(pending()).toBeDefined());
  await answerAsk(app, pending()!.id, { by: "owner", approved: true, choice: 0 });
  expect(await decision).toBe("yes");
  expect(await request(read)).toBe("no");
});

it("keeps the read-only write restriction and the omem MCP session option", async () => {
  const { request } = await session([rule("write", "allow", { kind: "file", operations: ["write"], pathRegex: "." })], false);
  expect(await request({ toolCallId: "edit", kind: "edit", rawInput: { path: "a" } })).toBe("no");
  expect(await request({ toolCallId: "mcp", title: "MCP tool call approval" })).toBe("allow_session");
});
