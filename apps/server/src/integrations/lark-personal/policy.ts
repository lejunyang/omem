import { z } from "zod";
import {
  intakeQuestions,
  passageQuestions,
  type ChoiceQuestion,
} from "../../decision/questions.js";
export const personalLarkSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().int().min(1).max(1440).default(5),
    historyHours: z.number().int().min(1).max(168).default(24),
    mentionExceptions: z.boolean().default(true),
    resources: z.boolean().default(true),
  })
  .strict();
export const messageQuestions: Record<string, ChoiceQuestion> = {
  ...intakeQuestions,
  attention: {
    type: "choice",
    instructions:
      "结合当前用户身份、群聊上下文和已有事项，判断这条消息为什么需要用户关注。被@不等于被交办；其他人的承诺不自动成为用户的待办。",
    criteria: {
      action: "明确请求当前用户行动，或当前用户本人作了承诺",
      waiting: "与正在等待的回复或阻塞进展有关",
      change: "与用户有关的项目规则、需求、安排发生变化",
      information: "值得保留的背景信息，没有立即行动",
      noise: "闲聊、重复或与用户无关的广播",
      uncertain: "缺少对象、上下文或附件，暂不能判断",
    },
  },
  context: {
    type: "choice",
    instructions:
      "仅凭所给正文与已读取资源能否理解消息？图片占位、未读取文档或附件不能当作已读。",
    criteria: {
      ready: "已有足够上下文",
      resources: "需要读取图片、文档或附件",
      discussion: "需要前后讨论或引用消息",
      uncertain: "无法判断",
    },
  },
  injection: passageQuestions.injection!,
};
export const attentionLabels: Record<string, string> = {
  action: "可能需要你行动",
  waiting: "等待事项有进展",
  change: "与你有关的变化",
  information: "参考信息",
  noise: "低优先级",
  uncertain: "需要补充背景",
};
