/**
 * An SSH origin's https address (git@host:owner/repo.git → https://host/owner/repo.git), or null. A
 * service started by a process manager can lack what ssh needs (no passwd entry for its uid, no agent),
 * while a public repository reads fine over https (scripts/upgrade.ts falls back to it).
 */
export function httpsOf(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url.trim());
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url.trim());
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : null;
}
