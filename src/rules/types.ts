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
  "doc.title": "文档标题",
  "doc.type": "文档类型（docx 文档 / sheet 电子表格 / bitable 多维表格）",
  "doc.url": "文档链接",
  "doc.location": "文档所在（知识库和目录，或云空间文件夹）",
  "doc.space": "文档存在 omem 的哪个空间（空间 id）",
  "change.kind": "变化类型（edit 内容编辑 / comment 评论 / record 多维表格记录 / field 多维表格字段）",
  "change.text": "变化的内容（新增和删掉的文字、评论、记录的前后值）",
  "change.added": "新增的文字（编辑时）",
  "change.editor": "修改人 / 评论人（名字）",
  "change.editorEmail": "修改人 / 评论人邮箱",
  "change.mentions": "这次变化里被 @ 的人（名字）",
  "change.mentionsOwner": "这次变化 @ 了本人",
  "change.mentionsBot": "这次变化 @ 了 omem 机器人",
} as const;
export type Field = keyof typeof FIELDS;
/** Which fields each trigger has: a meeting has no chat or message, a message no meeting, a document change neither. */
export const EVENT_FIELDS: Record<"message" | "meeting" | "doc", Field[]> = {
  message: (Object.keys(FIELDS) as Field[]).filter((f) => !/^(meeting|doc|change)\./.test(f)),
  meeting: (Object.keys(FIELDS) as Field[]).filter((f) => f.startsWith("meeting.")),
  doc: (Object.keys(FIELDS) as Field[]).filter((f) => /^(doc|change)\./.test(f)),
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
    hideThinking: z.boolean().optional(),
    failureTo: z.enum(["owner", "chat"]).optional(),
    allowUrgent: z.boolean().optional(),
    allowPrivate: z.boolean().optional(),
    /**
     * A trigger while this rule's run for the same chat is in progress joins that run instead of
     * starting another (an alert storm is one investigation): on unless false (rules/actions.ts).
     */
    merge: z.boolean().optional(),
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
  /** The actions after this one run this many minutes later (rules/actions.ts continueActions). */
  z.object({ type: z.literal("delay"), minutes: z.number().int().min(1).max(7 * 1440) }),
  /**
   * The model looks at the event (and what the earlier actions did) and answers `question` yes or no;
   * on no, the actions after it do not run. A gate in the middle of a rule, where conditions cannot say it.
   */
  z.object({ type: z.literal("check"), question: z.string().trim().min(1).max(2000) }),
  /**
   * A script the owner wrote, run on this machine (rules/script.ts) with the event as JSON (stdin and
   * OMEM_EVENT), never pasted into the code. `approval` asks someone on a card first: the owner, a
   * named person (name, email or user id), or one the model picks from the event by `hint`
   * (“文档的所有者”). Only the owner can save a rule with a script.
   */
  z.object({
    type: z.literal("script"),
    runtime: z.enum(["node", "python", "bash"]),
    code: z.string().min(1).max(100_000),
    timeoutSec: z.number().int().min(1).max(3600).default(60),
    approval: z
      .object({ by: z.enum(["none", "owner", "person", "ai"]).default("owner"), person: z.string().trim().max(200).optional(), hint: z.string().trim().max(1000).optional() })
      .default({ by: "owner" }),
  }),
]);
export type RuleAction = z.infer<typeof actionSchema>;

export const ruleInputSchema = z.object({
  spaceId: z.string().transform(v => v || undefined).optional(),
  conversationId: z.string().transform(v => v || undefined).optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(false),
  trigger: z.object({
    event: z.enum(["message", "chat-new", "schedule", "meeting", "doc"]).default("message"),
    /** Documents a `doc` rule watches (links): omem subscribes to their changes as the bot. */
    docs: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
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
  kind: "message" | "chat-new" | "schedule" | "meeting" | "doc";
  at: string;
  chat?: { id: string; name: string; kind: "group" | "p2p" };
  sender?: { id?: string; name: string; email?: string | null; kind: "owner" | "user" | "bot" };
  message?: { id: string; text: string; type: string; mentionsOwner: boolean; mentionsBot: boolean; topicId?: string | null; cardTitle?: string | null };
  /** The meeting the owner joined. participantCount: null = unknown; omitted = count participants. invitedCount: null or omitted = unknown. */
  meeting?: { id: string; no?: string; title: string; participants: string[]; participantCount?: number | null; invitedCount?: number | null; host?: string; calendarEventId?: string };
  /** A document that changed (lark-doc-events.ts): what changed, who changed it, who it @-mentions. */
  doc?: { token: string; type: string; title: string; url: string; location?: string; space?: string; sourceId?: string };
  change?: { kind: "edit" | "comment" | "record" | "field"; text: string; added?: string; editor?: string; editorEmail?: string | null; mentions: string[]; mentionsOwner: boolean; mentionsBot: boolean; commentId?: string };
  /** Where it came from: the bot sees groups it is in in real time; the owner's capture sees every chat. */
  via: "bot" | "capture" | "schedule" | "test" | "meeting" | "doc";
  /** The Feishu bot that saw it (via bot): "main" or one of lark.bots; its agent answers through it. */
  bot?: string;
};
