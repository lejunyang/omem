import { z } from "zod";

/**
 * Rules: "when this happens, have this done". See docs/v2/rules.md.
 *
 * Conditions are a small JSON language the host evaluates itself — what a rule "compiled to
 * code" means here. The model may write them from the owner's words; it never writes a program
 * the host runs.
 */

export const FIELDS = {
  "chat.id": "群 / 会话 id",
  "chat.name": "群名",
  "chat.kind": "会话类型（group / p2p）",
  "chat.bots": "群里的机器人（名字）",
  "chat.hasOwnBot": "群里有 omem 自己的机器人（按应用 id 判断，不看名字）",
  "sender.name": "发送人",
  "sender.email": "发送人邮箱",
  "sender.kind": "发送人类型（owner / user / bot）",
  "message.text": "消息内容",
  "message.type": "消息类型（text / post / interactive 卡片 / image / file…）",
  "message.mentionsOwner": "@ 了本人",
  "message.mentionsBot": "@ 了 omem 机器人",
  "message.inTopic": "在话题里",
  "message.cardTitle": "卡片标题",
} as const;
export type Field = keyof typeof FIELDS;
export const OPS = ["equals", "contains", "startsWith", "endsWith", "matches", "in", "is"] as const;
export type Op = (typeof OPS)[number];

export type Leaf = { field: Field; op: Op; value: string | boolean | string[] };
export type Condition = Leaf | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const leafSchema = z.object({
  field: z.enum(Object.keys(FIELDS) as [Field, ...Field[]]),
  op: z.enum(OPS),
  value: z.union([z.string(), z.boolean(), z.array(z.string())]),
});
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([leafSchema, z.object({ all: z.array(conditionSchema) }), z.object({ any: z.array(conditionSchema) }), z.object({ not: conditionSchema })]),
);

const reply = z.enum(["none", "draft", "auto"]);
/**
 * How a rule's agent may speak. none: its conclusion goes to the owner only. draft: what it says in
 * the chat is a draft the owner confirms. auto: it answers in the chat (its topic), process visible.
 * silent: it reads the discussion and investigates without showing anything; it posts only when it
 * decides to (a conclusion, a question for missing information) and then follows that topic.
 */
export const agentReply = z.enum(["none", "draft", "auto", "silent"]);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), spec: z.string(), task: z.string().default(""), ownTopic: z.boolean().default(false), reply: agentReply.default("none") }),
  z.object({ type: z.literal("watch"), spec: z.string(), on: z.enum(["all", "mention", "keyword"]).default("mention"), pattern: z.string().optional(), reply: reply.default("draft") }),
  z.object({ type: z.literal("invite-bot") }),
  z.object({ type: z.literal("capture") }),
  z.object({ type: z.literal("notify"), urgent: z.boolean().default(false) }),
]);
export type RuleAction = z.infer<typeof actionSchema>;

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(false),
  trigger: z.object({
    event: z.enum(["message", "chat-new", "schedule"]).default("message"),
    once: z.enum(["event", "chat"]).default("event"),
    cron: z.string().optional(),
    /** Wait this long after a match before acting (no one responded in time → act). */
    waitMinutes: z.number().int().min(0).max(1440).default(0),
    /**
     * Checked when it is time to act: owner-engaged — the owner is already in this discussion (spoke
     * in the topic, or in the chat around it); answered — someone already replied. Either skips.
     */
    unless: z.array(z.enum(["owner-engaged", "answered"])).default([]),
  }).default({ event: "message", once: "event", waitMinutes: 0, unless: [] }),
  conditions: conditionSchema.nullable().default(null),
  judge: z.enum(["code", "ai", "code+ai"]).default("code"),
  actions: z.array(actionSchema).min(1).max(8),
});
export type RuleInput = z.input<typeof ruleInputSchema>;
export type Rule = z.infer<typeof ruleInputSchema> & { id: string; createdAt: string; updatedAt: string; createdBy: string; hits: number; lastFiredAt: string | null };

/** What a rule sees of one event. Only filled what the source knows; `chat.bots` is read on demand. */
export type RuleEvent = {
  /** Dedupe key: one message (or chat, or schedule tick) is handled once per rule. */
  key: string;
  kind: "message" | "chat-new" | "schedule";
  at: string;
  chat?: { id: string; name: string; kind: "group" | "p2p" };
  sender?: { id?: string; name: string; email?: string | null; kind: "owner" | "user" | "bot" };
  message?: { id: string; text: string; type: string; mentionsOwner: boolean; mentionsBot: boolean; topicId?: string | null; cardTitle?: string | null };
  /** Where it came from: the bot sees groups it is in in real time; the owner's capture sees every chat. */
  via: "bot" | "capture" | "schedule" | "test";
};
