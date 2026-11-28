import { spawnSync } from "node:child_process";
import { readSandboxConfig } from "./sandbox-config-file.ts";

// Only settings that make sense without host paths, helpers or signing credentials.
const preferences = new Set([
  "user.name", "user.email", "user.useconfigonly",
  "core.autocrlf", "core.eol", "core.safecrlf", "core.quotepath", "core.filemode",
  "core.ignorecase", "core.precomposeunicode", "core.abbrev", "core.whitespace",
  "init.defaultbranch", "pull.rebase", "pull.ff", "push.default", "push.autosetupremote",
  "fetch.prune", "merge.ff", "merge.conflictstyle", "rebase.autostash", "rebase.autosquash",
  "diff.algorithm", "diff.renames", "status.short", "status.branch", "color.ui",
]);
// Common aliases with flags (e.g. "log --oneline --graph"). Shell aliases and
// arbitrary arguments can carry credentials, a config override, or a host file.
const simpleAlias = /^(?:add|blame|branch|checkout|cherry-pick|commit|diff|fetch|log|merge|pull|push|rebase|reset|restore|revert|show|stash|status|switch|tag)(?: +--?[a-zA-Z0-9-]+)*$/;
// Keep ordinary URL shortcuts, including "example:", with no userinfo, query or fragment.
const publicUrl = /^(?:https?|git|ssh):\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._~/-]*)?$/i;

export function sandboxGitConfig(path: string): Buffer {
  const input = readSandboxConfig(path);
  if (!input.length || input.includes(0)) return Buffer.alloc(0);
  // Let Git handle quoting, comments, mixed case and continued lines. Never
  // ask the host to follow includes supplied by an account.
  const parsed = spawnSync("git", ["config", "--file", "-", "--no-includes", "--null", "--list"], {
    input, cwd: "/", env: { PATH: process.env.PATH }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5000,
  });
  if (parsed.status !== 0) return Buffer.alloc(0);
  const lines: string[] = [];
  for (const entry of parsed.stdout.split("\0")) {
    if (!entry) continue;
    const split = entry.indexOf("\n");
    const key = split < 0 ? entry : entry.slice(0, split);
    const value = split < 0 ? "true" : entry.slice(split + 1);
    if (/[\x00-\x1f\x7f]/.test(value)) continue;
    let section = key.slice(0, key.indexOf("."));
    const name = key.slice(key.lastIndexOf(".") + 1);
    if (section === "url" && (name === "insteadof" || name === "pushinsteadof")) {
      const base = key.slice(4, key.lastIndexOf("."));
      if (!publicUrl.test(base) || !(publicUrl.test(value) || /^[a-z][a-z0-9-]*:$/i.test(value))) continue;
      section = `url "${base}"`;
    } else if (!preferences.has(key) && !(/^alias\.[a-z][a-z0-9-]*$/.test(key) && simpleAlias.test(value))) continue;
    const quoted = value.replace(/[\\"]/g, "\\$&");
    lines.push(`[${section}]\n\t${name} = "${quoted}"\n`);
  }
  return Buffer.from(lines.join(""));
}
