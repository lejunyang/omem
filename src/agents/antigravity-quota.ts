import type { AgentProfile } from "../core/config.ts";
import type { QuotaWindow } from "./quota.ts";
import { accountOf } from "./sandbox.ts";
import { launch, stop } from "./spawn.ts";

type UsageBucket = { name?: string; window?: string; remaining_fraction?: number; reset_time?: string };
type UsageGroup = { name?: string; description?: string; buckets?: UsageBucket[] };
type UsageResult = { status?: string; command?: { name?: string; data?: { groups?: UsageGroup[] } } };

const modelSlug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The CLI handles /usage itself: no model turn. Only structured, successful quota results count. */
export function parseAntigravityUsage(text: string): { windows: QuotaWindow[] } {
  const r = JSON.parse(text) as UsageResult;
  if (r?.status !== "SUCCESS" || r.command?.name !== "usage" || !Array.isArray(r.command.data?.groups))
    throw new Error("Antigravity CLI 没有返回结构化 /usage 额度，请检查登录或升级 CLI");
  const windows: QuotaWindow[] = [];
  for (const g of r.command.data.groups) {
    if (!g || typeof g.name !== "string" || !g.name.trim() || !Array.isArray(g.buckets)) continue;
    // Use the names the CLI advertises, not a fixed list of models. Unknown group scope is display-only.
    const list = typeof g.description === "string" ? /^Models within this group:\s*(.+)$/i.exec(g.description)?.[1] : undefined;
    const models = list ? list.split(",").map(modelSlug).filter(Boolean)
      : /\d/.test(g.name) ? [modelSlug(g.name)] : [];
    for (const b of g.buckets) {
      if (!b || typeof b.remaining_fraction !== "number" || !Number.isFinite(b.remaining_fraction)
        || b.remaining_fraction < 0 || b.remaining_fraction > 1) continue;
      const mins = b.window === "weekly" ? 10080 : b.window === "5h" ? 300 : undefined;
      windows.push({
        name: `${g.name} · ${mins === 10080 ? "7d" : mins === 300 ? "5h" : b.name || b.window || "额度"}`,
        usedPercent: (1 - b.remaining_fraction) * 100,
        models,
        ...(mins && { windowMinutes: mins }),
        ...(typeof b.reset_time === "string" && Number.isFinite(Date.parse(b.reset_time)) && { resetsAt: new Date(b.reset_time).toISOString() }),
      });
    }
  }
  if (!windows.length) throw new Error("Antigravity CLI 没有报可用的套餐额度");
  return { windows };
}

export async function readAntigravityQuota(p: AgentProfile, signal?: AbortSignal): Promise<{ plan?: string; windows: QuotaWindow[] }> {
  signal?.throwIfAborted();
  const account = accountOf(p);
  const child = launch(p.command, ["-p", "/usage", "--output-format", "json"], {
    cwd: account?.home ?? process.cwd(), env: p.env, sandbox: account,
  });
  child.stdin.end();
  try {
    return await new Promise((resolve, reject) => {
      let out = "";
      const abort = () => { stop(child); reject(new Error("读取 Antigravity 额度已取消")); };
      const timer = setTimeout(() => { stop(child); reject(new Error("Antigravity /usage 没有及时回答")); }, 60_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (data: Buffer) => {
        out += data.toString();
        if (out.length > 1024 * 1024) { stop(child); reject(new Error("Antigravity /usage 输出过大")); }
      });
      // Drain diagnostics without storing account details in quota errors.
      child.stderr.resume();
      child.once("error", err => { cleanup(); reject(err); });
      child.once("close", code => {
        cleanup();
        if (code !== 0) return reject(new Error(`Antigravity /usage 退出（${code}），请检查 CLI 登录`));
        try { resolve(parseAntigravityUsage(out)); } catch (err) { reject(err); }
      });
    });
  } finally {
    stop(child);
  }
}
