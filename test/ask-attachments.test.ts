import { expect, it } from "vitest";
import { renderMessages } from "../src/agents/sessions.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a9f80000000049454e44ae426082", "hex");

function multipart(files: { name: string; type: string; body: Buffer }[]) {
  const boundary = "----omemtest";
  const parts = files.map((f) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.body, Buffer.from("\r\n")]));
  return { payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

it("keeps files pasted into the chat and gives the agent their paths under the labels the text uses", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const up = await server.inject({ method: "POST", url: "/api/ask/attachments", ...multipart([{ name: "image.png", type: "image/png", body: PNG }, { name: "notes", type: "application/octet-stream", body: Buffer.from("退款对账的口径") }]) });
    expect(up.statusCode).toBe(200);
    const files = up.json().files as { name: string; filename: string; kind: string; size: number }[];
    expect(files.map((f) => f.kind)).toEqual(["image", "file"]);
    expect(files[0].name).toMatch(/^[a-f0-9]{16}\.png$/);
    expect(files[1].name).toMatch(/^[a-f0-9]{16}\.bin$/);
    // The stored file opens like any other original.
    expect((await server.inject({ url: `/api/files/${files[0].name}` })).statusCode).toBe(200);

    const attachments = [{ ...files[0], label: "图片1" }, { ...files[1], label: "文件1" }];
    // Only attachments: the labels stand in for the text. (No agent is configured, so the turn itself does not matter here.)
    const sent = await server.inject({ method: "POST", url: "/api/ask", payload: { text: "", attachments } });
    expect(sent.statusCode).toBe(200);
    const msg = threadMessages(app, sent.json().conversationId, { limit: 5 }).find((m) => m.role === "user")!;
    expect(msg.text).toBe("[图片1] [文件1]");
    const prompt = renderMessages([msg], app);
    expect(prompt).toContain(`[图片1] image.png：${app.filesDir}`);
    expect(prompt).toContain("（图片，用你的文件或图片工具打开看）");
    expect(prompt).toContain("[文件1] notes：");

    // A name that is not a stored file is refused.
    const bad = await server.inject({ method: "POST", url: "/api/ask", payload: { text: "看看", attachments: [{ ...attachments[0], name: "0000000000000000.png" }] } });
    expect(bad.statusCode).toBe(400);
  } finally {
    await server.close();
  }
});
