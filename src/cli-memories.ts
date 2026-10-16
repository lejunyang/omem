import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { App } from "./core/app.ts";
import { ensurePersonalSpace } from "./core/spaces.ts";
import { listMemories, retract, type Memory } from "./memory/store.ts";
import { omemHome } from "./core/config.ts";

/**
 * Memory maintenance commands. The pruning heuristic deliberately only targets
 * memories whose main content is hedging/disclaimers — facts with one boundary
 * clause are kept and shown with --review.
 */
export const memoriesCommand = new Command("memories")
  .description("查看和清理记忆")
  .option("--home <dir>", "数据目录（默认 ~/.omem）")
  .option("--dry-run", "只列出将清理的记忆，不撤回");

memoriesCommand
  .command("stats")
  .description("记忆数量与可疑防御式内容统计")
  .action(() => {
    const app = openApp();
    const all = listMemories(app, { status: "all" });
    const active = all.filter((m) => m.status === "active");
    const junk = active.filter(isHedgingMemory);
    console.log(`共 ${all.length} 条；有效 ${active.length}；已替代/撤回 ${all.length - active.length}`);
    console.log(`建议清理（主体是免责而非结论）：${junk.length} 条；用 memories prune --dry-run 查看`);
  });

memoriesCommand
  .command("prune")
  .description("撤回防御式、无确定结论的记忆（保留撤回记录）")
  .option("--dry-run", "只列出将撤回的记忆，不撤回")
  .option("--reason <text>", "撤回原因", "无确定结论的防御式记忆，按新记忆规范清理")
  .action((o) => {
    const app = openApp();
    const junk = listMemories(app, { status: "active" }).filter(isHedgingMemory);
    for (const m of junk) {
      console.log(`${o.dryRun ? "[将撤回]" : "[撤回]"} ${m.id} ${m.kind} ${m.content.slice(0, 80).replace(/\n/g, " ")}`);
      if (!o.dryRun) retract(app, m.id, o.reason);
    }
    console.log(o.dryRun ? `共 ${junk.length} 条（dry-run，未改动）` : `已撤回 ${junk.length} 条`);
  });

memoriesCommand
  .command("review")
  .description("列出含免责措辞但仍有实质结论、建议人工判断的记忆")
  .action(() => {
    const app = openApp();
    const rows = listMemories(app, { status: "active" }).filter((m) => HEDGE_RE.test(m.content) && !isHedgingMemory(m));
    for (const m of rows) console.log(`${m.id} ${m.kind} ${m.content.slice(0, 120).replace(/\n/g, " ")}`);
    console.log(`共 ${rows.length} 条`);
  });

const HEDGE_RE = /不能(证明|当作|视为|推广|据此|把)|无法(确认|证实|核实)|未见(最终|合并|发版|人工|实际|完成|授权|恢复|修复)?回执|材料未见|尚待确认|未提供.*回执|不能确认/;

/** A memory is "hedging junk" when disclaimer clauses dominate and it carries no usable conclusion. */
function isHedgingMemory(m: Memory): boolean {
  const c = m.content;
  const clauses = (c.match(new RegExp(HEDGE_RE, "g")) ?? []).length;
  if (clauses === 0) return false;
  // Long, hedge-dense entries are almost always a rewritten case summary, not a memory.
  const chars = c.length;
  if (clauses >= 2 && chars > 180) return true;
  if (clauses >= 3) return true;
  // The conclusion itself is the disclaimer ("X 不能证明 Y"), not just a trailing caveat.
  const main = c.split(/[。；]/).filter(Boolean).slice(0, 2).join("。");
  if (HEDGE_RE.test(main) && /不能(证明|当作|视为)|无法(确认|证实)/.test(main) && chars > 90) return true;
  return false;
}

function openApp() {
  const dir = (memoriesCommand.opts().home as string | undefined) ?? omemHome();
  if (!existsSync(resolve(dir))) throw new Error(`数据目录不存在：${dir}`);
  const app = App.open(dir);
  ensurePersonalSpace(app);
  return app;
}
