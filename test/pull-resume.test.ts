import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addPeer, invite, peerFetch } from "../src/core/peers.ts";
import { cleanupFetched, fetchPeer } from "../src/core/pull.ts";
import { byteRange, sweepHeldSnapshotsForTests } from "../src/core/pull-held.ts";
import { boot } from "../src/main.ts";
import { importText } from "../src/sources/import.ts";

/**
 * A pull over a link that breaks (core/pull-transfer.ts, core/pull-held.ts): the other side keeps the
 * snapshot on disk, the puller takes it in pieces and goes on from the byte a broken piece stopped at.
 * The link here is a small forwarder between the two that cuts responses on request.
 */
describe("pulling a snapshot over a link that breaks", async () => {
  const homeA = mkdtempSync(join(tmpdir(), "omem-resume-server-"));
  const homeB = mkdtempSync(join(tmpdir(), "omem-resume-laptop-"));
  writeFileSync(join(homeA, "config.json"), JSON.stringify({ node: { id: "server" } }));
  writeFileSync(join(homeB, "config.json"), JSON.stringify({ node: { id: "laptop" } }));
  const a = await boot(homeA, { port: 0, quiet: true, background: false });
  const b = await boot(homeB, { port: 0, quiet: true, background: false });
  const A = a.app;
  const B = b.app;
  A.config.token = "owner-server";
  // Enough text that the snapshot is several pieces long.
  for (let i = 0; i < 40; i++) importText(A, "personal", { title: `报销制度 ${i}`, text: `# 报销制度 ${i}\n\n${`差旅报销在出差结束后 ${i + 1} 天内提交。`.repeat(400)}`, kind: "doc" });

  // What the link does to the next responses.
  const link = { cutDataAfter: -1, dataGone: 0, oldServer: false };
  const seen: string[] = [];
  const upstream = new URL(A.baseUrl!);
  const forwarder = createServer((req, res) => {
    const path = req.url ?? "/";
    const data = req.method === "GET" && path.endsWith("/data");
    seen.push(`${req.method} ${path}${data ? ` ${req.headers.range ?? ""}` : ""}`);
    if (link.oldServer && req.method === "POST" && path === "/api/peer/snapshot") return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Route POST:/api/peer/snapshot not found" }));
    if (data && link.dataGone > 0) {
      link.dataGone--;
      return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
    }
    const up = request({ host: upstream.hostname, port: upstream.port, method: req.method, path, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      if (!data || link.cutDataAfter < 0) return void r.pipe(res);
      let sent = 0;
      r.on("data", (part: Buffer) => {
        const room = link.cutDataAfter - sent;
        if (room > 0) res.write(part.subarray(0, room));
        sent += part.length;
        if (sent >= link.cutDataAfter) {
          r.destroy();
          // Mid-body, without the end of the response: what a firewall closing the port looks like.
          setTimeout(() => res.socket?.destroy(), 20);
        }
      });
      r.on("end", () => res.end());
    });
    up.on("error", () => res.socket?.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => forwarder.listen(0, "127.0.0.1", r));
  afterAll(async () => {
    forwarder.close();
    await b.server.close();
    await a.server.close();
  });
  await addPeer(B, invite(A, { url: A.baseUrl! }).code);
  const peers = join(B.home, "secrets", "peers.json");
  const via = `http://127.0.0.1:${(forwarder.address() as AddressInfo).port}`;
  writeFileSync(peers, JSON.stringify((JSON.parse(readFileSync(peers, "utf8")) as object[]).map((p) => ({ ...p, url: via, urls: [via] }))));

  beforeEach(() => {
    Object.assign(link, { cutDataAfter: -1, dataGone: 0, oldServer: false });
    seen.length = 0;
  });
  const titles = (dir: string) => {
    const db = new DatabaseSync(join(dir, "omem.db"), { readOnly: true });
    try { return (db.prepare("select title from sources where kind = 'doc'").all() as { title: string }[]).map((s) => s.title); }
    finally { db.close(); }
  };
  const quick = { chunkBytes: 256 * 1024, retryMs: 5, pollMs: 20 };
  const heldOnDisk = () => (existsSync(join(A.home, "tmp", "pull-held")) ? readdirSync(join(A.home, "tmp", "pull-held")) : []);

  it("goes on from the byte a broken piece stopped at, and the other side drops its copy afterwards", async () => {
    link.cutDataAfter = 100 * 1024;
    const said: string[] = [];
    const fetched = await fetchPeer(B, "server", { selection: { parts: ["library"], strip: true }, log: (s) => said.push(s), ...quick });
    try {
      expect(titles(fetched.dbDir)).toHaveLength(40);
      expect(existsSync(join(fetched.libraryDir, ".git"))).toBe(true);
    } finally { cleanupFetched(fetched); }
    // Every piece broke after 100 KB: the next one starts where it stopped, never again from nothing.
    const starts = seen.filter((s) => s.includes("/data ")).map((s) => Number(/bytes=(\d+)-/.exec(s)![1]));
    expect(starts.length).toBeGreaterThan(3);
    expect(starts).toEqual(starts.map((_, i) => i * 100 * 1024));
    expect(seen.filter((s) => s === "POST /api/peer/snapshot")).toHaveLength(1);
    expect(said.join("\n")).toMatch(/分块取/);
    expect(said.join("\n")).toMatch(/时断了.*接着传/);
    expect(seen.at(-1)).toMatch(/^DELETE \/api\/peer\/snapshot\/[a-f0-9]+$/);
    expect(heldOnDisk()).toEqual([]);
  }, 60_000);

  it("gives up once nothing has got through for the time allowed, saying how far it came", async () => {
    link.cutDataAfter = 0;
    await expect(fetchPeer(B, "server", { selection: { parts: [], strip: true }, ...quick, stallMs: 300 })).rejects.toThrow(/快照传到 0\.0 MB \/ .* MB 后 .*没再收到数据/);
    expect(heldOnDisk()).toEqual([]);
  }, 60_000);

  it("asks for a new snapshot when the other side lost the one it kept (a restart)", async () => {
    link.dataGone = 1;
    const said: string[] = [];
    const fetched = await fetchPeer(B, "server", { selection: { parts: [], strip: true }, log: (s) => said.push(s), ...quick });
    try { expect(titles(fetched.dbDir)).toHaveLength(40); } finally { cleanupFetched(fetched); }
    expect(seen.filter((s) => s === "POST /api/peer/snapshot")).toHaveLength(2);
    expect(said.join("\n")).toMatch(/重新要一份/);
  }, 60_000);

  it("takes the snapshot in one stream from an older device", async () => {
    link.oldServer = true;
    const fetched = await fetchPeer(B, "server", { selection: { parts: [], strip: true }, ...quick });
    try { expect(titles(fetched.dbDir)).toHaveLength(40); } finally { cleanupFetched(fetched); }
    expect(seen.some((s) => s.startsWith("GET /api/peer/snapshot?"))).toBe(true);
    expect(seen.some((s) => s.includes("/data"))).toBe(false);
  }, 60_000);

  it("serves a kept snapshot by byte range, keeps two at most, and removes one nobody asked about for half an hour", async () => {
    const ask = async () => ((await (await peerFetch(B, "server", "/api/peer/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: "", strip: true, files: "separate" }) })).json()) as { id: string }).id;
    const info = async (id: string) => {
      const res = await peerFetch(B, "server", `/api/peer/snapshot/${id}`);
      return res.ok ? ((await res.json()) as { state: string; size?: number }) : { state: `${res.status}` };
    };
    const first = await ask();
    let ready = await info(first);
    for (let i = 0; ready.state === "building" && i < 500; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ready = await info(first);
    }
    expect(ready).toMatchObject({ state: "ready", size: expect.any(Number) });
    const size = ready.size!;
    const piece = await peerFetch(B, "server", `/api/peer/snapshot/${first}/data`, { headers: { range: "bytes=512-1023" } });
    expect(piece.status).toBe(206);
    expect(piece.headers.get("content-range")).toBe(`bytes 512-1023/${size}`);
    expect((await piece.arrayBuffer()).byteLength).toBe(512);
    const past = await peerFetch(B, "server", `/api/peer/snapshot/${first}/data`, { headers: { range: `bytes=${size}-` } });
    expect(past.status).toBe(416);
    // A member's token gets nothing.
    expect((await fetch(`${A.baseUrl}/api/peer/snapshot/${first}`, { headers: { authorization: "Bearer nobody" } })).status).toBeGreaterThanOrEqual(401);
    // A third one pushes out the one used longest ago.
    const second = await ask();
    await info(first);
    const third = await ask();
    expect((await info(second)).state).toBe("404");
    expect((await info(first)).state).toBe("ready");
    expect((await info(third)).state).not.toBe("404");
    expect(sweepHeldSnapshotsForTests(Date.now() + 31 * 60_000)).toBe(0);
    expect((await info(first)).state).toBe("404");
    await new Promise((r) => setTimeout(r, 300));
    sweepHeldSnapshotsForTests(Date.now());
  }, 60_000);

  it("reads a Range header", () => {
    expect(byteRange(undefined, 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(byteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19, partial: true });
    expect(byteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(byteRange("bytes=100-", 100)).toBeNull();
  });
});
