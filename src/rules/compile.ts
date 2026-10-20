import type { App } from "../core/app.ts";
import { askModel, jsonIn } from "../agents/oneshot.ts";
import { listAgentSpecs } from "../agents/specs.ts";
import { truncate } from "../core/util.ts";
import { describe } from "./conditions.ts";
import { FIELDS, OPS, ruleInputSchema, type Rule, type RuleEvent, type RuleInput } from "./types.ts";

/**
 * The model's two jobs for rules: turn the owner's words into a rule the host can evaluate
 * (conditions in the JSON language, actions), and judge an event against a rule when the words
 * cannot be pinned down to conditions. Both are single tool-less calls; nothing it writes runs as code.
 */

const LANGUAGE = `条件是 JSON：叶子 {"field": 字段, "op": 运算, "value": 值}，组合 {"all": [...]}、{"any": [...]}、{"not": {...}}。
字段：${Object.entries(FIELDS).map(([k, v]) => `${k}（${v}）`).join("；")}。
运算：${OPS.join(" / ")}（in 的 value 是字符串数组；is 的 value 是 true/false；matches 是正则，大小写不敏感；其余是字符串，大小写不敏感）。`;

const ACTIONS = `动作（按顺序执行，至少一个）：
- {"type":"agent","spec":"档案名","task":"交给它的任务说明（触发的消息会自动附上）","ownTopic":是否从触发消息开话题处理,"reply":"none|draft|auto"}：none 只把结论发给本人；draft 它要在群里说的话先给本人确认；auto 可以直接在这个群/话题里回复和 @ 人
- {"type":"watch","spec":"档案名","on":"all|mention|keyword","pattern":"关键词正则（keyword 时）","reply":"none|draft|auto"}：开始监听这个群，之后的消息交给它
- {"type":"invite-bot"}：以本人身份把 omem 的机器人拉进这个群
- {"type":"capture"}：把这个群设为与本人有关，立刻采集一次
- {"type":"notify","urgent":false}：通知本人`;

export async function draftRule(app: App, description: string, current?: Partial<RuleInput>): Promise<{ rule?: RuleInput; error?: string; summary?: string }> {
  const specs = listAgentSpecs(app).map((s) => `- ${s.name}：${s.description}`).join("\n") || "（还没有 Agent 档案）";
  const prompt = [
    "把本人的一句话规则写成 omem 能执行的规则。只输出一个 JSON 对象，不要解释、不要代码块围栏。",
    "",
    `本人的规则：${description}`,
    current ? `\n当前版本（在它的基础上改，本人没提到的部分保持不变）：${JSON.stringify(current)}` : "",
    "",
    "JSON 结构：{\"name\": \"十个字以内的名字\", \"trigger\": {\"event\": \"message|chat-new|schedule\", \"once\": \"event|chat\", \"cron\": \"定时规则的 cron\"}, \"conditions\": 条件或 null, \"judge\": \"code|ai|code+ai\", \"actions\": [...]}",
    "",
    LANGUAGE,
    "",
    ACTIONS,
    "",
    `已有的 Agent 档案：\n${specs}`,
    "",
    "要求：",
    "- 能用条件说清楚的都写成条件（群名、发送人、关键词、@ 本人、消息类型），judge 用 code；条件说不清的部分（“报警需要关注”“问题是我们负责的”）用 code+ai：条件先缩小范围，模型再确认；完全没有可写的条件才用 ai。",
    "- 拉机器人、开始监听这类对一个群做一次就够的，trigger.once 用 chat；每条消息都要处理的用 event。",
    "- 发送人只给了名字就用 sender.name；给了邮箱用 sender.email。群里有某个机器人用 chat.bots contains。“报警卡片”用 message.type equals interactive。",
    "- 规则里提到的 Agent 不在已有档案里时，用最接近的；都不合适就不要编造，改用 notify 并在 name 里写明“缺档案”。",
  ].join("\n");
  const out = await askModel(app, prompt, { timeoutMs: 120_000 });
  const raw = jsonIn<Record<string, unknown>>(out);
  if (!raw) return { error: "模型没有给出可用的规则，请换个说法或手动填写" };
  const parsed = ruleInputSchema.safeParse({ ...raw, description, enabled: current?.enabled ?? false });
  if (!parsed.success) return { error: `模型给出的规则不完整：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")}` };
  const rule = parsed.data;
  return { rule, summary: `条件：${describe(rule.conditions)}；判断：${rule.judge}；动作：${rule.actions.map((a) => a.type).join("、")}` };
}

/** Describe an event for the model and the firing log. */
export function eventSummary(e: RuleEvent) {
  const parts = [
    e.chat ? `${e.chat.kind === "p2p" ? "私聊" : "群"}「${e.chat.name}」（${e.chat.id}）` : "",
    e.sender ? `发送人 ${e.sender.name}${e.sender.email ? `（${e.sender.email}）` : ""}${e.sender.kind === "bot" ? "（机器人）" : e.sender.kind === "owner" ? "（本人）" : ""}` : "",
    e.message ? `${e.message.type === "interactive" ? "卡片" : "消息"}${e.message.cardTitle ? `「${e.message.cardTitle}」` : ""}${e.message.mentionsOwner ? "，@ 了本人" : ""}${e.message.topicId ? "，在话题里" : ""}：${truncate(e.message.text.replace(/\s+/g, " "), 1000)}` : "",
    e.kind === "chat-new" ? "第一次看到这个群" : e.kind === "schedule" ? `定时触发（${e.at}）` : "",
  ];
  return parts.filter(Boolean).join("；");
}

export async function aiJudge(app: App, rule: Rule, e: RuleEvent): Promise<{ match: boolean; reason: string } | null> {
  const prompt = [
    "判断这件事是否满足本人的规则。只输出 JSON：{\"match\": true/false, \"reason\": \"一句中文理由\"}。不确定时 match 为 false。",
    "",
    `规则：${rule.description}`,
    rule.conditions ? `（已经确定满足的部分：${describe(rule.conditions)}）` : "",
    "",
    `事件：${eventSummary(e)}`,
  ].join("\n");
  const v = jsonIn<{ match?: boolean; reason?: string }>(await askModel(app, prompt, { timeoutMs: 60_000 }));
  return v && typeof v.match === "boolean" ? { match: v.match, reason: String(v.reason ?? "") } : null;
}
