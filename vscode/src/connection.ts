import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

/**
 * Which omem the extension talks to, and how files on that machine are reached from this window.
 *
 * - `local`: omem runs where this extension runs (this computer, or the machine a Remote-SSH / WSL /
 *   container window is connected to). Loopback needs no token unless omem has one configured.
 * - `direct`: another machine's omem at an address, with the owner's token (`omem link` or
 *   `omem peer invite` print one).
 * - `peer`: a device this computer's omem is paired with (`omem peer list`). The pairings are read
 *   from omem's data directory (`secrets/peers.json`) and the device is reached the way
 *   `omem peer` reaches it (directly, or through the middle device it is paired `via`), so the
 *   omem service here need not run. Without a data directory here, through the local service.
 *
 * Paths from omem are paths on its machine. Opened here as files when that is this machine, else
 * over Remote-SSH (`omem.sshHost`, or the remote this window is already connected to).
 */
export type Mode = "local" | "direct" | "peer";

export const MODE_LABEL: Record<Mode, string> = { local: "这台机器上的 omem", direct: "直接连接", peer: "本机配对的设备" };

/** A pairing as `omem peer add` saved it (src/core/peers.ts). */
export type Paired = { id: string; url: string; urls?: string[]; token: string; via?: string };

/** omem's data directory here: `omem.home`, else OMEM_HOME, else ~/.omem (as the CLI decides). */
export function omemHome() {
  return (cfg().get<string>("home") || "").trim() || process.env.OMEM_HOME || join(homedir(), ".omem");
}

/** This computer's pairings; null when there is no omem data directory here to read them from. */
export function pairedPeers(): Paired[] | null {
  try {
    return JSON.parse(readFileSync(join(omemHome(), "secrets", "peers.json"), "utf8")) as Paired[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`读不了 omem 的配对信息（${join(omemHome(), "secrets", "peers.json")}）：${(e as Error).message}`);
  }
}

const cfg = () => vscode.workspace.getConfiguration("omem");
const trim = (u: string) => u.trim().replace(/\/+$/, "");

export class Connection {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get mode(): Mode {
    const set = cfg().inspect<string>("connection");
    const explicit = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
    if (explicit === "local" || explicit === "direct" || explicit === "peer") return explicit;
    // Before the setting existed an address alone meant another machine.
    const url = cfg().inspect<string>("url");
    return url?.workspaceValue || url?.globalValue ? "direct" : "local";
  }

  /** The omem at an address: the one here (`local`, and `peer` without pairings to read) or `omem.url`. */
  get server() {
    if (this.mode === "direct") return trim(cfg().get<string>("url") || "http://127.0.0.1:4317");
    return `http://127.0.0.1:${cfg().get<number>("port") || 4317}`;
  }

  get peer() {
    return (cfg().get<string>("peer") || "").trim();
  }

  /** Where requests go and with which token. */
  async target(): Promise<{ base: string; token: string | null | undefined }> {
    if (this.mode !== "peer") return { base: this.server, token: await this.token() };
    if (!this.peer) throw new Error("没选设备：运行“omem：连接 omem…”");
    const peers = pairedPeers();
    // No data directory here (omem runs elsewhere, or under another home): the service here forwards.
    if (!peers) return { base: `${this.server}/api/peers/${encodeURIComponent(this.peer)}`, token: await this.token() };
    return route(peers, this.peer, 0);
  }

  /** What the status bar and messages call it. */
  describe() {
    if (this.mode === "peer") {
      if (!this.peer) return "本机配对的设备（没选）";
      const via = pairedPeers()?.find((p) => p.id === this.peer)?.via;
      return via ? `${this.peer}（经 ${via}）` : this.peer;
    }
    if (this.mode === "direct") return this.server.replace(/^https?:\/\//, "");
    return vscode.env.remoteName ? `远程机器上的 omem（${vscode.env.remoteName}）` : "本机 omem";
  }

  // Tokens belong to a server address, so switching between machines keeps each one's.
  private key(server = this.server) {
    return `omem.token:${server}`;
  }
  async token() {
    return (await this.secrets.get(this.key())) ?? (await this.secrets.get("omem.token"));
  }
  async setToken(token: string | null, server = this.server) {
    if (token) await this.secrets.store(this.key(server), token);
    else await this.secrets.delete(this.key(server));
  }

  /** A page of the omem web UI, or null when it is not reachable as a plain address from here. */
  web(hash: string) {
    return this.mode === "peer" ? null : vscode.Uri.parse(`${this.server}/#${hash}`);
  }

  /**
   * Where omem's machine is from this window: files directly, or the remote authority to put in
   * front of its paths (`ssh-remote+<host>`), or null when it cannot be reached yet.
   */
  private remote(): { scheme: string; authority: string } | null | "file" {
    const open = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "vscode-remote");
    if (this.mode === "local") return open ? { scheme: open.uri.scheme, authority: open.uri.authority } : "file";
    const host = (cfg().get<string>("sshHost") || "").trim();
    if (host) return { scheme: "vscode-remote", authority: `ssh-remote+${host}` };
    return open ? { scheme: open.uri.scheme, authority: open.uri.authority } : null;
  }

