import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { toolCommand } from "../core/tools.ts";
import { HttpError } from "../core/util.ts";

/**
 * The processes of ai-auto-desktop (`aad`) that remote operation runs (docs/v2/remote.md): one-off
 * commands that answer JSON, long-lived ones (`assist`, `record`), and `aad mcp` spoken to over stdio.
 */

export function aadCommand(): string[] {
  const cmd = toolCommand("aad");
  if (!cmd) throw new HttpError(409, "这台机器没有装 ai-auto-desktop（设置 → Agent 里安装，或 omem setup desktop）");
  return cmd;
}

/** The JSON a one-off command printed (some answer `{status, data}`, some the value itself). */
export function aadJson(args: string[], timeoutMs = 60_000): any {
  const [bin, ...rest] = aadCommand();
  const r = spawnSync(bin, [...rest, ...args], { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 << 20 });
  if (r.error) throw new HttpError(502, `aad ${args[0]} 没能运行：${r.error.message}`);
  let value: any;
  try {
    value = JSON.parse(r.stdout);
  } catch {
    throw new HttpError(502, `aad ${args[0]} 的输出不是 JSON：${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  if (value?.status === "error") throw new HttpError(502, `aad ${args[0]}：${value.error?.message ?? "失败"}`);
  return value?.data ?? value;
}

/** A long-lived aad process, its standard input kept open (closing it is how `record` is stopped). */
export function spawnAad(args: string[]): ChildProcess {
  const [bin, ...rest] = aadCommand();
  return spawn(bin, [...rest, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

/** The first line a process prints, as JSON (`aad assist` announces where it listens that way). */
export function firstJsonLine(proc: ChildProcess, timeoutMs: number): Promise<any> {
  return new Promise((ok, fail) => {
    let err = "";
    proc.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
    const lines = createInterface({ input: proc.stdout! });
    const timer = setTimeout(() => done(new Error("aad 没有按时开始")), timeoutMs);
    const done = (e: Error | null, value?: any) => {
      clearTimeout(timer);
      lines.removeAllListeners();
      proc.off("exit", exited);
      if (e) fail(new HttpError(502, `${e.message}${err.trim() ? `：${err.trim().slice(-300)}` : ""}`));
      else ok(value);
    };
    const exited = (code: number | null) => done(new Error(`aad 提前退出（${code}）`));
    proc.on("exit", exited);
    lines.on("line", (line) => {
      try {
        done(null, JSON.parse(line));
      } catch {
        /* a progress line before the announcement */
      }
    });
  });
}

/** Everything a process printed on stdout once it exits, as JSON (`aad record` answers when stopped). */
export function finalJson(proc: ChildProcess, timeoutMs: number): Promise<any> {
  return new Promise((ok, fail) => {
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => {
      proc.kill();
      fail(new HttpError(504, "aad 没有按时结束"));
    }, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(out);
        if (value?.status === "error") return fail(new HttpError(502, value.error?.message ?? "aad 失败"));
        ok(value?.data ?? value);
      } catch {
        fail(new HttpError(502, `aad 的输出不是 JSON：${(err || out).trim().slice(-300)}`));
      }
    });
  });
}

/** One `aad mcp` process spoken to over stdio: tool calls in, their JSON results out. */
export class AadMcp {
  readonly proc: ChildProcess;
  private next = 1;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private err = "";

  constructor(args: string[]) {
    this.proc = spawnAad(["mcp", ...args]);
    this.proc.stderr?.on("data", (d) => (this.err = (this.err + d).slice(-2000)));
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.fail(new HttpError(502, `aad mcp：${msg.error.message}`));
      else w.ok(msg.result);
    });
    this.proc.on("exit", (code) => {
      for (const w of this.waiting.values()) w.fail(new HttpError(502, `aad mcp 退出了（${code}）${this.err.trim() ? `：${this.err.trim().slice(-300)}` : ""}`));
      this.waiting.clear();
    });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        fail(new HttpError(504, `aad mcp 的 ${method} 超时`));
      }, timeoutMs);
      this.waiting.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), fail: (e) => (clearTimeout(timer), fail(e)) });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async start() {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "omem", version: "1" } }, 30_000);
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return this;
  }

  /** A tool's answer as JSON; a tool error becomes an HttpError carrying its message. */
  async call(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = result?.content?.find((c: { type: string }) => c.type === "text")?.text ?? "{}";
    let value: any;
    try {
      value = JSON.parse(text);
    } catch {
      value = { message: text };
    }
    if (result?.isError) throw new HttpError(502, `aad ${name}：${value?.error?.message ?? value?.message ?? text.slice(0, 300)}`);
    return value?.data ?? value;
  }

  close() {
    this.proc.stdin?.end();
    setTimeout(() => this.proc.kill(), 3_000).unref();
  }
}
