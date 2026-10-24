import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it("negotiates gzip for JSON and static assets and leaves SSE streaming", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const plain = await server.inject({ url: "/api/settings" });
    const compressed = await server.inject({ url: "/api/settings", headers: { "accept-encoding": "gzip" } });
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers.vary).toContain("accept-encoding");
    expect(gunzipSync(compressed.rawPayload).toString()).toBe(plain.body);
    expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    const refused = await server.inject({ url: "/api/settings", headers: { "accept-encoding": "gzip;q=0, identity" } });
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(refused.body).toBe(plain.body);
    const html = await server.inject({ url: "/" });
    const asset = html.body.match(/src="([^"]+\.js)"/)?.[1];
    // A clean source checkout may not have the optional web build yet.
    if (asset) {
      const js = await server.inject({ url: asset!, headers: { "accept-encoding": "gzip" } });
      expect(js.statusCode).toBe(200);
      expect(js.headers["content-encoding"]).toBe("gzip");
      expect(gunzipSync(js.rawPayload).length).toBeGreaterThan(js.rawPayload.length);
    }
    const controller = new AbortController();
    try {
      const events = await fetch(`${app.baseUrl}/api/events`, { headers: { "accept-encoding": "gzip" }, signal: controller.signal });
      expect(events.headers.get("content-encoding")).toBeNull();
      expect(events.headers.get("content-type")).toBe("text/event-stream");
      const chunk = await events.body!.getReader().read();
      expect(new TextDecoder().decode(chunk.value)).toContain(": connected");
    } finally { controller.abort(); }
  } finally { await server.close(); app.db.close(); }
});
