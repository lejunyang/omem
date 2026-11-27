/** 场景定义同时供配置、设置页和报告使用。门槛只限制 risky，其他答案照常执行。 */
export const DECISION_SCENES = {
  route: { label: "AI 组选型", risky: "decision", cautious: "static", default: 0.55, help: "首选组达到门槛并领先第二名至少 0.15 时采用模型排序，否则按规则里的组顺序。" },
  heartbeat: { label: "巡检预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握不用看，才跳过助手巡检。" },
  watch: { label: "盯群预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握不用看，才跳过这一批群聊。" },
  follow: { label: "事项上下文预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握无关，才跳过这件事的新内容。" },
  "item-place": { label: "事项会话关联", risky: "yes", cautious: "no", default: 0.8, help: "有这么大把握会话正在讨论这件事，才加入事项材料。" },
  meeting: { label: "旁听预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握这一段会上说的和你无关，才不让旁听的 Agent 看（攒到下一段再判断）。" },
  triage: { label: "有人找你", risky: "ignore", cautious: "notify", default: 0.6, help: "有这么大把握不用管，才不提醒你。" },
  progress: { label: "直接答复", risky: "yes", cautious: "no", default: 0.7, help: "有这么大把握不用你拍板，才允许直接答复。" },
  item: { label: "自动建事项", risky: "keep", cautious: "candidate", default: 0.6, help: "后台想替你建事项时，有这么大把握你会要，才直接建；不到就先放进候选，等你每天看一眼。" },
  firstlook: { label: "帮你回复的结论", risky: "yes", cautious: "no", default: 0.7, help: "快模型说已经答完时，有这么大把握它答够了，才不起深度运行。" },
  "notify-known": { label: "本人已经知道", risky: "yes", cautious: "no", default: 0.8, help: "有这么大把握你已知道结论且无需你采取新行动，才略过后台通知的飞书推送。" },
  "flow-blocker": { label: "流程卡点复核", risky: "yes", cautious: "no", default: 0.7, help: "有这么大把握新情况可能改变卡点，才排一次专门的对账。" },
} as const;
export type DecisionScene = keyof typeof DECISION_SCENES;
export const decisionThresholdDefaults = () => Object.fromEntries(Object.entries(DECISION_SCENES).map(([k, v]) => [k, v.default])) as Record<DecisionScene, number>;

export type DecisionSceneReport = {
  scene: DecisionScene; label: string; risky: number; cautious: string; default: number; help: string;
  threshold: number; records: number; lowered: number; needed: number; unneeded: number; unclear: number;
  misses: number; wasted: number; labelledRiskyChoices: number; labelled: number; labelsEnabled: boolean;
  thresholds: { threshold: number; risky: number; labelled: number; misses: number }[];
  suggested: number | null; suggestion: string;
};
export type RouteResults = { completed: number; settled: number; pending: number };
export type RouteClassReport = { classId: string; name: string; decision: RouteResults; static: RouteResults };
export type DecisionReport = { days: number; scenes: DecisionSceneReport[]; routes: RouteClassReport[] };

export function completionRate({ completed, settled }: RouteResults) {
  return settled ? `${Math.round(100 * completed / settled)}%（${completed}/${settled}）` : "暂无已知结果";
}
