export const decisionModelSizes = ["0.8b", "2b", "4b", "9b"] as const;
export type DecisionModelSize = (typeof decisionModelSizes)[number];
export const automaticDecisionSizes = ["0.8b", "2b", "4b"] as const;
export const decisionModelAlias = (size: DecisionModelSize) =>
  size === "0.8b" ? "decision-startlux08" as const : `decision-startlux${size}` as const;
