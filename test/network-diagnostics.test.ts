import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureSelfSigned } from "../src/server/secure.ts";
import { networkRequest } from "../src/agents/network-request.ts";

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const hasOpenssl = !spawnSync("openssl", ["version"], { encoding: "utf8" }).error;
const hasIpv6 = Object.values(networkInterfaces()).some((a) => a?.some((v) => v.address === "::1"));
async function listen(server: ReturnType<typeof createHttpServer>, host = "127.0.0.1") {
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, host, () => { server.off("error", fail); ok(); }); });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  return (server.address() as { port: number }).port;
}

it.skipIf(!hasIpv6)("connects to an explicit IPv6 address without losing the target Host header", async () => {
  let host = "", remote = "";
  const port = await listen(createHttpServer((req, res) => { host = req.headers.host!; remote = req.socket.remoteAddress!; res.end("ipv6 identity"); }), "::1");
  const body = await networkRequest({ type: "system" }, `http://probe.example.test:${port}/trace`, AbortSignal.timeout(3000), { address: "::1" });
  expect(body).toBe("ipv6 identity"); expect(host).toBe(`probe.example.test:${port}`); expect(remote).toBe("::1");
});

it.skipIf(!hasOpenssl)("uses real HTTPS for DoH failover, merges queries, honors TTL and Retry-After, and keeps private names local", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-network-tls-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cert = ensureSelfSigned(home, ["127.0.0.1"]);
  const paths: string[] = [], accepts: string[] = [];
  const server = createHttpsServer({ cert: readFileSync(cert.cert), key: readFileSync(cert.key) }, (req, res) => {
    paths.push(req.url!); accepts.push(req.headers.accept!);
    if (req.url!.startsWith("/limited")) { res.writeHead(429, { "retry-after": "3600" }); res.end(); }
    else res.end(JSON.stringify({ Status: 0, Answer: [{ type: 5, TTL: 30, data: "alias.example.com" }, { type: 28, TTL: 60, data: "2001:db8::10" }] }));
  });
  const port = await listen(server);
  const code = `
    import { Resolver } from 'node:dns/promises';
    import { networkPolicySchema } from ${JSON.stringify(new URL("../src/core/config.ts", import.meta.url).href)};
    import { resolveProbeIpv6 } from ${JSON.stringify(new URL("../src/agents/network-diagnostics.ts", import.meta.url).href)};
    Resolver.prototype.resolve6 = async () => { throw new Error('fixture: AAAA suppressed'); };
    const p = networkPolicySchema.parse({ id:'integration', name:'integration', backends:['test'], probe:{ url:'https://probe.example.com/trace' }, ipv6:{enabled:true, doh:[${JSON.stringify(`https://127.0.0.1:${port}/limited`)},${JSON.stringify(`https://127.0.0.1:${port}/fallback`)}]} });
    const signal = AbortSignal.timeout(10000);
    const values = await Promise.all(Array.from({length:8}, () => resolveProbeIpv6(p,signal,'network-1')));
    await resolveProbeIpv6(p,signal,'network-1');
    await resolveProbeIpv6(p,signal,'network-2');
    const now = Date.now(); Date.now = () => now + 31000;
    await resolveProbeIpv6(p,signal,'network-2');
    p.probe.url = 'https://private.internal/trace';
    const local = await resolveProbeIpv6(p,signal,'network-1');
    console.log(JSON.stringify({ values, local }));
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { cwd: resolve("."), env: { ...process.env, NODE_EXTRA_CA_CERTS: cert.cert }, timeout: 15000 });
  const data = JSON.parse(result.stdout.trim());
  expect(data.values).toHaveLength(8);
  expect(data.values.every((r: { addresses: string[] }) => r.addresses[0] === "2001:db8::10")).toBe(true);
  expect(data.local.addresses).toEqual([]);
  expect(paths.filter((p) => p.startsWith("/limited"))).toHaveLength(1);
  expect(paths.filter((p) => p.startsWith("/fallback"))).toHaveLength(3);
  expect(paths.every((p) => p.includes("name=probe.example.com") && p.includes("type=AAAA"))).toBe(true);
  expect(accepts.every((s) => s === "application/dns-json")).toBe(true);
});

it.skipIf(!hasOpenssl || !hasIpv6)("preserves SNI and TLS certificate checks over an IPv6 CONNECT tunnel", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-network-connect-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cert = ensureSelfSigned(home, ["probe.example.test"]);
  let sni = "", host = "", authority = "";
  const target = createHttpsServer({ cert: readFileSync(cert.cert), key: readFileSync(cert.key) }, (req, res) => { host = req.headers.host!; res.end("secure target"); });
  target.on("secureConnection", (socket) => { sni = (socket as typeof socket & { servername?: string }).servername || ""; });
  const targetPort = await listen(target, "::1");
  const proxy = createHttpServer();
  proxy.on("connect", (req, socket, head) => {
    authority = req.url!;
    const upstream = connect(targetPort, "::1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  const code = `
    import { networkRequest } from ${JSON.stringify(new URL("../src/agents/network-request.ts", import.meta.url).href)};
    const proxy = {type:'proxy',url:'http://127.0.0.1:${proxyPort}'};
    const signal = AbortSignal.timeout(5000);
    const good = await networkRequest(proxy,'https://probe.example.test:${targetPort}/trace',signal,{address:'::1'});
    let wrong = ''; try { await networkRequest(proxy,'https://wrong.example.test:${targetPort}/trace',signal,{address:'::1'}); } catch(e) { wrong = e.code; }
    console.log(JSON.stringify({good,wrong}));
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert.cert }, timeout: 10000 });
  expect(JSON.parse(result.stdout.trim())).toEqual({ good: "secure target", wrong: "ERR_TLS_CERT_ALTNAME_INVALID" });
  expect(authority).toBe(`[::1]:${targetPort}`);
  expect(host).toBe(`probe.example.test:${targetPort}`);
  expect(sni).toBe("probe.example.test");
});
