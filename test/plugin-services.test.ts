import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken, toolList } from "../src/agents/tools.ts";
import { describePlugin, getPlugin, loadPlugins, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { serviceStatus, stopPluginServices } from "../src/plugins/services.ts";
import { trustState } from "../src/plugins/trust.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/** A plugin in the data directory with code: a server.ts (tools, one held for approval) and an echo service with a stream. */
function probePlugin(home: string) {
  const dir = join(home, "plugins", "probe");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "plugin.yaml"),
    [
      "id: probe",
      "name: 探针",
      "agents: [bot]",
      "services:",
      "  - { name: echo, command: node, args: [echo.mjs], idleMinutes: 1 }",
      "streams:",
      "  - { name: echo, service: echo, path: /ws }",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "agents", "bot.md"), "---\ndescription: 测试\n---\n\n测试档案。\n");
  writeFileSync(
    join(dir, "server.ts"),
    `export default function register(api) {
  const z = api.z;
  api.tool({ name: "probe_ping", description: "ping the service", schema: z.object({}), handler: async () => {
    const s = await api.service("echo").ensure();
    const r = await fetch(s.url + "/ping", { headers: { authorization: "Bearer " + s.token } });
    return r.status + " " + (await r.text());
  } });
  api.tool({ name: "probe_click", description: "click somewhere", schema: z.object({ x: z.number() }), approval: true, handler: (_ctx, a) => "clicked " + a.x });
}
`,
  );
  writeFileSync(
    join(dir, "echo.mjs"),
    `const { serve } = await import(process.env.OMEM_SERVICE_SDK);
serve({
  http: (req, res) => res.end(req.url === "/ping" ? "pong" : "?"),
  socket: (ws) => ws.on("message", (data, binary) => ws.send(binary ? data : "echo:" + data)),
});
console.log("echo ready");
`,
  );
  return dir;
}

describe("plugins with code: trust, services, streams", () => {
  const apps: ReturnType<typeof testApp>[] = [];
  afterAll(() => stopPluginServices("probe"));

  it("runs a data-directory plugin's code only once trusted, and again only after a change is confirmed", async () => {
    const app = testApp();
    apps.push(app);
    const dir = probePlugin(app.home);
    await loadPlugins(app);
    const p = getPlugin("probe");
    expect(describePlugin(p)).toMatchObject({ source: "data", trust: "required", tools: [], services: [{ name: "echo", command: "node echo.mjs" }] });
    expect(toolList().some((t) => t.name === "probe_ping")).toBe(false);
    expect(findAgentSpec(app, "probe-bot")!.tools).not.toContain("probe_ping");
    // Untrusted: no services either.
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      expect((await server.inject({ method: "POST", url: "/api/plugins/probe/services/echo/start" })).statusCode).toBe(403);
      expect((await server.inject({ method: "POST", url: "/api/plugins/english/trust" })).statusCode).toBe(400);

      expect((await server.inject({ method: "POST", url: "/api/plugins/probe/trust" })).json()).toMatchObject({ trust: "trusted", tools: ["probe_ping", "probe_click"] });
      expect(findAgentSpec(app, "probe-bot")!.tools).toEqual(expect.arrayContaining(["probe_ping", "probe_click"]));

      // A tool marked for approval waits for the owner, whatever approvals.tools says.
      app.config.approvals.waitSeconds = 0;
      const agent = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", plugin: "probe" }))!;
      expect((await callTool(agent, "probe_click", { x: 3 })).text).toMatch(/需要本人批准/);

      // The tool reaches its service, which omem starts on first use.
      expect((await callTool(agent, "probe_ping", {})).text).toBe("200 pong");
      expect(serviceStatus("probe", p.manifest.services)[0]).toMatchObject({ running: true });

      // A change to the code needs confirming again.
      appendFileSync(join(dir, "server.ts"), "// changed\n");
      expect(trustState(app, "probe", dir)).toBe("changed");
      untrustPlugin(app, "probe");
      expect(toolList().some((t) => t.name === "probe_ping")).toBe(false);
      expect(serviceStatus("probe", p.manifest.services)[0]).toMatchObject({ running: false });
      expect(describePlugin(p).trust).toBe("required");
      await trustPlugin(app, "probe");
      expect(trustState(app, "probe", dir)).toBe("trusted");
    } finally {
      await server.close();
    }
  });

  it("a stream goes through to the service for the owner only, text and binary", async () => {
    const app = apps[0];
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const url = `${app.baseUrl.replace("http", "ws")}/api/plugins/probe/streams/echo`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      const got: (string | number[])[] = [];
      await new Promise<void>((ok, fail) => {
        ws.onerror = () => fail(new Error("stream failed"));
        ws.onopen = () => {
          ws.send("hi");
          ws.send(new Uint8Array([1, 2, 255]).buffer);
        };
        ws.onmessage = (e) => {
          got.push(typeof e.data === "string" ? e.data : [...new Uint8Array(e.data as ArrayBuffer)]);
          if (got.length === 2) ok();
        };
      });
      expect(got).toEqual(["echo:hi", [1, 2, 255]]);
      ws.close();

      // With a token configured, this machine is not trusted by itself any more.
      app.config.token = "secret-test-token";
      const refused = await new Promise<string>((ok) => {
        const w = new WebSocket(url);
        w.onopen = () => ok("open");
        w.onerror = () => ok("refused");
      });
      expect(refused).toBe("refused");
      const unknown = await new Promise<string>((ok) => {
        const w = new WebSocket(`${app.baseUrl.replace("http", "ws")}/api/plugins/probe/streams/nope`);
        w.onopen = () => ok("open");
        w.onerror = () => ok("refused");
      });
      expect(unknown).toBe("refused");
    } finally {
      app.config.token = undefined;
      await server.close();
    }
  });
});
