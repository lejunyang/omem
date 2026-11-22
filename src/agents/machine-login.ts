import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { App } from "../core/app.ts";
import { HttpError, now } from "../core/util.ts";
import { accountEntry, clean, cliOf, type AccountEntry } from "./accounts.ts";
import { forgetAvailability } from "./availability.ts";
import { launch, stop } from "./spawn.ts";

/**
 * This machine's own login to a backend: the one the service's runs use when nobody's account is in
 * play (the owner's, and what members borrow when the owner allows it). Logging in used to mean going to
 * the machine and running the CLI there; settings → AI now starts the same screenless login the catalog
 * declares for member accounts (`account.login`, agents/catalog.ts), with the service's own environment
 * and HOME instead of a member's sandbox, shows the link and code on the page, and, for a login that
 * waits for the code the authorization page shows (`input`), takes that code from the page.
 * Owner only: whoever logs in here decides whose account every unsandboxed run of this backend uses.
 */

export type MachineLogin = {
  backend: string;
  name: string;
  /** The catalog says how to log in without a screen. */
  canLogin: boolean;
  /** The catalog says how to check. */
  canCheck: boolean;
  state: "unknown" | "logged-in" | "none";
  user?: string;
  error?: string;
  checkedAt?: string;
  pending: { url: string; code?: string; input: boolean; startedAt: string; sent?: boolean } | null;
};

type Pending = { child: ChildProcessWithoutNullStreams; url: string; code?: string; input: boolean; startedAt: string; sent?: boolean };
const pending = new Map<string, Pending>();
const known = new Map<string, Pick<MachineLogin, "state" | "user" | "error" | "checkedAt">>();
const key = (app: App, backend: string) => `${app.home}|${backend}`;

function entryOf(app: App, backend: string): AccountEntry {
  const e = accountEntry(app, backend);
  if (!e) throw new HttpError(404, `后端 ${backend} 没有声明怎么登录`);
  return e;
}

function startCli(app: App, entry: AccountEntry, args: string[]) {
  return launch(cliOf(entry), args, { cwd: app.home, env: {} });
}

export function machineLogin(app: App, backend: string): MachineLogin {
  const e = entryOf(app, backend);
  const p = pending.get(key(app, backend));
  return {
    backend, name: e.name, canLogin: !!e.account.login, canCheck: !!e.account.status,
    ...(known.get(key(app, backend)) ?? { state: "unknown" as const }),
    pending: p ? { url: p.url, ...(p.code ? { code: p.code } : {}), input: p.input, startedAt: p.startedAt, ...(p.sent ? { sent: true } : {}) } : null,
  };
}

/** Run the backend's status command here; exit 0 is logged in. */
export async function checkMachineLogin(app: App, backend: string): Promise<MachineLogin> {
  const e = entryOf(app, backend);
  const spec = e.account.status;
  if (!spec) return machineLogin(app, backend);
  const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = startCli(app, e, spec.args);
    } catch (err) {
      return resolve({ code: null, out: (err as Error).message });
    }
    child.stdin.end();
    const take = (d: Buffer) => (out = (out + d.toString()).slice(-20_000));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => stop(child), 30_000);
    child.once("error", (err) => (clearTimeout(timer), resolve({ code: null, out: err.message })));
    child.once("close", (code) => (clearTimeout(timer), resolve({ code, out: clean(out) })));
  });
  const user = r.code === 0 && spec.user ? new RegExp(spec.user, "i").exec(r.out)?.[1] : undefined;
  known.set(key(app, backend), r.code === 0
    ? { state: "logged-in", ...(user ? { user } : {}), checkedAt: now() }
    : { state: "none", error: r.out.replace(/\s+/g, " ").trim().slice(-300) || `退出码 ${r.code}`, checkedAt: now() });
  return machineLogin(app, backend);
}

/** Start the backend's screenless login here; resolves once it has printed the link (and code / prompt). */
export function startMachineLogin(app: App, backend: string): Promise<MachineLogin> {
  const e = entryOf(app, backend);
  const spec = e.account.login;
  if (!spec) throw new HttpError(400, `${e.name} 没有无界面的登录方式，要在这台机器的终端里登录`);
  const k = key(app, backend);
  const running = pending.get(k);
  if (running) return Promise.resolve(machineLogin(app, backend));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = startCli(app, e, spec.args);
  } catch (err) {
    throw new HttpError(500, `启动登录失败：${(err as Error).message}`);
  }
  const urlRe = new RegExp(spec.url), codeRe = spec.code ? new RegExp(spec.code) : null, inputRe = spec.input ? new RegExp(spec.input, "i") : null;
  let out = "";
  return new Promise((resolve, reject) => {
    let found: { url: string; code?: string; input: boolean } | null = null;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(first);
      clearTimeout(late);
      if (err || !found) {
        stop(child);
        return reject(err ?? new HttpError(502, "登录命令没有给出链接"));
      }
      const p: Pending = { child, ...found, startedAt: now() };
      pending.set(k, p);
      const overall = setTimeout(() => stop(child), spec.timeoutMs ?? 600_000);
      overall.unref?.();
      child.once("close", () => {
        clearTimeout(overall);
        if (pending.get(k) === p) pending.delete(k);
        forgetAvailability();
        void checkMachineLogin(app, backend).catch(() => {});
      });
      resolve(machineLogin(app, backend));
    };
    const first = setTimeout(() => finish(new HttpError(504, `登录命令 60 秒内没有给出链接：${clean(out).trim().slice(-300) || "没有输出"}`)), 60_000);
    let late: NodeJS.Timeout | undefined;
    const look = (d: Buffer) => {
      out = (out + d.toString()).slice(-20_000);
      const text = clean(out);
      const url = urlRe.exec(text)?.[0];
      if (!url) return;
      const rest = text.replace(url, "");
      const code = codeRe?.exec(rest)?.[0];
      const asks = !!inputRe?.test(rest);
      found = { url, ...(code ? { code } : {}), input: asks || !!inputRe };
      if ((!codeRe || code) && (!inputRe || asks)) finish();
      // The code or the prompt may come a line after the link.
      else late ??= setTimeout(() => finish(), 3000);
    };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.once("error", (err) => finish(new HttpError(500, `启动登录失败：${err.message}`)));
    child.once("close", (code) => {
      if (!settled) finish(new HttpError(502, `登录命令退出了（${code}），没有给出链接：${clean(out).trim().slice(-300) || "没有输出"}`));
    });
  });
}

/** The code from the authorization page, for a login that waits for it. */
export function sendMachineLoginInput(app: App, backend: string, text: string) {
  const p = pending.get(key(app, backend));
  if (!p?.input) throw new HttpError(409, "没有在等授权码的登录：重新点“登录”");
  const line = text.trim();
  if (!line || line.length > 4000 || /[\r\n]/.test(line)) throw new HttpError(400, "授权码是一行文字");
  p.child.stdin.write(line + "\n");
  p.sent = true;
  return machineLogin(app, backend);
}

export function cancelMachineLogin(app: App, backend: string) {
  const k = key(app, backend);
  const p = pending.get(k);
  if (p) {
    pending.delete(k);
    stop(p.child);
  }
  return machineLogin(app, backend);
}
