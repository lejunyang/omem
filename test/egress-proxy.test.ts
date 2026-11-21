import { afterEach, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { inspection } from "../src/agents/egress-ca.ts";
import { egressPolicy } from "../src/agents/egress-policy.ts";
import { privateAddress, startProxy } from "../src/agents/egress-proxy.ts";
import { testApp } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function socketPath() {
  return process.platform === "win32" ? "\\\\.\\pipe\\omem-" + randomUUID() : "/tmp/omem-" + randomUUID() + ".sock";
}
async function listen(server: http.Server | https.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => server.close());
  return (server.address() as { port: number }).port;
}
function request(socketPath: string, url: string, method = "GET") {
  return new Promise<{ code?: number; text: string }>((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method, agent: false }, res => {
      let text = ""; res.on("data", b => text += b); res.on("end", () => resolve({ code: res.statusCode, text }));
    });
    req.on("error", reject); req.end();
  });
}
function tunnel(socketPath: string, authority: string) {
  const req = http.request({ socketPath, path: authority, method: "CONNECT", agent: false });
  const done = once(req, "connect");
  req.end();
  return done as Promise<[http.IncomingMessage, import("node:net").Socket, Buffer]>;
}
function fixture() {
  const app = testApp();
  cleanup.push(() => app.db.close());
  const policy = egressPolicy({ app, runId: null, userId: "member", spaceId: "personal", spaces: [], actor: "agent", tools: null }, new Set(["model.example"]));
  return { app, policy };
}
it("按主机汇总转发、拒绝、只记录；运行结束后关闭入口", async () => {
  const { app, policy } = fixture();
  const port = await listen(http.createServer((_req, res) => res.end("ok")));
  const path = socketPath();
  const proxy = await startProxy(path, { ...policy, resolve: async () => "127.0.0.1" });
  cleanup.push(() => proxy.close());
  const url = "http://sample.example:" + port;
  expect((await request(path, url + "/")).code).toBe(403);
  app.config.security.operationRules = [{ id: "read", enabled: true, revision: 1, action: "allow", match: { kind: "http", host: "sample.example", pathRegex: "^/ok$" } }];
  expect(await request(path, url + "/ok")).toEqual({ code: 200, text: "ok" });
  expect([...proxy.usage.values()]).toMatchObject([{ host: "sample.example:" + port, count: 2, denied: 1, bytes: 2, backend: false }]);
  app.config.security.operationRules[0].action = "log";
  const d = { url: new URL(url + "/ok"), method: "GET", private: false, tunnel: false };
  expect(await policy.check(d)).toMatchObject({ allowed: true });
  app.config.security.egress.default = "deny";
  expect(await policy.check({ ...d, url: new URL("https://model.example/") })).toMatchObject({ allowed: true, backend: true });
  for (const ip of ["::1", "::ffff:127.0.0.1", "fe80::1", "100.64.0.1", "192.168.2.1"]) expect(privateAddress(ip)).toBe(true);
  proxy.close();
  await expect(request(path, url)).rejects.toThrow();
});
it.each([false, true])("使用后端的上游代理转发已批准的固定地址（Basic 认证 %s）", async authenticated => {
  const port = await listen(http.createServer((_req, res) => res.end("proxied")));
  const targets: string[] = [];
  const relay = http.createServer();
  const basic = "Basic " + Buffer.from("user@example:p%:@ss").toString("base64");
  relay.on("connect", (req, client) => {
    if (req.headers.authorization !== undefined || req.headers["proxy-authorization"] !== (authenticated ? basic : undefined)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    targets.push(req.url!);
    const peer = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      client.pipe(peer).pipe(client);
    });
    client.on("close", () => peer.destroy());
    peer.on("error", () => client.destroy());
  });
  const relayPort = await listen(relay);
  const userinfo = authenticated ? "user%40example:p%25%3A%40ss@" : "";
  const path = socketPath();
  const proxy = await startProxy(path, { check: async () => ({ allowed: true }), needsBody: () => false, resolve: async () => "127.0.0.1", upstreamProxy: () => new URL("http://" + userinfo + "127.0.0.1:" + relayPort) });
  cleanup.push(() => proxy.close());
  expect(await request(path, "http://unit.example:" + port + "/")).toEqual({ code: 200, text: "proxied" });
  expect(targets).toEqual(["127.0.0.1:" + port]);
});
it("同一主机并发审批共用一张卡，拒绝及超时都返回 403", async () => {
  const { app, policy } = fixture();
  const port = await listen(http.createServer((_req, res) => res.end("ok")));
  const path = socketPath();
  const proxy = await startProxy(path, policy);
  cleanup.push(() => proxy.close());
  app.config.security.egress.waitSeconds = 1;
  app.config.security.operationRules = [{ id: "ask", enabled: true, revision: 1, action: "approve", match: { kind: "http", host: "127.0.0.1" } }];
  const url = "http://127.0.0.1:" + port + "/";
  async function answer(approved: boolean) {
    await vi.waitFor(() => expect(listAsks(app, { status: "pending" })).toHaveLength(1));
    await answerAsk(app, listAsks(app, { status: "pending" })[0].id, { by: "owner", approved, choice: 0 });
  }
  const pair = Promise.all([request(path, url), request(path, url)]);
  await answer(true); expect((await pair).map(r => r.code)).toEqual([200, 200]);
  const denied = request(path, url); await answer(false);
  expect((await denied).code).toBe(403);
  expect(await request(path, url)).toMatchObject({ code: 403, text: expect.stringContaining("超时") });
});
it("隧道上看不见的条件按配置处理", async () => {
  const { app, policy } = fixture();
  app.config.security.operationRules = [{ id: "path", enabled: true, revision: 1, action: "deny", match: { kind: "http", host: "*.example", pathRegex: "^/money" } }];
  const d = { url: new URL("https://test.example/"), method: "CONNECT", private: false, tunnel: true };
  expect((await policy.check(d)).allowed).toBe(true);
  app.config.security.egress.tunnelWhenUnsure = "deny";
  expect((await policy.check(d)).allowed).toBe(false);
  app.config.security.egress.tunnelWhenUnsure = "approve";
  const decision = policy.check(d);
  await vi.waitFor(() => expect(listAsks(app, { status: "pending" })).toHaveLength(1));
  await answerAsk(app, listAsks(app, { status: "pending" })[0].id, { by: "owner", approved: true, choice: 0 });
  expect((await decision).allowed).toBe(true);
  const permanent = policy.check(d);
  await vi.waitFor(() => expect(listAsks(app, { status: "pending" })).toHaveLength(1));
  await answerAsk(app, listAsks(app, { status: "pending" })[0].id, { by: "owner", approved: true, choice: 2 });
  expect((await permanent).allowed).toBe(true);
  expect((await policy.check(d)).allowed).toBe(true);
  expect(app.config.security.operationRules[0].action).toBe("deny");
});
const ssl = spawnSync("openssl", ["version"], { windowsHide: true }).status === 0;
it.skipIf(!ssl)("解密名单内按路径审批并验证上游证书，名单外保留上游证书" + (ssl ? "" : "（缺少 openssl）"), async () => {
  const { app, policy } = fixture();
  const host = "inspect.example";
  const outside = "other.example";
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=upstream", "-addext", "subjectAltName=DNS:" + host + ",DNS:" + outside, "-days", "1", "-keyout", "key", "-out", "cert"], { cwd: app.home, stdio: "ignore" });
  const cert = readFileSync(join(app.home, "cert"));
  const port = await listen(https.createServer({ cert, key: readFileSync(join(app.home, "key")) }, (_req, res) => res.end("done")));
  const inspector = await inspection(app.home, app.home, [host]);
  app.config.security.operationRules = [
    { id: "ask", enabled: true, revision: 1, action: "approve", match: { kind: "http", host, pathRegex: "^/pay$" } },
    { id: "permit", enabled: true, revision: 1, action: "allow", match: { kind: "http", host: "*.example" } },
  ];
  async function open(trust: boolean, domain: string, route: string) {
    const path = socketPath();
    const proxy = await startProxy(path, { ...policy, ...inspector, ca: trust ? cert : undefined, resolve: async () => "127.0.0.1" });
    cleanup.push(() => proxy.close());
    const [res, socket] = await tunnel(path, domain + ":" + port);
    expect(res.statusCode).toBe(200);
    const client = tls.connect({ socket, servername: domain, ca: [cert, readFileSync(inspector.bundle)] });
    await once(client, "secureConnect");
    const subject = client.getPeerCertificate().subject.CN;
    client.write("GET " + route + " HTTP/1.1\r\nHost: " + domain + ":" + port + "\r\nConnection: close\r\n\r\n");
    let output = "";
    for await (const chunk of client) output += chunk;
    return { subject, output };
  }
  const waiting = open(true, host, "/pay");
  await vi.waitFor(() => expect(listAsks(app, { status: "pending" })).toHaveLength(1), { timeout: 5000 });
  await answerAsk(app, listAsks(app, { status: "pending" })[0].id, { by: "owner", approved: true, choice: 0 });
  expect(await waiting).toMatchObject({ subject: "omem inspected host", output: expect.stringContaining("done") });
  expect(await open(false, host, "/read")).toMatchObject({ output: expect.stringContaining("502") });
  expect(await open(true, outside, "/read")).toMatchObject({ subject: "upstream", output: expect.stringContaining("done") });
}, 20000);
