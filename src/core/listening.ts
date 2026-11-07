import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * Which TCP ports a process and what it started listen on, and how many connections they have
 * (docs/v2/preview.md). Linux reads /proc, macOS asks lsof, Windows netstat plus the process list.
 * The parsers are exported for tests; `scanPorts` is what callers use.
 */

export type Socket = { host: string; port: number; listening: boolean; pid?: number; inode?: number };
export type PortScan = { listening: { port: number; hosts: string[] }[]; connections: Map<number, number> };

const run = (cmd: string, args: string[]) =>
  new Promise<string>((ok) => execFile(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 50_000_000 }, (_e, out) => ok(out ?? "")));

/** `root` and every process under it, from [pid, parent] pairs. */
export function descendants(root: number, pairs: [number, number][]): Set<number> {
  const kids = new Map<number, number[]>();
  for (const [pid, parent] of pairs) if (pid !== parent) kids.set(parent, [...(kids.get(parent) ?? []), pid]);
  const out = new Set<number>([root]);
  const todo = [root];
  while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) if (!out.has(k)) (out.add(k), todo.push(k));
  return out;
}

async function processPairs(): Promise<[number, number][]> {
  if (process.platform === "linux") {
    const out: [number, number][] = [];
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        // The name in parentheses can hold spaces: the fields after the last ")" are "state ppid …".
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        out.push([Number(d), ppid]);
      } catch { /* gone meanwhile */ }
    }
    return out;
  }
  const text = process.platform === "win32"
    ? await run("powershell", ["-NoProfile", "-Command", 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'])
    : await run("ps", ["-A", "-o", "pid=,ppid="]);
  return text.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][];
}

// ---- /proc/net/tcp -----------------------------------------------------------------------------

/** A /proc/net/tcp address: IPv4 is one little-endian word; IPv6 four of them. */
function procHost(hex: string): string {
  if (hex.length === 8) return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) for (let b = 3; b >= 0; b--) bytes.push(parseInt(hex.slice(w * 8 + b * 2, w * 8 + b * 2 + 2), 16));
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join(".");
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16));
  return compactV6(groups);
}

function compactV6(groups: string[]) {
  // The longest run of zero groups becomes "::".
  let best = -1, len = 0;
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > len && j - i > 1) (best = i), (len = j - i);
    i = j > i ? j - 1 : i;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + len).join(":")}`;
}

/** Sockets in /proc/net/tcp or tcp6: listening (state 0A) and established (01) ones. */
export function parseProcNetTcp(text: string): Socket[] {
  const out: Socket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [addr, port] = f[1].split(":");
    const remotePort = parseInt(f[2].split(":")[1] ?? "0", 16);
    const st = f[3];
    if (st !== "0A" && st !== "01") continue;
    out.push({ host: procHost(addr), port: parseInt(port, 16), listening: st === "0A" && remotePort === 0, inode: Number(f[9]) });
  }
  return out;
}

function linuxSocketsOf(pids: Set<number>): Set<number> {
  const inodes = new Set<number>();
  for (const pid of pids) {
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch { continue; }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) inodes.add(Number(m[1]));
      } catch { /* closed meanwhile */ }
    }
  }
  return inodes;
}

// ---- netstat (Windows) -------------------------------------------------------------------------

function splitHostPort(s: string): { host: string; port: number } | null {
  const m = /^\[?(.*?)\]?:(\d+|\*)$/.exec(s);
  if (!m) return null;
  return { host: m[1] === "*" ? "0.0.0.0" : m[1].replace(/%.*$/, ""), port: m[2] === "*" ? 0 : Number(m[2]) };
}

/** `netstat -ano` TCP lines. Listening is told by the remote port 0 (the state text is localized). */
export function parseNetstat(text: string): Socket[] {
  const out: Socket[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "TCP" || f.length < 5) continue;
    const local = splitHostPort(f[1]);
    const remote = splitHostPort(f[2]);
    if (!local || !remote) continue;
    const state = f[3];
    const listening = remote.port === 0;
    // Half-closed and closing ones are no viewer any more; unknown (localized) states count as open.
    if (!listening && /TIME_WAIT|CLOSE|FIN_WAIT|LAST_ACK|SYN_/i.test(state)) continue;
    out.push({ host: local.host, port: local.port, listening, pid: Number(f[f.length - 1]) });
  }
  return out;
}

// ---- lsof (macOS) ------------------------------------------------------------------------------

/** `lsof -nP -iTCP -F pnT`: `p<pid>`, then `n<local>[-><remote>]` and `TST=<state>` per socket. */
export function parseLsof(text: string): Socket[] {
  const out: Socket[] = [];
  let pid = 0;
  let cur: Socket | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const [local, remote] = line.slice(1).split("->");
      const l = splitHostPort(local);
      cur = l ? { host: l.host, port: l.port, listening: !remote, pid } : null;
      if (cur) out.push(cur);
    } else if (line.startsWith("TST=") && cur) {
      const st = line.slice(4);
      cur.listening = st === "LISTEN";
      if (st !== "LISTEN" && st !== "ESTABLISHED") out.splice(out.indexOf(cur), 1);
      cur = null;
    }
  }
  return out;
}

// ---- the scan ----------------------------------------------------------------------------------

/** Where to connect to reach a listener bound to `host` on this machine. */
export function dialHost(host: string) {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

async function sockets(pids: Set<number>): Promise<{ all: Socket[]; mine: (s: Socket) => boolean }> {
  if (process.platform === "linux") {
    const all = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((f) => {
      try {
        return parseProcNetTcp(readFileSync(f, "utf8"));
      } catch {
        return [];
      }
    });
    const inodes = linuxSocketsOf(pids);
    return { all, mine: (s) => inodes.has(s.inode ?? -1) };
  }
  const all = process.platform === "win32" ? parseNetstat(await run("netstat", ["-ano", "-p", "TCP"]) + "\n" + await run("netstat", ["-ano", "-p", "TCPv6"])) : parseLsof(await run("lsof", ["-nP", "-iTCP", "-F", "pnT"]));
  return { all, mine: (s) => pids.has(s.pid ?? -1) };
}

/**
 * The ports `root` and its descendants listen on, and for each of them how many connections are
 * open to it right now (from anyone: a browser here, or omem's own forwarding).
 */
export async function scanPorts(root: number): Promise<PortScan> {
  const pids = descendants(root, await processPairs());
  const { all, mine } = await sockets(pids);
  const by = new Map<number, Set<string>>();
  for (const s of all) if (s.listening && s.port && mine(s)) by.set(s.port, (by.get(s.port) ?? new Set()).add(s.host));
  const connections = new Map<number, number>();
  for (const s of all) if (!s.listening && by.has(s.port)) connections.set(s.port, (connections.get(s.port) ?? 0) + 1);
  const listening = [...by].sort((a, b) => a[0] - b[0]).map(([port, hosts]) => {
    // Loopback first, IPv4 before IPv6: what a dev server bound to "localhost" answers on.
    const order = (h: string) => (h === "127.0.0.1" ? 0 : h === "0.0.0.0" ? 1 : h === "::1" ? 2 : h === "::" ? 3 : 4);
    return { port, hosts: [...new Set([...hosts].map(dialHost))].sort((a, b) => order(a) - order(b)) };
  });
  return { listening, connections };
}
