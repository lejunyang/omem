/** 场景定义同时供配置、设置页和报告使用。门槛只限制 risky，其他答案照常执行。 */
export const DECISION_SCENES = {
  heartbeat: { label: "巡检预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握不用看，才跳过助手巡检。" },
  watch: { label: "盯群预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握不用看，才跳过这一批群聊。" },
  follow: { label: "事项上下文预筛", risky: "no", cautious: "yes", default: 0.6, help: "有这么大把握无关，才跳过这件事的新内容。" },
  triage: { label: "有人找你", risky: "ignore", cautious: "notify", default: 0.6, help: "有这么大把握不用管，才不提醒你。" },
  progress: { label: "直接答复", risky: "yes", cautious: "no", default: 0.7, help: "有这么大把握不用你拍板，才允许直接答复。" },
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
export type DecisionReport = { days: number; scenes: DecisionSceneReport[] };
