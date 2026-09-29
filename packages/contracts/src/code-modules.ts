/** Shared repository-path grouping for the Wiki index and Vue reader. */
export function moduleForPath(path: string): string {
  if (path.startsWith("apps/web/")) return "web";
  if (path.startsWith("packages/ui/")) return "ui";
  if (path.startsWith("packages/contracts/")) return "contracts";
  if (path.startsWith("packages/agent-runtime/")) return "agent-runtime";
  if (path.startsWith("apps/server/src/integrations/lark/")) return "lark";
  if (path.startsWith("apps/server/src/")) {
    const parts = path.split("/");
    if (parts.length <= 4) return "server-root";
    return parts[3] ?? "server-root";
  }
  if (path.startsWith("scripts/")) return "scripts";
  return "other";
}
