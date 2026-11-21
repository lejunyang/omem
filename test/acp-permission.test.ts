import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../src/server/http.ts";
import { agentToolEnv } from "../src/agents/tool-cli.ts";
import { commandGateDir } from "../src/agents/command-gate.ts";
import { openAcp } from "../src/agents/acp.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { agentProfileSchema, type OperationRule } from "../src/core/config.ts";
import { one } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function session(rules: OperationRule[], writable = true, executeAcme = false) {
  const app = testApp();
  app.config.security.operationRules = rules;
  const token = issueToolToken({ runId: null, userId: "member", spaceId: "sample", spaces: ["sample"], tools: new Set(), actor: "agent", agentProfile: "fake" });
  let env: Record<string, string> | undefined;
  if (executeAcme) {
    const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
    cleanup.push(() => server.close());
    const guarded = commandGateDir(app)!;
    env = agentToolEnv(app.home, app.baseUrl, token, guarded);
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH")!;
    const realDir = join(app.home, "real-bin");
    mkdirSync(realDir);
    env[pathKey] = [guarded, realDir, process.env[pathKey]].join(delimiter);
    if (process.platform === "win32") writeFileSync(join(realDir, "acme.cmd"), "@echo executed %1\r\n");
    else writeFileSync(join(realDir, "acme"), '#!/bin/sh\necho executed "$1"\n', { mode: 0o755 });
    env.FAKE_EXEC_ACME = "1";
  }
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "permission" } });
  const handle = await openAcp(profile, { app, allowWrites: writable, cwd: app.home,
    mcp: { token, env, url: "", baseUrl: "", stdio: { command: process.execPath, args: [] } } });
  cleanup.push(() => { handle.close(); revokeToolToken(token); app.db.close(); });
  const request = async (toolCall: RequestPermissionRequest["toolCall"]) => {
    const options = [{ kind: "allow_always", optionId: "allow_session", name: "session" },
      { kind: "allow_once", optionId: "yes", name: "yes" }, { kind: "reject_once", optionId: "no", name: "no" }];
    const result = await handle.prompt(JSON.stringify({ toolCall, options }), () => {});
    const outcome = JSON.parse(result.text);
    return outcome.output ?? outcome.optionId;
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

it.each(["waiting", "late"])("hands a %s one-shot command approval from ACP to the actual wrapper", async timing => {
  const { app, request } = await session([
    { ...rule("write", "approve", { kind: "command", executable: "acme" }), approval: { waitSeconds: 1 } },
  ], true, true);
  const call = { toolCallId: "cmd", kind: "execute" as const, rawInput: { command: ["acme", "write"] } };
  const first = request(call);
  if (timing === "late") expect(await first).toBe("no");
  await vi.waitFor(() => expect(listAsks(app, { status: "pending" })).toHaveLength(1));
  await answerAsk(app, listAsks(app)[0].id, { approved: true, by: "owner", choice: 0 });
  expect(await (timing === "late" ? request(call) : first)).toBe("executed write");
  expect(listAsks(app)).toHaveLength(1);
  expect(one(app.db, "select json_extract(context,'$.used') used from asks where id=?", listAsks(app)[0].id)).toEqual({ used: 1 });
  expect(await request(call)).toBe("no");
  expect(listAsks(app)).toHaveLength(2);
});

it("keeps the read-only write restriction and the omem MCP session option", async () => {
  const { request } = await session([rule("write", "allow", { kind: "file", operations: ["write"], pathRegex: "." })], false);
  expect(await request({ toolCallId: "edit", kind: "edit", rawInput: { path: "a" } })).toBe("no");
  expect(await request({ toolCallId: "mcp", title: "MCP tool call approval" })).toBe("allow_session");
});
