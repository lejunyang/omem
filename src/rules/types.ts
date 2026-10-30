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
  "meeting.title": "会议标题",
  "meeting.no": "会议号（9 位）",
  "meeting.participants": "参会人（名字：你入会时和之后十分钟内在会里的人）",
  "meeting.participantCount": "在会人数（入会时和之后十分钟内，不算机器人）",
  "meeting.invitedCount": "会邀人数（日程邀请的人，群按成员算，不算会议室和拒绝的）",
  "meeting.host": "主持人",
} as const;
export type Field = keyof typeof FIELDS;
/** Which fields each trigger has: a meeting has no chat or message, a message no meeting. */
export const EVENT_FIELDS: Record<"message" | "meeting", Field[]> = {
  message: (Object.keys(FIELDS) as Field[]).filter((f) => !f.startsWith("meeting.")),
  meeting: (Object.keys(FIELDS) as Field[]).filter((f) => f.startsWith("meeting.")),
};
export const OPS = ["equals", "contains", "startsWith", "endsWith", "matches", "in", "is", "gte", "lte"] as const;
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

function isMeetingCondition(c: Condition): boolean {
  if ("field" in c) return c.field.startsWith("meeting.");
  if ("not" in c) return isMeetingCondition(c.not);
  const parts = "all" in c ? c.all : c.any;
  return parts.length > 0 && parts.every(isMeetingCondition);
}

const reply = z.enum(["none", "draft", "auto"]);
/**
 * How a rule's agent may speak. none: its conclusion goes to the owner only. draft: what it says in
 * the chat is a draft the owner confirms. auto: it answers in the chat (its topic), process visible.
 * silent: it reads the discussion and investigates without showing anything; it posts only when it
 * decides to (a conclusion, a question for missing information) and then follows that topic.
 */
export const agentReply = z.enum(["none", "draft", "auto", "silent"]);
export const actionSchema = z.discriminatedUnion("type", [
  /**
   * allowUrgent / allowPrivate: what its messages in the chat may do beyond posting — buzz people
   * (urgent, in-app) and messages only some members see. Off unless the rule says so; when to use
   * them is the rule's own words (description, task).
   */
  z.object({
    type: z.literal("agent"),
    spec: z.string().default("assistant"),
    space: z.string().transform(v => v || undefined).optional(),
    task: z.string().default(""),
    ownTopic: z.boolean().default(false),
    reply: agentReply.default("none"),
    allowUrgent: z.boolean().optional(),
    allowPrivate: z.boolean().optional(),
    /** The owner's pick of AI for this rule's runs (backend id, optional model and effort); without it the profile's own. */
    ai: z
      .object({ profile: z.string().trim().min(1), model: z.string().trim().optional(), effort: z.string().trim().optional() })
      .transform((v) => ({ profile: v.profile, ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}) }))
      .optional(),
  }),
  z.object({ type: z.literal("watch"), spec: z.string(), on: z.enum(["all", "mention", "keyword"]).default("mention"), pattern: z.string().optional(), reply: reply.default("draft") }),
  z.object({ type: z.literal("invite-bot") }),
  z.object({ type: z.literal("capture") }),
  z.object({ type: z.literal("notify"), urgent: z.boolean().default(false) }),
  /**
   * The owner joined a meeting (trigger `meeting`): bring omem's bots in (`bots`: "main" or ids of
   * lark.bots; empty = none, listening as the owner only), after asking the owner on a card unless
   * `confirm` is off, or a meeting condition decides when to ask. `record` keeps the meeting
   * (transcript, chat, who came and went) as a source;
   * `spec` listens along and tells the owner when they are needed; `answer` lets it answer questions
   * put to a bot in the meeting chat; `importShared` imports documents shared on screen;
   * `leaveWithOwner` takes the bots out when the owner leaves. See src/channels/lark-meetings.ts.
   */
  z.object({
    type: z.literal("meeting-bot"),
    bots: z.array(z.string()).max(8).default(["main"]),
    confirm: z.union([z.boolean(), conditionSchema.refine(isMeetingCondition, "确认条件至少写一项，且只能用会议字段")]).default(true),
    record: z.boolean().default(true),
    spec: z.string().default(""),
    space: z.string().transform(v => v || undefined).optional(),
    task: z.string().default(""),
    answer: z.boolean().default(false),
    importShared: z.boolean().default(true),
    leaveWithOwner: z.boolean().default(true),
  }),
  /** Only in temporary rules an agent sets (agents/wakes.ts): wake a conversation's agent or a profile. */
  z.object({ type: z.literal("wake"), note: z.string(), target: z.object({ conversationId: z.string().optional(), spec: z.string().optional(), resumeRunId: z.string().optional() }) }),
]);
export type RuleAction = z.infer<typeof actionSchema>;

export const ruleInputSchema = z.object({
  spaceId: z.string().transform(v => v || undefined).optional(),
  conversationId: z.string().transform(v => v || undefined).optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(false),
  trigger: z.object({
    event: z.enum(["message", "chat-new", "schedule", "meeting"]).default("message"),
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
/** A rule an agent set to be woken by an event: gone after it fires once (when `once`) or expires. */
export type Temporary = { expiresAt: string; once: boolean; setBy: { runId: string | null; agent: string }; setAt: string; watch: string };
export type Rule = z.infer<typeof ruleInputSchema> & { id: string; createdAt: string; updatedAt: string; createdBy: string; hits: number; lastFiredAt: string | null; temporary: Temporary | null };

/** What a rule sees of one event. Only filled what the source knows; `chat.bots` is read on demand. */
export type RuleEvent = {
  /** Dedupe key: one message (or chat, or schedule tick) is handled once per rule. */
  key: string;
  kind: "message" | "chat-new" | "schedule" | "meeting";
  at: string;
  chat?: { id: string; name: string; kind: "group" | "p2p" };
  sender?: { id?: string; name: string; email?: string | null; kind: "owner" | "user" | "bot" };
  message?: { id: string; text: string; type: string; mentionsOwner: boolean; mentionsBot: boolean; topicId?: string | null; cardTitle?: string | null };
  /** The meeting the owner joined. participantCount: null = unknown; omitted = count participants. invitedCount: null or omitted = unknown. */
  meeting?: { id: string; no?: string; title: string; participants: string[]; participantCount?: number | null; invitedCount?: number | null; host?: string; calendarEventId?: string };
  /** Where it came from: the bot sees groups it is in in real time; the owner's capture sees every chat. */
  via: "bot" | "capture" | "schedule" | "test" | "meeting";
  /** The Feishu bot that saw it (via bot): "main" or one of lark.bots; its agent answers through it. */
  bot?: string;
};
