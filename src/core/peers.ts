import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { App } from "./app.ts";
import { createApiToken, OWNER } from "./users.ts";

/**
 * Peers: other omem instances this one can talk to over HTTP.
 *
 * The typical setup is one instance that runs all the time (capture, schedules) and
 * others (laptops) that pull its data, look at its state and ask it to run checks.
 * Machines need not reach each other directly: a peer can be reached `via` another
 * peer, which forwards the request (`/api/peers/<id>/…`).
 *
 * Pairing is one line each way:
 *   on the server  `omem peer invite [--url http://host:4317]` → prints a code
 *   on the client  `omem peer add <code> [--via <peer>]`
 * The code carries the inviting node's id, its URL and an API token created for the
 * owner (label `peer:<id>`), so revoking it is revoking that token. Tokens are
 * per user, which leaves room for other people's devices to pair as members later.
 */
export type Peer = { id: string; url: string; token: string; via?: string; addedAt: string };

const file = (app: App) => join(app.home, "secrets", "peers.json");

export function nodeId(app: App) {
  return (app.config.node?.id || hostname().split(".")[0] || "omem").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export function listPeers(app: App): Peer[] {
  try {
    return JSON.parse(readFileSync(file(app), "utf8")) as Peer[];
  } catch {
    return [];
  }
}

function savePeers(app: App, peers: Peer[]) {
  mkdirSync(join(app.home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(file(app), JSON.stringify(peers, null, 2), { mode: 0o600 });
  try {
    chmodSync(file(app), 0o600);
  } catch {}
}

export function findPeer(app: App, id: string): Peer | null {
  return listPeers(app).find((p) => p.id === id) ?? null;
}

/** A pairing code for another machine: this node's id, URL and a new owner token. */
export function invite(app: App, opts: { url?: string; label?: string } = {}) {
  const id = nodeId(app);
  const url = (opts.url ?? app.baseUrl ?? `http://${hostname()}:${app.config.port}`).replace(/\/+$/, "");
  const token = createApiToken(app, OWNER, `peer:${opts.label ?? "device"}`);
  const code = "omem1." + Buffer.from(JSON.stringify({ id, url, token })).toString("base64url");
  return { id, url, code };
}

export function decodeInvite(code: string): { id: string; url: string; token: string } {
  const m = /^omem1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error("配对码格式不对（应以 omem1. 开头）");
  const v = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  if (!v.id || !v.url || !v.token) throw new Error("配对码不完整");
  return v;
}

export function addPeer(app: App, code: string, opts: { via?: string; url?: string } = {}) {
  const v = decodeInvite(code);
  if (opts.via && !findPeer(app, opts.via)) throw new Error(`没有名为 ${opts.via} 的同伴；先添加它`);
  const peer: Peer = { id: v.id, url: (opts.url ?? v.url).replace(/\/+$/, ""), token: v.token, via: opts.via, addedAt: new Date().toISOString() };
  savePeers(app, [...listPeers(app).filter((p) => p.id !== peer.id), peer]);
  return peer;
}

export function removePeer(app: App, id: string) {
  const before = listPeers(app);
  savePeers(app, before.filter((p) => p.id !== id));
  return before.length !== listPeers(app).length;
}

/**
 * Request a path on a peer. A peer reached `via` another one goes through that peer's
 * forwarding endpoint with that peer's token (any depth, at most a few hops).
 */
export async function peerFetch(app: App, id: string, path: string, init: RequestInit & { timeoutMs?: number } = {}, hops = 0): Promise<Response> {
  if (hops > 4) throw new Error("同伴转发层数过多");
  const p = findPeer(app, id);
  if (!p) throw new Error(`没有名为 ${id} 的同伴（omem peer list 查看）`);
  if (p.via) return peerFetch(app, p.via, `/api/peers/${encodeURIComponent(p.id)}${path}`, init, hops + 1);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${p.token}`);
  headers.set("x-omem-hops", String(hops));
  return fetch(p.url + path, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
}

export async function peerJson<T = unknown>(app: App, id: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await peerFetch(app, id, path, body === undefined ? { timeoutMs } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, timeoutMs });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new Error(`${id}：${(data as { error?: string })?.error ?? res.statusText}`);
  return data as T;
}

/** The code version this instance runs (git commit of the package, if it is a checkout). */
export function codeVersion(root: string) {
  if (!existsSync(join(root, ".git"))) return null;
  const r = spawnSync("git", ["-C", root, "log", "-1", "--format=%h %cI %s"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
