import type {
  AssistantEvidence,
  AssistantModelPort,
  AssistantModelReply,
} from "./runtime.js";

/**
 * Deterministic stand-in for the real LLM composer. It performs no inference:
 * it surfaces the evidence the runtime already retrieved and cites fragments.
 *
 * This exists ONLY for tests. Production assembly must inject the real
 * `AcpAssistantModel`; when no model is configured the runtime degrades honestly
 * (`ModelUnavailableError`) instead of substituting this fake answer.
 */
export class DeterministicAssistantModel implements AssistantModelPort {
  async generate(input: {
    userText: string;
    priorTurns: { ordinal: number; userText: string; result: string }[];
    evidence: AssistantEvidence[];
    visibility: "private" | "group";
  }): Promise<AssistantModelReply> {
    const evidence = input.evidence.slice(0, 5);
    if (!evidence.length) {
      return {
        answer: `已收到：“${input.userText}”。当前已收录材料中没有直接相关内容。`,
        citationIds: [],
      };
    }
    const lines = evidence.map(
      (item, index) =>
        `${index + 1}. 【${item.revisionTitle}】${item.text.slice(0, 160)}`,
    );
    const previous = input.priorTurns.length
      ? `\n\n（这是第 ${input.priorTurns.length + 1} 轮，延续上一话题。）`
      : "";
    return {
      answer: `找到 ${evidence.length} 条相关材料：\n${lines.join("\n")}${previous}`,
      citationIds: evidence.map((item) => item.fragmentId),
    };
  }
}
