import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { omemHome } from "./config.ts";

/**
 * Start the background service when the user logs in (or the machine boots, for a
 * Linux server with lingering). `omem service enable` writes a small launcher in the
 * data directory and registers it with the system:
 *
 *   macOS    ~/Library/LaunchAgents/<label>.plist (RunAtLoad), loaded with launchctl
 *   Linux    systemd user unit (+ `loginctl enable-linger` so it starts without a login);
 *            crontab `@reboot` when there is no user systemd
 *   Windows  a hidden .vbs in the Startup folder (no admin rights needed)
 *
 * The launcher runs `omem service start` with the PATH of whoever enabled it, so the
 * agents, uv, lark-cli… found now are found after a reboot too.
 */
export type AutostartPlan = {
  platform: NodeJS.Platform;
  /** Files to write: path → content. */
  files: Record<string, string>;
  /** Commands to run after writing, in order; failures of `optional` ones are reported, not fatal. */
  commands: { argv: string[]; optional?: boolean; why?: string }[];
  /** Where it is registered, for messages. */
  where: string;
};

export function autostartLabel(home: string) {
  const def = resolve(omemHome()) === resolve(home) || resolve(join(homedir(), ".omem")) === resolve(home);
  return def ? "omem" : `omem-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 6)}`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** What enabling would do on this platform (pure: no side effects, testable). */
export function autostartPlan(opts: { home: string; node: string; entry: string; path: string; platform?: NodeJS.Platform; userHome?: string; user?: string; systemd?: boolean }): AutostartPlan {
  const platform = opts.platform ?? process.platform;
  const userHome = opts.userHome ?? homedir();
  const label = autostartLabel(opts.home);
  const dir = join(opts.home, "service");
  const log = join(dir, "logs", "autostart.log");
  if (platform === "win32") {
    const cmd = join(dir, "autostart.cmd");
    const startup = join(process.env.APPDATA ?? join(userHome, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const vbs = join(startup, `${label}.vbs`);
    return {
      platform,
      where: vbs,
      files: {
        [cmd]: [
          "@echo off",
          `set "PATH=${opts.path}"`,
          `set "OMEM_HOME=${opts.home}"`,
          `"${opts.node}" "${opts.entry}" --home "${opts.home}" service start >> "${log}" 2>&1`,
          "",
        ].join("\r\n"),
        [vbs]: `CreateObject("WScript.Shell").Run """${cmd}""", 0, False\r\n`,
      },
      commands: [],
    };
  }
  const sh = join(dir, "autostart.sh");
  const script = [
    "#!/bin/sh",
    `export PATH=${shq(opts.path)}`,
    `export OMEM_HOME=${shq(opts.home)}`,
    `exec ${shq(opts.node)} ${shq(opts.entry)} --home ${shq(opts.home)} service start >> ${shq(log)} 2>&1`,
    "",
  ].join("\n");
  if (platform === "darwin") {
    const id = `dev.${label}`;
    const plist = join(userHome, "Library", "LaunchAgents", `${id}.plist`);
    const uid = String(process.getuid?.() ?? "");
    return {
      platform,
      where: plist,
      files: {
        [sh]: script,
        [plist]: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(id)}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(sh)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
      },
      commands: [
        { argv: ["launchctl", "bootout", `gui/${uid}/${id}`], optional: true, why: "卸下旧的" },
        { argv: ["launchctl", "bootstrap", `gui/${uid}`, plist] },
      ],
    };
  }
  // Linux and other Unix.
  const unit = join(userHome, ".config", "systemd", "user", `${label}.service`);
  if (opts.systemd ?? hasUserSystemd()) {
    return {
      platform,
      where: unit,
      files: {
        [sh]: script,
        [unit]: `[Unit]
Description=omem (${opts.home})
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh ${sh}

[Install]
WantedBy=default.target
`,
      },
      commands: [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        { argv: ["systemctl", "--user", "enable", `${label}.service`] },
        { argv: ["loginctl", "enable-linger", opts.user ?? userInfo().username], optional: true, why: "不登录也在开机时启动" },
      ],
    };
  }
  return { platform, where: "crontab @reboot", files: { [sh]: script }, commands: [] };
}

function hasUserSystemd() {
  if (process.platform !== "linux") return false;
  const r = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0;
}

const CRON_MARK = "# omem-autostart";

function crontabLines(): string[] {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}
function setCrontab(lines: string[]) {
  const r = spawnSync("crontab", ["-"], { input: lines.join("\n") + "\n", encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`crontab 写入失败：${r.stderr.trim()}`);
}

function run(argv: string[]) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

export function enableAutostart(home: string, node: string, entry: string) {
  const plan = autostartPlan({ home, node, entry, path: process.env.PATH ?? "" });
  mkdirSync(join(home, "service", "logs"), { recursive: true });
  for (const [file, content] of Object.entries(plan.files)) {
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, content, { mode: file.endsWith(".sh") ? 0o755 : 0o644 });
  }
  const notes: string[] = [];
  for (const c of plan.commands) {
    const r = run(c.argv);
    if (!r.ok && !c.optional) throw new Error(`${c.argv.join(" ")} 失败：${r.out}`);
    if (!r.ok) notes.push(`${c.why ?? c.argv.join(" ")}没有设置成功（${c.argv.join(" ")}：${r.out.split("\n")[0]}）`);
  }
  if (plan.where === "crontab @reboot") {
    const sh = Object.keys(plan.files)[0];
    const line = `@reboot /bin/sh ${shq(sh)} ${CRON_MARK} ${autostartLabel(home)}`;
    setCrontab([...crontabLines().filter((l) => !l.endsWith(`${CRON_MARK} ${autostartLabel(home)}`)), line]);
  }
  return { where: plan.where, notes };
}

export function disableAutostart(home: string) {
  const plan = autostartPlan({ home, node: "", entry: "", path: "" });
  const label = autostartLabel(home);
  if (plan.platform === "darwin") run(["launchctl", "bootout", `gui/${process.getuid?.()}/dev.${label}`]);
  if (plan.where.endsWith(".service")) run(["systemctl", "--user", "disable", `${label}.service`]);
  if (plan.where === "crontab @reboot" || process.platform === "linux") {
    const lines = crontabLines();
    const kept = lines.filter((l) => !l.endsWith(`${CRON_MARK} ${label}`));
    if (kept.length !== lines.length) setCrontab(kept);
  }
  const removed = Object.keys(plan.files).filter((f) => existsSync(f));
  for (const f of removed) rmSync(f, { force: true });
  return { removed };
}

export function autostartStatus(home: string) {
  const plan = autostartPlan({ home, node: "", entry: "", path: "" });
  if (plan.where === "crontab @reboot") return crontabLines().some((l) => l.endsWith(`${CRON_MARK} ${autostartLabel(home)}`)) ? plan.where : null;
  if (!existsSync(plan.where)) return null;
  if (plan.where.endsWith(".service")) {
    const r = run(["systemctl", "--user", "is-enabled", `${autostartLabel(home)}.service`]);
    return r.ok ? plan.where : null;
  }
  // The launcher must still point at a node that exists (after a Node upgrade it may not).
  const launcher = Object.keys(plan.files).find((f) => f.endsWith(".sh") || f.endsWith(".cmd"));
  return launcher && existsSync(launcher) && readFileSync(launcher, "utf8").length ? plan.where : null;
}
