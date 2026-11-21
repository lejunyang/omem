import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clearBearerCache, registerAuthenticator } from "../src/auth/authenticators.ts";
import { saveRole } from "../src/auth/permissions.ts";
import { issueToolToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser, identitiesOf, setUserRole, updateUser } from "../src/core/users.ts";
import { boot } from "../src/main.ts";
import { clientHeaders, jwtExpiry, readClient, remoteToolBackend, resolveRemote, writeClient } from "../src/remote-client.ts";

/**
 * Using a remote omem from one's own computer (docs/v2/remote-clients.md): the tool routes take a
 * person's own credential, `omem login` gets one in the browser, an authenticator plugin recognizes
 * an organization's credential, and accounts made ahead of time are claimed by email.
 */
describe("remote clients", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-remote-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ webUrl: "http://omem.test", auth: { enabled: true } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const base = app.baseUrl!;
  createSpace(app, { id: "proj-a", name: "项目 A" });
  createSpace(app, { id: "proj-b", name: "项目 B" });
  createUser(app, { id: "wang", name: "小王" });
  addMember(app, "proj-a", "wang", "contributor");
  createUser(app, { id: "li", name: "小李" });
  setUserRole(app, "li", "viewer");
  addMember(app, "proj-a", "li", "reader");

  // From another machine (through a proxy): never trusted as this machine.
  const remote = (path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      redirect: "manual",
      headers: { "x-forwarded-for": "203.0.113.9", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const tools = async (token: string, headers: Record<string, string> = {}) => {
    const r = await remote("/api/tools", { token, headers });
    return { status: r.status, body: await r.json() };
  };
  const call = async (token: string, name: string, args: unknown = {}, headers: Record<string, string> = {}) => {
    const r = await remote(`/api/tools/${name}`, { token, body: args, headers });
    return { status: r.status, body: await r.json() };
  };

  it("lets a member use the tools with their own API token: their spaces, nothing outward, one run per session", async () => {
    const token = createApiToken(app, "wang", "test");
    const listed = await tools(token);
    expect(listed.status).toBe(200);
    const names = listed.body.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search", "read_source", "remember", "omem_help"]));
    for (const n of ["lark_send", "notify", "delegate_code", "code_workspace", "save_rule", "save_agent"]) expect(names).not.toContain(n);

    const headers = clientHeaders({ session: "整理 项目 A", client: "laptop-wang", agent: "claude-code", model: "m-1" });
    const spaces = await call(token, "list_spaces", {}, headers);
    expect(spaces.body.isError).toBe(false);
    expect(spaces.body.text).toContain("proj-a");
    expect(spaces.body.text).not.toContain("proj-b");
    await call(token, "search", { query: "退款" }, headers);
    const runs = all<{ id: string; user_id: string; title: string; input: string }>(app.db, "select id, user_id, title, input from runs where kind = 'peer-agent'");
    expect(runs).toHaveLength(1);
    expect(runs[0].user_id).toBe("wang");
    expect(runs[0].title).toContain("小王");
    expect(JSON.parse(runs[0].input)).toMatchObject({ caller: "laptop-wang", session: "整理 项目 A", via: "token" });

    // Narrowing to a space they cannot read is refused, not widened.
    expect((await tools(token, clientHeaders({ session: "x", spaces: "proj-b" }))).status).toBe(403);
    // A tool outside the set is refused through omem_call too.
    const outward = await call(token, "omem_call", { tool: "lark_send", args: {} }, headers);
    expect(outward.body.isError).toBe(true);
    // Read-only: no writing tools.
    const ro = await tools(token, clientHeaders({ session: "ro", readOnly: true }));
    expect(ro.body.tools.map((t: { name: string }) => t.name)).not.toContain("remember");
  });

  it("applies scoped grants and revocations to both directories, direct calls and omem_call", async () => {
    const user = createUser(app, { id: "tool-reader", name: "项目读者" });
    addMember(app, "proj-a", user.id, "reader");
    addMember(app, "proj-b", user.id, "contributor");
    const api = createApiToken(app, user.id);
    const runToken = issueToolToken({ runId: null, userId: user.id, actor: "agent", spaceId: "proj-a",
      spaces: ["proj-a", "proj-b"], writable: ["proj-a"], tools: new Set(["list_sources", "save_note"]) });
    const scoped = clientHeaders({ session: "目录检查", spaces: "proj-a", space: "proj-a" });
    const clients = [{ token: api, headers: scoped }, { token: runToken, headers: {} }];
    const override = (cap: string, effect: string) => run(app.db,
      "insert or replace into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,?,'space','proj-a',?,current_timestamp,'owner')", user.id, cap, effect);

    for (const effect of ["allow", "deny"]) {
      override("sources.edit", effect);
      override("sources.view", effect);
      for (const { token, headers } of clients) {
        const directory = (await tools(token, headers)).body.tools as { name: string; description: string }[];
        const mcp = await remote("/mcp", { token, headers: { ...headers, accept: "application/json, text/event-stream" },
          body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
        expect((await mcp.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(directory.map(t => t.name));
        const help = (await call(token, "omem_help", {}, headers)).body.text;
        for (const name of ["save_note", "list_sources"]) {
          // The run can still list sources in its read-only second space.
          const listed = effect === "allow" || (token === runToken && name === "list_sources");
          expect(directory.some(t => t.name === name || t.name === "omem_call" && t.description.includes("- " + name + "："))).toBe(listed);
          expect(help.includes("- " + name + "：")).toBe(listed);
        }
        expect((await call(token, "list_sources", { space: "proj-a" }, headers)).body.isError).toBe(effect === "deny");
        const args = { space: "proj-a", text: "项目笔记" };
        expect((await call(token, "save_note", args, headers)).body.isError).toBe(effect === "deny");
        expect((await call(token, "omem_call", { tool: "save_note", args }, headers)).body.isError).toBe(effect === "deny");
        expect((await call(token, "save_note", { ...args, space: "proj-b" }, headers)).body.isError).toBe(true);
      }
    }
  });

  it("gives visitors the tools too, and refuses a role without tools.external", async () => {
    expect((await tools(createApiToken(app, "li"))).status).toBe(200);
    saveRole(app, { id: "no-cli", name: "不用命令行", scope: "global", permissions: [] });
    createUser(app, { id: "zhang", name: "小张" });
    setUserRole(app, "zhang", "no-cli");
    const r = await tools(createApiToken(app, "zhang"));
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("tools.external");
    // Garbage is a plain 401 with a reason, not the run-token message.
    const bad = await tools("om_nope");
    expect(bad.status).toBe(401);
    expect(bad.body.error).toContain("凭据无效");
  });

  it("omem login: the browser allows a code, the command line gets a token once", async () => {
    const start = await (await remote("/api/auth/cli/start", { body: { client: "laptop-wang" } })).json();
    expect(start.url).toBe(`http://omem.test/#/cli-login?code=${encodeURIComponent(start.code)}`);
    expect(start.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const poll = () => remote("/api/auth/cli/poll", { body: { code: start.code, secret: start.secret } });
    expect(await (await poll()).json()).toEqual({ status: "waiting" });
    // A wrong secret learns nothing.
    expect((await remote("/api/auth/cli/poll", { body: { code: start.code, secret: "guess" } })).status).toBe(404);

    // The person, signed in (here with a token), sees the code and allows it.
    const wang = createApiToken(app, "wang", "web");
    const info = await (await remote(`/api/auth/cli/info?code=${start.code.toLowerCase().replace("-", "")}`, { token: wang })).json();
    expect(info).toMatchObject({ client: "laptop-wang", code: start.code, user: { id: "wang" }, may: true });
    expect((await remote("/api/auth/cli/approve", { token: wang, body: { code: start.code } })).status).toBe(200);
    const done = await (await poll()).json();
    expect(done.status).toBe("done");
    expect(done.user).toEqual({ id: "wang", name: "小王" });
    expect((await poll()).status).toBe(410);
    expect((await tools(done.token)).status).toBe(200);

    // It is on the account page, and can be revoked there.
    const mine = (await (await remote("/api/auth/tokens", { token: wang })).json()).tokens;
    const cli = mine.find((t: { client: string }) => t.client === "laptop-wang");
    expect(cli.label).toBe("cli:laptop-wang");
    await remote(`/api/auth/tokens/${cli.id}`, { method: "DELETE", token: wang });
    expect((await tools(done.token)).status).toBe(401);

    // Refused: the command line hears it is gone.
    const other = await (await remote("/api/auth/cli/start", { body: { client: "x" } })).json();
    await remote("/api/auth/cli/deny", { token: wang, body: { code: other.code } });
    expect((await remote("/api/auth/cli/poll", { body: { code: other.code, secret: other.secret } })).status).toBe(404);
  });

  it("omem open: a one-time link that signs the browser in as the command line, back to the page asked for", async () => {
    const token = createApiToken(app, "wang");
    const r = await (await remote("/api/auth/open", { token, body: { path: "/wiki" } })).json();
    expect(r.url).toMatch(/^http:\/\/omem\.test\/api\/auth\/link\/[\w-]+\?return=%2Fwiki$/);
    const link = new URL(r.url);
    const signed = await remote(link.pathname + link.search, { method: "POST" });
    expect(signed.status).toBe(303);
    expect(signed.headers.get("location")).toBe("http://omem.test/#/wiki");
    expect(signed.headers.get("set-cookie")).toContain("omem_sid=");
    // Only for the command line: a browser session cannot mint more links.
    expect((await remote("/api/auth/open", { body: {} })).status).toBe(401);
  });

  describe("an authenticator plugin and accounts made ahead of time", () => {
    // jwt.<sub>.<email>: a stand-in for an organization's signed credential; "jwt.bad" fails the check.
    const undo = registerAuthenticator({
      id: "acme-sso",
      label: "公司统一登录",
      claims: (t) => t.startsWith("jwt."),
      verify: async (t) => {
        const [, sub, email] = t.split(".");
        if (sub === "bad") return null;
        return { externalId: sub, name: `用户 ${sub}`, email: email?.replace("_", "."), emailVerified: true, expiresAt: Date.now() + 3600_000 };
      },
    });
    afterAll(undo);
    afterEach(clearBearerCache);

    it("claims the account made ahead of time by email, with its spaces", async () => {
      const made = await fetch(`${base}/api/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "小周", email: "Zhou@Example.com", spaces: [{ space: "proj-a", role: "reader" }] }) });
      expect(made.status).toBe(200);
      const zhou = (await made.json()).id;
      // The same email twice is refused, naming the account.
      const again = await fetch(`${base}/api/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "周二", email: "zhou@example.com" }) });
      expect(again.status).toBe(409);
      expect((await again.json()).error).toContain(zhou);

      const jwt = "jwt.u100.zhou@example_com";
      const me = await (await remote("/api/me", { token: jwt })).json();
      expect(me.id).toBe(zhou);
      expect(identitiesOf(app, zhou).map((i) => [i.channel, i.external_id])).toContainEqual(["acme-sso", "u100"]);
      const spaces = await call(jwt, "list_spaces", {}, clientHeaders({ session: "s" }));
      expect(spaces.body.text).toContain("proj-a");
      const run = one<{ input: string }>(app.db, "select input from runs where kind = 'peer-agent' and user_id = ?", zhou)!;
      expect(JSON.parse(run.input).via).toBe("acme-sso");

      // Disabled: no longer let in, even with the result remembered.
      updateUser(app, zhou, { disabled: true });
      expect((await tools(jwt)).status).toBe(401);
      updateUser(app, zhou, { disabled: false });
    });

    it("someone new waits for approval and is told so; the owner hears once", async () => {
      const before = all(app.db, "select 1 from notifications").length;
      const first = await tools("jwt.u200.new@example_com");
      expect(first.status).toBe(403);
      expect(first.body.error).toMatch(/等 omem 的主人批准/);
      clearBearerCache();
      expect((await tools("jwt.u200.new@example_com")).status).toBe(403);
      const users = all<{ id: string; status: string }>(app.db, "select u.id, u.status from users u join identities i on i.user_id = u.id where i.channel = 'acme-sso' and i.external_id = 'u200'");
      expect(users).toEqual([{ id: expect.any(String), status: "pending" }]);
      expect(all(app.db, "select 1 from notifications").length).toBe(before + 1);
      // Not a valid credential at all.
      expect((await tools("jwt.bad.x")).status).toBe(401);
    });
  });
});

describe("the command line's remote settings", () => {
  const prev = { home: process.env.OMEM_HOME, url: process.env.OMEM_URL, token: process.env.OMEM_TOKEN, cmd: process.env.OMEM_AUTH_CMD };
  afterAll(() => {
    for (const [k, v] of [["OMEM_HOME", prev.home], ["OMEM_URL", prev.url], ["OMEM_TOKEN", prev.token], ["OMEM_AUTH_CMD", prev.cmd]] as const) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it("picks the address and credential in the documented order", () => {
    process.env.OMEM_HOME = mkdtempSync(join(tmpdir(), "omem-client-"));
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveRemote({}, env)).toBeNull();
    writeClient({ default: "work", remotes: { work: { url: "https://omem.example.com/", authCmd: "print-jwt" }, home: { url: "http://10.0.0.2:4317", token: "om_home" } } });
    expect(readClient().remotes.work.url).toBe("https://omem.example.com/");
    expect(resolveRemote({}, env)).toEqual({ name: "work", url: "https://omem.example.com", credential: { kind: "cmd", command: "print-jwt" } });
    expect(resolveRemote({ remote: "home" }, { OMEM_TOKEN: "ot_run" })).toEqual({ name: "home", url: "http://10.0.0.2:4317", credential: { kind: "token", value: "om_home" } });
    // An address given directly: the environment's credential first, else the saved one for that address.
    expect(resolveRemote({ url: "http://10.0.0.2:4317" }, env)?.credential).toEqual({ kind: "token", value: "om_home" });
    expect(resolveRemote({}, { OMEM_URL: "http://10.0.0.2:4317", OMEM_AUTH_CMD: "x" })?.credential).toEqual({ kind: "cmd", command: "x" });
    // A run's token alone is for the omem on this machine, as before.
    expect(resolveRemote({}, { OMEM_TOKEN: "ot_run" })).toMatchObject({ url: "http://127.0.0.1:4317", credential: { kind: "token", value: "ot_run" } });
    expect(() => resolveRemote({ remote: "nope" }, env)).toThrow(/没有名为 nope/);
    expect(() => resolveRemote({ url: "omem.example.com" }, env)).toThrow(/http/);
  });

  it("reads a JWT's expiry without checking it", () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(jwtExpiry(`${part({ alg: "none" })}.${part({ exp: 2000000000 })}.sig`)).toBe(2000000000_000);
    expect(jwtExpiry("om_abc")).toBeNull();
  });

  it("calls a remote server's tools with the credential a command prints", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-remote-cmd-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ auth: { enabled: true } }));
    const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
    try {
      createUser(app, { id: "wu", name: "小吴" });
      const token = createApiToken(app, "wu");
      const backend = remoteToolBackend({ url: app.baseUrl!, credential: { kind: "cmd", command: `node -e "console.log('${token}')"` } }, { session: "测试", client: "box" });
      expect((await backend.list()).map((t) => t.name)).toContain("search");
      const r = await backend.call("list_spaces", {});
      expect(r.isError).toBe(false);
      expect(r.text).toContain("personal-wu");
      const refused = remoteToolBackend({ url: app.baseUrl!, credential: { kind: "token", value: "om_wrong" } }, { session: "x" });
      await expect(refused.list()).rejects.toThrow(/401/);
    } finally {
      await server.close();
    }
  });
});
