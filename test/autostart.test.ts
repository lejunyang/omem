import { describe, expect, it } from "vitest";
import { autostartPlan } from "../src/core/autostart.ts";

const base = { home: "/data/my omem", node: "/opt/node/bin/node", entry: "/opt/omem/dist/src/cli.js", path: "/opt/node/bin:/usr/bin", userHome: "/home/u", user: "u" };

describe("autostart plans", () => {
  it("macOS: a LaunchAgent that runs the launcher at load", () => {
    const p = autostartPlan({ ...base, platform: "darwin" });
    expect(p.where).toMatch(/^\/home\/u\/Library\/LaunchAgents\/dev\.omem-[0-9a-f]{6}\.plist$/);
    const plist = p.files[p.where];
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/data/my omem/service/autostart.sh");
    const sh = p.files["/data/my omem/service/autostart.sh"];
    expect(sh).toContain("export PATH='/opt/node/bin:/usr/bin'");
    expect(sh).toContain("exec '/opt/node/bin/node' '/opt/omem/dist/src/cli.js' --home '/data/my omem' service start");
    expect(p.commands.at(-1)!.argv.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
  });

  it("Linux: a systemd user unit, enabled, with lingering so it starts at boot", () => {
    const p = autostartPlan({ ...base, platform: "linux", systemd: true });
    expect(p.where).toMatch(/\.config\/systemd\/user\/omem-[0-9a-f]{6}\.service$/);
    expect(p.files[p.where]).toContain("ExecStart=/bin/sh /data/my omem/service/autostart.sh");
    expect(p.files[p.where]).toContain("WantedBy=default.target");
    expect(p.commands.map((c) => c.argv[0])).toEqual(["systemctl", "systemctl", "loginctl"]);
    expect(p.commands[2]).toMatchObject({ argv: ["loginctl", "enable-linger", "u"], optional: true });
  });

  it("Linux without user systemd: crontab @reboot", () => {
    const p = autostartPlan({ ...base, platform: "linux", systemd: false });
    expect(p.where).toBe("crontab @reboot");
    expect(Object.keys(p.files)).toEqual(["/data/my omem/service/autostart.sh"]);
  });

  it("Windows: a hidden launcher in the Startup folder", () => {
    const p = autostartPlan({ ...base, home: "C:\\Users\\u\\.omem2", node: "C:\\node\\node.exe", entry: "C:\\omem\\dist\\src\\cli.js", path: "C:\\node;C:\\Windows", platform: "win32" });
    expect(p.where).toMatch(/Startup[\\/]omem-[0-9a-f]{6}\.vbs$/);
    expect(p.files[p.where]).toMatch(/^CreateObject\("WScript\.Shell"\)\.Run """.*autostart\.cmd""", 0, False/);
    const cmd = Object.entries(p.files).find(([f]) => f.endsWith("autostart.cmd"))![1];
    expect(cmd).toContain('set "PATH=C:\\node;C:\\Windows"');
    expect(cmd).toContain('"C:\\node\\node.exe" "C:\\omem\\dist\\src\\cli.js" --home "C:\\Users\\u\\.omem2" service start');
    expect(p.commands).toEqual([]);
  });
});
