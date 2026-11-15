import { Command, InvalidArgumentError } from "commander";
import type { App } from "./core/app.ts";
import { DECISION_SCENES, decisionReport, decisionReportText, replayDecisions, type DecisionScene } from "./core/decision-log.ts";

const number = (max: number) => (text: string) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new InvalidArgumentError(`请输入 1–${max} 的整数`);
  return n;
};
export function decisionCommands(program: Command, open: () => App) {
  const decision = program.command("decision").description("决策记录：查看结果、校准门槛和离线比较模型");
  decision.command("report").description("查看各场景的决策统计，不修改设置")
    .option("--days <N>", "最近多少天（1–90）", number(90), 30)
    .action((opts) => console.log(decisionReportText(decisionReport(open(), opts))));
  decision.command("replay").description("用另一个模型重答历史记录，只读本地记录，不写回结果")
    .requiredOption("--scene <scene>", Object.keys(DECISION_SCENES).join(" | "), (value) => {
      if (!Object.hasOwn(DECISION_SCENES, value)) throw new InvalidArgumentError("未知决策场景");
      return value as DecisionScene;
    })
    .requiredOption("--model <provider:model>", "提供方 ID:模型")
    .option("--days <N>", "最近多少天（1–90）", number(90), 30)
    .option("--limit <N>", "最多多少条（1–200）", number(200), 200)
    .action(async (opts) => {
      const r = await replayDecisions(open(), opts);
      console.log(`场景 ${r.scene}，门槛 ${r.threshold}，比较 ${r.compared}/${r.selected} 条，选择一致 ${r.agreement}/${r.compared}，执行一致 ${r.takenAgreement}/${r.compared}`);
      console.log(`模型\t漏看\t多看\n原模型（${r.original.models.join("、")}）\t${r.original.misses}\t${r.original.wasted}\n候选（${r.candidate.model}）\t${r.candidate.misses}\t${r.candidate.wasted}`);
      console.log(`出错 ${r.errors} 次${r.stopped ? "，连续三次出错，已停止" : ""}；仅按已知结果比较，未改写记录或设置。`);
    });
}
