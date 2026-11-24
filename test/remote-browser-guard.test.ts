import { request, createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveRole } from "../src/auth/permissions.ts";
import { createSession } from "../src/auth/sessions.ts";
import { capabilityAccess } from "../src/auth/capabilities.ts";
import { run } from "../src/core/db.ts";
import { setToolResolverForTests } from "../src/core/tools.ts";
import { createApiToken, createUser, setUserRole } from "../src/core/users.ts";
import { guardedBrowserEnv, refusedAddress, stopBrowserGuard } from "../src/remote/browser-guard.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const linux = process.platform === "linux";

describe.skipIf(!linux)("给成员用的浏览器访问不了本机", () => {
  afterAll(() => stopBrowserGuard());

  it("环境：去掉桌面的代理来源，所有请求（含回环）走守卫代理", async () => {
    const env = await guardedBrowserEnv({ PATH: "/usr/bin", HOME: "/home/x", XDG_CURRENT_DESKTOP: "KDE", DESKTOP_SESSION: "plasma", https_proxy: "http://corp:3128", DISPLAY: ":0" });
    expect(env.XDG_CURRENT_DESKTOP).toBeUndefined();
    expect(env.DESKTOP_SESSION).toBeUndefined();
    expect(env.DISPLAY).toBe(":0");
    expect(env.no_proxy).toBe("<-loopback>");
    expect(env.https_proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.all_proxy).toBe(env.https_proxy);
  });

  it("代理拒绝本机和链路本地地址，连名字解析到 127.0.0.1 的也拒", async () => {
    const hits: string[] = [];
    const target = createServer((q, s) => { hits.push(q.url!); s.end("secret"); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as { port: number }).port;
    const proxy = new URL((await guardedBrowserEnv({})).http_proxy!);
    const viaHttp = (url: string) => new Promise<number>((resolve) => {
      request({ host: proxy.hostname, port: proxy.port, path: url, headers: { host: new URL(url).host } }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", () => resolve(0)).end();
    });
    const viaConnect = (hostPort: string) => new Promise<string>((resolve) => {
      const s = connect(Number(proxy.port), proxy.hostname, () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
      s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]); s.destroy(); }).on("error", () => resolve("error"));
    });
    expect(await viaHttp(`http://127.0.0.1:${port}/a`)).toBe(403);
    expect(await viaHttp(`http://localhost:${port}/b`)).toBe(403);
    expect(await viaConnect(`127.0.0.1:${port}`)).toMatch(/403/);
    expect(await viaConnect(`[::1]:${port}`)).toMatch(/403/);
    expect(hits).toEqual([]);
    expect(refusedAddress({ ip: "169.254.169.254" })).toBe(true);
    expect(refusedAddress({ ip: "fe80::1" })).toBe(true);
    // A company's own network stays reachable (its sites and sign-on usually live there).
    expect(refusedAddress({ ip: "10.1.2.3" })).toBe(false);
    expect(refusedAddress({ ip: "93.184.216.34" })).toBe(false);
    target.close();
  });
});

describe("用自己的远程浏览器：默认关，只开浏览器，不能连桌面", () => {
  const app = testApp();
  app.config.token = "test-owner";
  let server: Awaited<ReturnType<typeof startServer>>;
  let token: string;
  beforeAll(async () => {
    process.env.FAKE_AAD_TARGET_DIR = app.home;
    createUser(app, { id: "ann", name: "小安" });
    createSession(app, "ann", { via: "link" });
    token = createApiToken(app, "ann");
    setToolResolverForTests((name) => (name === "aad" ? [process.execPath, join(import.meta.dirname, "fake-aad.ts")] : null));
    server = await startServer(app, { port: 0, quiet: true });
  });
  afterAll(async () => { await server.close(); delete process.env.FAKE_AAD_TARGET_DIR; setToolResolverForTests(null); await stopBrowserGuard(); app.db.close(); });
  const api = (path: string, method = "GET", body?: object, as = token) =>
    fetch(app.baseUrl + "/api/remote" + path, { method, headers: { authorization: "Bearer " + as, ...(body && { "content-type": "application/json" }) }, body: body && JSON.stringify(body) });

  it("没有权限时开不了；有了只开得了浏览器，桌面、本机浏览器登录和桌面窗口都不行，打不开本机地址", async () => {
    expect((await api("/sessions", "POST", { kind: "browser" })).status).toBe(403);
    run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('ann','remote.browser','global','','allow','','owner')");
    expect((await api("/sessions", "POST", { kind: "desktop" })).status).toBe(403);
    expect((await api("/screens")).status).toBe(403);
    expect((await api("/sessions", "POST", { kind: "browser", copyFrom: { browser: "chrome", id: "Default" } })).status).toBe(403);
    expect((await api("/sessions", "POST", { kind: "browser", url: "http://127.0.0.1:9/" })).status).toBe(403);
    expect((await api("/sessions", "POST", { kind: "browser", url: "http://localhost:9/" })).status).toBe(403);
    if (!linux) return;
    const opened = await api("/sessions", "POST", { kind: "browser", profile: "后台" });
    expect(opened.status).toBe(200);
    const s = await opened.json();
    expect(s).toMatchObject({ kind: "browser", guarded: true });
    expect((await api(`/sessions/${s.id}/navigate`, "POST", { url: "http://127.0.0.1:4317/api/me" })).status).toBe(403);
    expect((await (await api("")).json()).profiles).toEqual(["后台"]);
    expect((await api(`/sessions/${s.id}`, "DELETE")).status).toBe(200);
  });

  it("自定义角色可以直接带细分能力，和成员“能做什么”里的一样生效", () => {
    createUser(app, { id: "bo", name: "小波" });
    saveRole(app, { id: "remote-user", name: "远程使用者", scope: "global", permissions: ["remote.browser", "items.edit", "spaces.create"] });
    setUserRole(app, "bo", "remote-user");
    const access = capabilityAccess(app, "bo", null);
    expect(access.source("remote.browser")).toBe("preset");
    expect(access.source("remote.operate")).toBeNull();
    expect(() => saveRole(app, { id: "bad", name: "坏的", scope: "space", permissions: ["remote.browser"] })).toThrow(/不认识/);
    expect(saveRole(app, { id: "space-editor", name: "空间里改事项", scope: "space", permissions: ["space.read", "items.edit"] }).permissions).toContain("items.edit");
  });
});
