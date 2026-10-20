import { FIELDS, type Condition, type Field, type Leaf, type RuleEvent } from "./types.ts";

/**
 * Evaluate a rule's conditions against an event. Fields the event does not have are "unknown":
 * a leaf on an unknown field is false (a negated one is true), so a rule never fires on a guess.
 * `chat.bots` is looked up only when a condition asks for it.
 */
export type FieldReader = (field: Field) => Promise<unknown> | unknown;

export function eventReader(e: RuleEvent, lookups: { chatBots?: (chatId: string) => Promise<string[] | null> } = {}): FieldReader {
  let bots: Promise<string[] | null> | null = null;
  return (field) => {
    switch (field) {
      case "chat.id":
        return e.chat?.id;
      case "chat.name":
        return e.chat?.name;
      case "chat.kind":
        return e.chat?.kind;
      case "chat.bots":
        if (!e.chat || !lookups.chatBots) return undefined;
        bots ??= lookups.chatBots(e.chat.id).catch(() => null);
        return bots;
      case "sender.name":
        return e.sender?.name;
      case "sender.email":
        return e.sender?.email ?? undefined;
      case "sender.kind":
        return e.sender?.kind;
      case "message.text":
        return e.message?.text;
      case "message.type":
        return e.message?.type;
      case "message.mentionsOwner":
        return e.message?.mentionsOwner;
      case "message.mentionsBot":
        return e.message?.mentionsBot;
      case "message.inTopic":
        return e.message ? !!e.message.topicId : undefined;
      case "message.cardTitle":
        return e.message?.cardTitle ?? undefined;
    }
  };
}

const norm = (s: string) => s.toLowerCase();

function leafMatches(leaf: Leaf, raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (leaf.op === "is") return Boolean(raw) === (leaf.value === true || leaf.value === "true");
  const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const want = Array.isArray(leaf.value) ? leaf.value.map(String) : [String(leaf.value)];
  const any = (f: (v: string, w: string) => boolean) => values.some((v) => want.some((w) => f(norm(v), norm(w))));
  switch (leaf.op) {
    case "equals":
    case "in":
      return any((v, w) => v === w);
    case "contains":
      return any((v, w) => v.includes(w));
    case "startsWith":
      return any((v, w) => v.startsWith(w));
    case "endsWith":
      return any((v, w) => v.endsWith(w));
    case "matches":
      return values.some((v) => want.some((w) => safeRegex(w)?.test(v) ?? false));
  }
  return false;
}

function safeRegex(p: string) {
  try {
    return new RegExp(p, "i");
  } catch {
    return null;
  }
}

export async function evaluate(c: Condition, read: FieldReader): Promise<boolean> {
  if ("all" in c) {
    for (const x of c.all) if (!(await evaluate(x, read))) return false;
    return true;
  }
  if ("any" in c) {
    for (const x of c.any) if (await evaluate(x, read)) return true;
    return false;
  }
  if ("not" in c) return !(await evaluate(c.not, read));
  return leafMatches(c, await read(c.field));
}

/** Fields a condition reads (to know whether the event can be judged without lookups). */
export function fieldsOf(c: Condition | null): Field[] {
  if (!c) return [];
  if ("all" in c) return c.all.flatMap(fieldsOf);
  if ("any" in c) return c.any.flatMap(fieldsOf);
  if ("not" in c) return fieldsOf(c.not);
  return [c.field];
}

const OP_LABEL: Record<Leaf["op"], string> = { equals: "是", contains: "包含", startsWith: "开头是", endsWith: "结尾是", matches: "匹配", in: "是其中之一", is: "" };

/** The condition as the owner reads it: “群名包含 报警，并且（发送人是其中之一 小王、小李）”. */
export function describe(c: Condition | null): string {
  if (!c) return "（无条件）";
  if ("all" in c) return c.all.map((x) => wrap(x)).join("，并且");
  if ("any" in c) return c.any.map((x) => wrap(x)).join("，或者");
  if ("not" in c) return `不是（${describe(c.not)}）`;
  const label = FIELDS[c.field];
  if (c.op === "is") return c.value === true || c.value === "true" ? label : `不是${label}`;
  const v = Array.isArray(c.value) ? c.value.join("、") : String(c.value);
  return `${label}${OP_LABEL[c.op]} ${v}`;
}
const wrap = (c: Condition) => ("all" in c || "any" in c ? `（${describe(c)}）` : describe(c));
