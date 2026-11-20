import { z } from "zod";

/** What the tools of work lines take (items/lines.ts); kept apart so agents/tools.ts reads them without loading the lines module. */
export const NEXT_KINDS = ["read", "test", "code", "ask", "data"] as const;

/** `submit_line_state`: where a line stands as of today, and at most three next steps. */
export const lineStateSchema = z.object({
  now: z.string().trim().min(1).max(120).describe("一句“截至今天……”：这条线到哪了、卡在哪，120 字以内"),
  people: z.array(z.object({
    name: z.string().trim().min(1).max(40),
    open_id: z.string().trim().max(80).optional().describe("飞书 open_id（材料里有就填）"),
    role: z.string().trim().min(1).max(40).describe("在这条线上做什么：负责后端、提需求、测试、评审……"),
  })).max(8).default([]),
  weeks: z.array(z.object({
    label: z.string().trim().min(1).max(20).describe("本周·至今N天 / 上周 / 2周前 / 3周前"),
    text: z.string().trim().min(1).max(200).describe("这一周一句话；没动就写“暂无进展”"),
  })).max(4).default([]),
  next: z.array(z.object({
    text: z.string().trim().min(1).max(200).describe("具体要做的一步"),
    why: z.string().trim().max(400).default("").describe("为什么现在做它"),
    refs: z.array(z.string().trim().max(200)).max(10).default([]).describe("依据：src:…#L…、mem:…、事项 id、阶段、指标名"),
    kind: z.enum(NEXT_KINDS).describe("read 读材料理清 / test 写或跑测试 / code 改代码 / ask 去问人 / data 看数据"),
  })).max(3).default([]),
  phase: z.object({
    state: z.enum(["active", "watching", "done", "cancelled"]).describe("active 还在做 / watching 做完了、上线后还要看一阵 / done 确实结束了 / cancelled 不做了"),
    reason: z.string().trim().min(1).max(300).describe("依据的一句话：需求已全量、流程走完、工作项都结了、本人说做完了……"),
    refs: z.array(z.string().trim().max(200)).max(10).default([]).describe("依据：src:…#L…、mem:…、事项 id、阶段"),
    confidence: z.number().min(0).max(1).describe("把握，0 到 1"),
    days: z.number().int().min(1).max(365).optional().describe("watching 时建议观察几天（宿主最多按 60 天算）"),
  }).optional().describe("这条线到了哪一段（没把握就不填）：宿主按把握决定进入观察、结束，拿不准的问本人一次"),
  summary: z.string().trim().min(1).max(4000).optional().describe("只在给结束的线写收尾时填：做成了什么、关键决定、上线后数字怎么样、还剩什么"),
});

/** `propose_lines`: the lines the nightly work-state sees the owner pushing on. */
export const proposeSchema = z.object({
  lines: z.array(z.object({
    name: z.string().trim().min(1).max(60).describe("线的名字：本人要达成的一件事（“退款改造上线”），不是群名或文档名"),
    goal: z.string().trim().max(400).default("").describe("目标：做成什么样算完，带截止时间（有就写）"),
    items: z.array(z.string().trim()).max(30).default([]).describe("属于这条线的事项 id"),
    chats: z.array(z.string().trim()).max(20).default([]).describe("在聊这件事的群：chat_id（oc_…）或群聊原件 src:…"),
    sources: z.array(z.string().trim()).max(30).default([]).describe("相关的文档、会话原件：src:…"),
  })).min(1).max(8),
});