  /** A path on omem's machine as a URI here; null without a way to reach that machine. */
  uri(path: string): vscode.Uri | null {
    const r = this.remote();
    if (r === "file") return vscode.Uri.file(path);
    if (!r) return null;
    const p = path.replace(/\\/g, "/");
    return vscode.Uri.from({ scheme: r.scheme, authority: r.authority, path: /^[a-zA-Z]:/.test(p) ? `/${p}` : p });
  }

  /** A URI here as a path on omem's machine; null when it is somewhere else. */
  path(uri: vscode.Uri): string | null {
    const r = this.remote();
    if (uri.scheme === "file") return r === "file" ? uri.fsPath : null;
    if (!r || r === "file" || uri.scheme !== r.scheme || uri.authority !== r.authority) return null;
    return /^\/[a-zA-Z]:/.test(uri.path) ? uri.path.slice(1) : uri.path;
  }
}

/** A paired device's API root and token: its own address, or `/api/peers/<id>` on the device it is reached via. */
async function route(peers: Paired[], id: string, hops: number): Promise<{ base: string; token: string }> {
  if (hops > 4) throw new Error("配对的转发层数过多");
  const p = peers.find((x) => x.id === id);
  if (!p) throw new Error(`本机没有配对 ${id}（omem peer list 查看）`);
  if (p.via) {
    const r = await route(peers, p.via, hops + 1);
    return { base: `${r.base}/api/peers/${encodeURIComponent(p.id)}`, token: r.token };
  }
  return { base: await address(p), token: p.token };
}

// The address in use, and when it was settled: the others from the pairing code are tried when it
// stops answering (a new DHCP lease, a VPN on another interface), as `omem peer` does.
const settled = new Map<string, { url: string; at: number }>();
async function address(p: Paired) {
  const known = settled.get(p.id);
  if (known && Date.now() - known.at < 60_000) return known.url;
  const all = [p.url, ...(p.urls ?? []).filter((u) => u !== p.url)].map(trim);
  for (const url of all)
    if (await answers(url, p.token)) {
      settled.set(p.id, { url, at: Date.now() });
      return url;
    }
  return all[0];
}

/**
 * What the owner pasted: a pairing code (`omem peer invite`: its addresses and a token) or a link
 * (`omem link`: an address with `?token=`). Each address is tried; the first that answers wins.
 */
export async function fromPasted(text: string): Promise<{ url: string; token: string; tried: string[] }> {
  const s = text.trim();
  let urls: string[];
  let token: string;
  const code = /^(?:omem peer add\s+)?omem1\.([A-Za-z0-9_-]+)$/.exec(s);
  if (code) {
    const v = JSON.parse(Buffer.from(code[1], "base64url").toString("utf8")) as { urls?: string[]; url?: string; token?: string };
    urls = (v.urls ?? (v.url ? [v.url] : [])).map(trim);
    token = v.token ?? "";
  } else {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error("认不出来：粘贴 omem link 打出的链接，或 omem peer invite 打出的 omem1. 开头的配对码");
    }
    token = u.searchParams.get("token") ?? "";
    urls = [u.origin];
  }
  if (!token) throw new Error("里面没有令牌");
  if (!urls.length) throw new Error("配对码里没有地址：那台机器的 omem 只监听本机，改成监听所有网卡后重新 invite");
  for (const url of urls) if (await answers(url, token)) return { url, token, tried: urls };
  throw new Error(`这些地址都连不上：${urls.join("、")}`);
}

async function answers(url: string, token: string) {
  try {
    const r = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}
