import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { chunkMessage, plainCitations } from "../src/channels/common.ts";
import { boot } from "../src/main.ts";
import { listSources } from "../src/sources/store.ts";

describe("channel helpers", () => {
  it("reduces internal links to labels", () => {
    expect(plainCitations("见 [a.ts:1](src:s1#L1-L2) 和 [记忆](mem:m1)，参考 [[flows/x|流程]] 与 [[y]]")).toBe("见 a.ts:1 和 记忆，参考 流程 与 y");
  });
  it("splits long messages at line breaks", () => {
    const parts = chunkMessage("a".repeat(30) + "\n" + "b".repeat(30), 40);
    expect(parts).toEqual(["a".repeat(30), "b".repeat(30)]);
  });
});

describe("OneBot channel", async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), "omem-ob-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")] }] },
      onebot: { enabled: true, url: `ws://127.0.0.1:${port}`, ownerUserId: "42" },
    }),
  );
  const sent: { action: string; params: { message: string; user_id?: number } }[] = [];
  const connected = new Promise<import("ws").WebSocket>((r) => wss.on("connection", (s) => (s.on("message", (d) => sent.push(JSON.parse(String(d)))), r(s))));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: true });
  afterAll(() => {
    server.close();
    wss.close();
  });

  it("captures group chat and answers the owner privately", async () => {
    const sock = await connected;
    sock.send(JSON.stringify({ post_type: "message", message_type: "group", group_id: 7, user_id: 99, self_id: 1, time: 1760000000, sender: { nickname: "小王" }, message: [{ type: "text", data: { text: "接口文档周三给你" } }] }));
    sock.send(JSON.stringify({ post_type: "message", message_type: "private", user_id: 13, self_id: 1, message: "你好" }));
    sock.send(JSON.stringify({ post_type: "message", message_type: "private", user_id: 42, self_id: 1, message: "小王说文档什么时候给" }));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !sent.some((s) => s.params.user_id === 42)) await new Promise((r) => setTimeout(r, 200));
    const reply = sent.find((s) => s.params.user_id === 42)!;
    expect(reply.action).toBe("send_private_msg");
    expect(reply.params.message).toMatch(/^tools=\d+; search=1\. 原件/);
    expect(sent.some((s) => s.params.user_id === 13)).toBe(false);
    const chats = listSources(app, { spaceId: "personal", kind: "chat" }).sources;
    expect(chats.map((s) => s.uri)).toContain("onebot:group:7");
  }, 40000);
});
