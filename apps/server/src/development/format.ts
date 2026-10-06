import type { DevelopmentRun } from "./runner.js";
const states: Record<DevelopmentRun["state"], string> = {
  created: "待开始",
  coding: "编码中",
  checking: "检查中",
  reviewing: "独立评审中",
  ready: "检查和评审通过，待应用",
  blocked: "需要处理问题",
  interrupted: "已中断，可继续",
  failed: "执行失败",
  applied: "已应用到原工作区，尚未提交",
};
export function formatDevelopmentRun(run: DevelopmentRun) {
  const checks = Object.values(
    Object.fromEntries(run.checks.map((c) => [c.name, c])),
  );
  return [
    `${run.project.name} · ${states[run.state]}`,
    `任务：${run.id}`,
    `需求：${run.requirementKey}`,
    `当前轮次：${run.attempt}`,
    ...(run.changePlan
      ? [
          `本轮调整：${run.changePlan.summary}`,
          ...run.changePlan.questions.map((q) => `待确认：${q}`),
        ]
      : []),
    ...(run.error ? [`需要处理：${run.error}`] : []),
    ...(checks.length
      ? [
          "检查：",
          ...checks.map(
            (c) =>
              `  ${c.name}：${c.exitCode === 0 ? "通过" : `失败（退出 ${c.exitCode}）`}`,
          ),
        ]
      : []),
    ...(run.review
      ? [
          `评审：${run.review.summary}`,
          ...run.review.findings.map(
            (f) =>
              `  ${f.priority} ${f.path}${f.line ? `:${f.line}` : ""}：${f.issue}\n    建议：${f.change}`,
          ),
        ]
      : []),
    `工作副本：${run.checkout}`,
    `完整记录：${run.directory}/run.json`,
    run.state === "ready"
      ? `下一步：omem develop diff ${run.id}；omem develop apply ${run.id}`
      : ["failed", "blocked", "interrupted"].includes(run.state)
        ? `处理问题后：omem develop resume ${run.id}`
        : run.state === "applied"
          ? "下一步：在原仓库检查改动，再按项目规则提交。"
          : "",
  ]
    .filter(Boolean)
    .join("\n");
}
