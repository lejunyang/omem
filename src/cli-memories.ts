import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { App } from "./core/app.ts";
import { ensurePersonalSpace } from "./core/spaces.ts";
import { listMemories, retract } from "./memory/store.ts";
import { checkMemory, memoryQualityStats, recentRejections } from "./memory/quality.ts";
import { omemHome } from "./core/config.ts";

/**
 * Memory maintenance. The same write-time checks the tools apply (src/memory/quality.ts)
 * can be run over what is already stored; the hourly memory-review run handles the rest.
 */
export const memoriesCommand = new Command("memories").description("查看、检查和清理记忆").option("--home <dir>", "数据目录（默认 ~/.omem）");

const checkStored = (app: App) =>
  listMemories(app, { status: "active", limit: 100_000 })
    .filter((m) => m.createdBy === "agent")
    .map((m) => ({ m, problems: checkMemory(app, { spaceId: m.spaceId, kind: m.kind, content: m.content, subject: m.subject, sourceRefs: m.sourceRefs, replacing: m.id }) }));

memoriesCommand
  .command("stats")
  .description("记忆数量、检查结果，以及按模型统计的写入/拒绝/复核情况")
  .option("--days <n>", "统计最近几天", "30")
  .action((o) => {
    const app = openApp();
    const all = listMemories(app, { status: "all", limit: 100_000 });
    const active = all.filter((m) => m.status === "active");
    const failing = checkStored(app).filter((x) => x.problems.length);
    const pending = active.filter((m) => m.createdBy === "agent" && !m.reviewedAt).length;
    console.log(`共 ${all.length} 条；有效 ${active.length}；已替代/撤回 ${all.length - active.length}；待复核 ${pending}`);
    console.log(`有效记忆中不符合写入检查的：${failing.length} 条（memories check 查看，memories prune 撤回）`);
    const stats = memoryQualityStats(app, Number(o.days));
    if (stats.length) {
      console.log(`\n最近 ${o.days} 天，按模型：`);
      for (const s of stats)
        console.log(
          `- ${s.model}：写入 ${s.stored}${s.shadow ? `，对比提案 ${s.shadow}` : ""}，检查拒绝 ${s.rejected}${Object.keys(s.rejectedBy).length ? `（${Object.entries(s.rejectedBy).map(([k, v]) => `${k} ${v}`).join("，")}）` : ""}，复核 ${s.reviewed}（保留 ${s.kept} / 改写 ${s.rewritten} / 撤回 ${s.retracted}），平均 ${s.avgChars} 字`,
        );
    }
  });

memoriesCommand
  .command("check")
  .description("用写入检查过一遍现有的 Agent 记忆，列出不合格的")
  .action(() => {
    const app = openApp();
    const rows = checkStored(app).filter((x) => x.problems.length);
    for (const { m, problems } of rows) console.log(`${m.id} [${problems.map((p) => p.code).join(",")}] ${m.content.slice(0, 100).replace(/\n/g, " ")}`);
    console.log(`共 ${rows.length} 条`);
  });

memoriesCommand
  .command("prune")
  .description("撤回不符合写入检查的 Agent 记忆（保留撤回记录）；默认只撤回免责式，--all 撤回全部不合格的")
  .option("--dry-run", "只列出将撤回的记忆，不撤回")
  .option("--all", "所有检查项（太长、转述原件、事件复述、助理汇报…），不只是免责式")
  .action((o) => {
    const app = openApp();
    const rows = checkStored(app).filter((x) => x.problems.some((p) => o.all || p.code === "hedge"));
    for (const { m, problems } of rows) {
      console.log(`${o.dryRun ? "[将撤回]" : "[撤回]"} ${m.id} [${problems.map((p) => p.code).join(",")}] ${m.content.slice(0, 80).replace(/\n/g, " ")}`);
      if (!o.dryRun) retract(app, m.id, `不符合记忆写入检查：${problems.map((p) => p.code).join(",")}`);
    }
    console.log(o.dryRun ? `共 ${rows.length} 条（dry-run，未改动）` : `已撤回 ${rows.length} 条`);
  });

memoriesCommand
  .command("rejections")
  .description("最近被写入检查拒绝的记忆（含对比运行）")
  .option("--limit <n>", "条数", "30")
  .action((o) => {
    const app = openApp();
    for (const r of recentRejections(app, Number(o.limit)))
      console.log(`${r.at.slice(0, 16)} ${r.shadow ? "[对比] " : ""}${[r.agent_profile, r.model].filter(Boolean).join(" · ") || "?"} [${r.codes.join(",")}] ${r.content.slice(0, 90).replace(/\n/g, " ")}`);
  });

function openApp() {
  const dir = (memoriesCommand.opts().home as string | undefined) ?? omemHome();
  if (!existsSync(resolve(dir))) throw new Error(`数据目录不存在：${dir}`);
  const app = App.open(dir);
  ensurePersonalSpace(app);
  return app;
}
