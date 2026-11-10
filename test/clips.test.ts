import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { boot } from "../src/main.ts";
import { imageExt } from "../src/sources/clips.ts";

/**
 * Clips from the browser extension (chrome/, 拾取篮 → omem): screenshots become image originals the
 * agent can open, the text embeds and names them, and the clip is either asked or kept as a note.
 */
describe("clips", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-clips-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ auth: { enabled: true } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const base = app.baseUrl!;
  createSpace(app, { id: "proj-a", name: "项目 A" });
  createSpace(app, { id: "proj-b", name: "项目 B" });
  createUser(app, { id: "wang", name: "小王" });
  addMember(app, "proj-a", "wang", "contributor");
  const token = createApiToken(app, "wang", "chrome");

  // A 1×1 PNG.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const post = (body: unknown, auth = token) =>
    fetch(`${base}/api/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    });

  it("keeps a clip as a note with its screenshot as an image original", async () => {
    const r = await post({
      mode: "source",
      space: "proj-a",
      title: "退款页按钮间距",
      text: "提交和取消离得太近\n\n{{image:r1}}\n\n页面：https://shop.example.com/refund",
      pageUrl: "https://shop.example.com/refund",
      images: [{ key: "r1", title: "#3 按钮 button.submit", data: `data:image/png;base64,${png}` }],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { mode: string; sourceId: string; imageSources: { key: string; sourceId: string }[] };
    expect(body.mode).toBe("source");
    const note = one<{ title: string; kind: string; space_id: string }>(app.db, "select title, kind, space_id from sources where id = ?", body.sourceId)!;
    expect(note).toMatchObject({ title: "退款页按钮间距", kind: "note", space_id: "proj-a" });
    const image = one<{ kind: string; meta: string }>(app.db, "select kind, meta from sources where id = ?", body.imageSources[0].sourceId)!;
    expect(image.kind).toBe("image");
    const meta = JSON.parse(image.meta) as { original: string; pageUrl: string };
    expect(meta.original).toMatch(/^[a-f0-9]{16}\.png$/);
    expect(meta.pageUrl).toBe("https://shop.example.com/refund");
    const text = one<{ text: string }>(app.db, "select text from sources where id = ?", body.sourceId)?.text ?? "";
    expect(text).toContain(`omem-file:${meta.original}`);
    expect(text).toContain(`src:${body.imageSources[0].sourceId}`);
    expect(text).not.toContain("{{image:");
  });

  it("asks with the clip as the message", async () => {
    const r = await post({ mode: "ask", space: "proj-a", text: "这个按钮的颜色和设计稿不一致吗？\n\n{{image:a}}", images: [{ key: "a", data: png }] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { mode: string; conversationId: string };
    expect(body.mode).toBe("ask");
    const message = one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'user'", body.conversationId);
    expect(message?.text).toContain("这个按钮的颜色和设计稿不一致吗？");
    expect(message?.text).toContain("omem-file:");
  });

  it("refuses a space the person cannot write and data that is not an image", async () => {
    expect((await post({ mode: "source", space: "proj-b", text: "x" })).status).toBe(403);
    const bad = await post({ mode: "source", space: "proj-a", text: "x", images: [{ key: "x", data: Buffer.from("<svg/>").toString("base64") }] });
    expect(bad.status).toBe(400);
    expect(imageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(".jpg");
  });
});
