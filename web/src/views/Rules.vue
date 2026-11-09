<script setup lang="ts">
import { fullAccessHint, seedProbe } from "../lib/probes";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { del, get, onServerEvent, post, put } from "../api";
import Icon from "../components/Icon.vue";
import RuleTabs from "../components/RuleTabs.vue";
import RuleConditions, { type Condition } from "../components/RuleConditions.vue";
import Skeleton from "../components/Skeleton.vue";
import AiDefaults from "../components/AiDefaults.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { fmtTime, relTime, state, toast } from "../store";

/**
 * Rules: "when this happens, have this done" (docs/v2/rules.md). The owner's words are the rule;
 * conditions are what the host evaluates, the model writes them and judges what they cannot say.
 */
type Reply = "none" | "draft" | "auto";
type Unless = "owner-engaged" | "answered";
type Action =
  | { type: "agent"; spec: string; space?: string; task: string; ownTopic: boolean; reply: Reply | "silent"; hideThinking?: boolean; failureTo?: "owner" | "chat"; allowUrgent?: boolean; allowPrivate?: boolean; merge?: boolean; mergeReply?: "combined" | "separate"; ai?: { profile: string; model?: string; effort?: string }; fullAccess?: boolean }
  | { type: "watch"; spec: string; on: "all" | "mention" | "keyword"; pattern?: string; reply: Reply }
  | { type: "invite-bot" }
  | { type: "forward"; to: { chatId: string; name: string; kind: "group" | "p2p" | "origin" }; note: string }
  | { type: "wait-message"; chatId: string; name: string; minutes: number; contains: string; matches: string; onTimeout: "notify" | "none" }
  | { type: "capture" }
  | { type: "notify"; urgent: boolean }
  | { type: "meeting-bot"; bots: string[]; confirm: boolean | Condition; record: boolean; spec: string; space?: string; task: string; answer: boolean; importShared: boolean; leaveWithOwner: boolean }
  | { type: "delay"; minutes: number }
  | { type: "check"; question: string }
  | { type: "script"; runtime: "node" | "python" | "bash"; code: string; timeoutSec: number; approval: { by: "none" | "owner" | "person" | "ai"; person?: string; hint?: string } };
type Rule = {
  id?: string;
  spaceId?: string;
  conversationId?: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: { event: "message" | "chat-new" | "schedule" | "meeting" | "doc"; docs?: string[]; pollMinutes?: number; once: "event" | "chat"; cron?: string; waitMinutes: number; unless: Unless[]; fast?: boolean };
  conditions: Condition | null;
  judge: "code" | "ai" | "code+ai";
  judgeWith?: "decision" | "general";
  actions: Action[];
  hits?: number;
  lastFiredAt?: string | null;
  conditionText?: string;
  createdBy?: string;
};
type Firing = { id: number; at: string; summary: string; judgedBy: string; reason: string; results: { action: string; ok: boolean; detail: string; runId?: string }[] };
type Options = { decision?: { ready: boolean; detail: string }; fields: Record<string, string>; eventFields?: Record<"message" | "meeting" | "doc", string[]>; bots?: { id: string; name: string }[]; ops: string[]; specs: { name: string; description: string; agent?: string }[]; backends?: { id: string; name: string; installed: boolean; transport?: string; model?: string; effort?: string; probe?: any }[]; chats: { chat_id: string; name: string; chat_mode?: string | null }[]; botReady: boolean; groups: { chat_id: string; name: string }[]; conversations: { id: string; title: string; channel: string; space_id: string; external_id: string | null }[] };
type TestResult = { checked: number; matches: { messageId: string; chat: string; sender: string; text: string; at: string; reason: string; by: string; action?: string }[]; note: string };

const route = useRoute();
const router = useRouter();
const rules = ref<Rule[]>([]);
const loading = ref(true);
const options = ref<Options>({ fields: {}, ops: [], specs: [], chats: [], botReady: false, groups: [], conversations: [] });
const selectedId = computed(() => (typeof route.query.id === "string" ? route.query.id : null));
const creating = computed(() => route.query.new === "1");
const form = ref<Rule | null>(null);
const firings = ref<Firing[]>([]);
const dirty = ref(false);
const saving = ref(false);
const drafting = ref(false);

const blank = (): Rule => ({ name: "", description: "", enabled: false, trigger: { event: "message", once: "event", waitMinutes: 0, unless: [] }, conditions: null, judge: "code", judgeWith: "decision", actions: [{ type: "agent", spec: "assistant", task: "", ownTopic: false, reply: "none" }] });

let listSeq = 0;
async function loadList() {
  const seq = ++listSeq, space = state.space;
  try {
    const result = await Promise.all([get<Rule[]>(`/api/rules?space=${encodeURIComponent(space)}`), get<Wake[]>("/api/wakes").catch(() => []), get<Watch[]>("/api/watches").catch(() => [])]);
    if (seq === listSeq && space === state.space) [rules.value, wakes.value, watches.value] = result;
  } finally {
    if (seq === listSeq) loading.value = false;
  }
}
// Wake-ups agents set for their own follow-up work: after a while, or on a message in a chat.
type Wake = { id: string; kind: "timed" | "event"; note: string; at: string | null; expiresAt: string | null; setBy: { agent: string; runId: string | null }; target: { conversationId?: string; spec?: string }; detail: string };
const wakes = ref<Wake[]>([]);
// Groups the assistant (or an agent) keeps an eye on, in batches, until a time.
type Watch = { chatId: string; name: string; conversationId: string | null; spec: string; note?: string; reply: Reply; batchMinutes?: number; expiresAt?: string };
const watches = ref<Watch[]>([]);
async function stopWatch(w: Watch) {
  if (!(await confirmDialog(`不再盯「${w.name}」？`, { okText: "不再盯" }))) return;
  await del(`/api/watches/${encodeURIComponent(w.chatId)}`);
  watches.value = watches.value.filter((x) => x.chatId !== w.chatId);
}
const selectedWake = computed(() => (typeof route.query.wake === "string" ? wakes.value.find((w) => w.id === route.query.wake) ?? null : null));
// A wake on a message is a temporary rule: its conditions and firings come from the rule.
const wakeRule = ref<(Rule & { firings: Firing[] }) | null>(null);
watch(selectedWake, async (w) => {
  wakeRule.value = null;
  if (w?.kind === "event") wakeRule.value = await get<Rule & { firings: Firing[] }>(`/api/rules/${w.id}`).catch(() => null);
});
async function cancelWake(w: Wake) {
  if (!(await confirmDialog("取消这个唤醒？", { message: w.note, okText: "取消唤醒", danger: true }))) return;
  await del(`/api/wakes/${w.id}`);
  wakes.value = wakes.value.filter((x) => x.id !== w.id);
  if (route.query.wake === w.id) void router.replace({ query: {} });
}
let detailSeq = 0;
async function loadCurrent(protectEdits = false) {
  if (protectEdits && dirty.value) return;
  const seq = ++detailSeq, selected = selectedId.value;
  const current = () => seq === detailSeq && selected === selectedId.value;
  test.value = null;
  firings.value = [];
  if (creating.value) {
    form.value = blank();
    dirty.value = false;
    return;
  }
  if (!selectedId.value) return void (form.value = null);
  try {
    const r = await get<Rule & { firings: Firing[] }>(`/api/rules/${selectedId.value}`);
    if (!current() || (protectEdits && dirty.value)) return;
    firings.value = r.firings;
    form.value = { ...r };
    dirty.value = false;
    perms.value = null;
    if (r.trigger.event === "meeting" || r.trigger.event === "doc") void checkPermissions(r.id!);
  } catch (e) {
    if (current()) toast((e as Error).message, "error");
  }
}
onMounted(async () => {
  await Promise.all([loadList(), get<Options>("/api/rule-options").then((o) => (options.value = o)).catch(() => {})]);
  await loadCurrent();
});
watch(() => [route.query.id, route.query.new], () => void loadCurrent());
const off = onServerEvent((e) => {
  if (e.type !== "changed" || e.entity !== "rule") return;
  void loadList().catch(() => {});
  if (e.id === selectedId.value && !saving.value && !drafting.value) void loadCurrent(true);
});
onBeforeUnmount(() => { off(); ++listSeq; ++detailSeq; });
onBeforeRouteLeave(async () => !dirty.value || (await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true })));
async function go(query: Record<string, string>) {
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  dirty.value = false;
  await router.replace({ query });
}
const touch = () => (dirty.value = true);

async function draft() {
  if (!form.value?.description.trim()) return toast("先写规则原话", "error");
  drafting.value = true;
  try {
    const current = { ...form.value };
    const r = await post<{ rule?: Rule; error?: string; summary?: string }>("/api/rules/draft", { description: form.value.description, current });
    if (!r.rule) return toast(r.error ?? "没能生成", "error");
    form.value = { ...form.value, ...r.rule, id: form.value.id, enabled: form.value.enabled, name: form.value.name || r.rule.name };
    dirty.value = true;
    toast("已从原话生成，核对后保存", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    drafting.value = false;
  }
}
async function save() {
  if (!form.value) return;
  const f = form.value;
  if (!f.name.trim()) f.name = f.description.slice(0, 12);
  saving.value = true;
  try {
    if (f.conversationId?.startsWith("group:")) {
      const t = await post<{ id: string }>("/api/rule-conversations", { chatId: f.conversationId.slice(6) });
      f.conversationId = t.id;
      options.value = await get<Options>("/api/rule-options");
    }
    const body = { spaceId: f.spaceId, conversationId: f.conversationId, name: f.name, description: f.description, enabled: f.enabled, trigger: f.trigger, conditions: f.conditions, judge: f.judge, judgeWith: f.judgeWith, actions: f.actions };
    const saved = f.id ? await put<Rule>(`/api/rules/${f.id}`, body) : await post<Rule>("/api/rules", body);
    dirty.value = false;
    toast("已保存", "ok");
    await loadList();
    if (!f.id) await router.replace({ query: { id: saved.id! } });
    else await loadCurrent();
    if (f.trigger.event === "meeting" || f.trigger.event === "doc") void checkPermissions(saved.id!);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
async function toggle(r: Rule) {
  try {
    await put(`/api/rules/${r.id}`, { spaceId: r.spaceId, conversationId: r.conversationId, name: r.name, description: r.description, enabled: !r.enabled, trigger: r.trigger, conditions: r.conditions, judge: r.judge, judgeWith: r.judgeWith, actions: r.actions });
    await loadList();
    if (form.value?.id === r.id && !dirty.value) await loadCurrent();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function remove() {
  if (!form.value?.id || !(await confirmDialog(`删除规则「${form.value.name}」？`, { okText: "删除", danger: true }))) return;
  await del(`/api/rules/${form.value.id}`);
  dirty.value = false;
  await router.replace({ query: {} });
  await loadList();
}

// ---- actions ------------------------------------------------------------------------
const ACTION_LABEL: Record<Action["type"], string> = { agent: "交给 Agent", watch: "持续监听这个群", "invite-bot": "拉机器人进群", forward: "转发到", "wait-message": "等某个会话的新消息", capture: "优先采集这个群", notify: "通知我", "meeting-bot": "拉机器人入会", delay: "延时", check: "模型判断", script: "执行脚本" };
const replyOptions = [
  { value: "none", label: "只告诉我" },
  { value: "draft", label: "先给我看" },
  { value: "auto", label: "直接回复" },
];
const agentReplyOptions = [...replyOptions, { value: "silent", label: "静默排查" }];
const REPLY_HINT: Record<string, string> = {
  none: "结论只发给你，群里不出现任何东西。",
  draft: "它要在群里说的话先变成给你确认的草稿。",
  auto: "直接在群里（或它的话题里）回复，思考气泡可见。",
  silent: "群里看不到过程；它读完讨论自己判断要不要发、要不要追问缺的信息，有结论才在话题里发，之后跟进这个话题，你一插话它就停。",
};
const spaceOptions = (none: string) => [{ value: "", label: none }, ...state.spaces.map((s) => ({ value: s.id, label: s.name }))];
// A whole group's conversation is shown as the group itself (its title is often just the first message there).
const groupIds = computed(() => new Set((options.value.groups ?? []).map((g) => g.chat_id)));
const groupConversation = (c: Options["conversations"][number]) => c.channel.startsWith("lark") && !!c.external_id && groupIds.value.has(c.external_id);
const destinationValue = computed(() => {
  const id = form.value?.conversationId ?? "";
  const c = options.value.conversations.find((x) => x.id === id);
  return c && groupConversation(c) ? `group:${c.external_id}` : id;
});
const conversationOptions = computed(() => [
  { value: "", label: "选择会话或群聊" },
  ...(options.value.groups ?? []).map((c) => ({ value: `group:${c.chat_id}`, label: c.name || c.chat_id, hint: "飞书群聊 · 新群消息" })),
  ...options.value.conversations.filter((c) => !groupConversation(c)).map((c) => ({ value: c.id, label: c.title || "未命名会话", hint: `${c.channel === "web" ? "网页" : c.channel.startsWith("lark") ? "飞书" : c.channel} · ${state.spaces.find((x) => x.id === c.space_id)?.name ?? c.space_id}` })),
]);
/** A draft needs a Feishu chat to go to after confirmation; a web conversation only the owner reads. */
const larkDestination = computed(() => {
  if (form.value?.conversationId?.startsWith("group:")) return true;
  const c = options.value.conversations.find((x) => x.id === form.value?.conversationId);
  return !c || c.channel.startsWith("lark");
});
const scheduleReplyOptions = computed(() => replyOptions.filter((o) => o.value !== "draft" || larkDestination.value));
const specOptions = computed(() => options.value.specs.map((s) => ({ value: s.name, label: s.name === "assistant" ? "主助手" : s.name, hint: s.description })));
/** The backend a profile runs on when the rule does not pick one. */
const specAgent = (spec: string) => options.value.specs.find((s) => s.name === spec)?.agent ?? "";
/** Whether the backend this action runs on can do 完全访问 (by its last detection). */
function accessHint(a: { spec: string; ai?: { profile: string } }) {
  const id = a.ai?.profile || specAgent(a.spec);
  const backends = options.value.backends ?? [];
  for (const b of backends) seedProbe(b.id, b.probe);
  return fullAccessHint(id ? backends.find((b) => b.id === id) : undefined) + (id ? "" : "（用的是档案或助手的默认后端）");
}
type AgentAction = Extract<Action, { type: "agent" }>;
function toggleAI(a: AgentAction, on: boolean) {
  a.ai = on ? { profile: specAgent(a.spec) || options.value.backends?.find((b) => b.installed)?.id || "" } : undefined;
  touch();
}
function setAI(a: AgentAction, v: { agent?: string; model?: string; effort?: string }) {
  a.ai = { profile: v.agent || specAgent(a.spec), ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}) };
}
const addPick = ref<string | null>(null);
function addAction(type: string | null) {
  addPick.value = null;
  if (!form.value || !type) return;
  const spec = type === "agent" ? "assistant" : options.value.specs.find(s => s.name !== "assistant")?.name ?? "";
  const a: Action =
    type === "agent" ? { type, spec, task: "", ownTopic: false, reply: "none" }
    : type === "watch" ? { type, spec, on: "mention", reply: "draft" }
    : type === "notify" ? { type, urgent: false }
    : type === "forward" ? { type, to: { chatId: "", name: "", kind: "group" }, note: "" }
    : type === "wait-message" ? { type, chatId: "", name: "", minutes: 5, contains: "", matches: "", onTimeout: "notify" }
    : type === "meeting-bot" ? meetingAction()
    : type === "delay" ? { type, minutes: 30 }
    : type === "check" ? { type, question: "" }
    : type === "script" ? { type, runtime: "node", code: SCRIPT_SAMPLE, timeoutSec: 60, approval: { by: "owner" } }
    : ({ type } as Action);
  form.value.actions.push(a);
  touch();
}
function moveAction(i: number, d: number) {
  const list = form.value!.actions;
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  touch();
}
const scheduleOnly = computed(() => form.value?.trigger.event === "schedule");
const meetingRule = computed(() => form.value?.trigger.event === "meeting");
const docRule = computed(() => form.value?.trigger.event === "doc");
const isOwner = computed(() => state.me?.role === "owner");
/** What a new script starts as: reading the event it gets. */
const SCRIPT_SAMPLE = [
  "// 触发这条规则的事件在 process.env.OMEM_EVENT（JSON），也从标准输入传进来。",
  "const event = JSON.parse(process.env.OMEM_EVENT);",
  "console.log(event.doc?.title ?? event.chat?.name, event.change?.text ?? event.message?.text);",
].join("\n");
const SCRIPT_HINT: Record<string, string> = { node: "Node（用 omem 自己的 Node 运行）", python: "Python 3", bash: "Bash" };
const approvalOptions = [{ value: "owner", label: "我批准" }, { value: "person", label: "指定的人批准" }, { value: "ai", label: "AI 判断谁批准" }, { value: "none", label: "不用批准" }];
/** Minutes shown in the largest whole unit: 90 → 90 分钟, 120 → 2 小时, 1440 → 1 天. */
const delayUnit = (m: number) => (m % 1440 === 0 ? 1440 : m % 60 === 0 ? 60 : 1);
function setDelay(a: Extract<Action, { type: "delay" }>, n: number, unit: number) {
  a.minutes = Math.max(1, Math.round((Number.isFinite(n) ? n : 1) * unit));
  touch();
}
const docLinks = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
const meetingAction = (): Action => ({ type: "meeting-bot", bots: options.value.bots?.length ? [options.value.bots[0].id] : [], confirm: true, record: true, spec: "", task: "", answer: false, importShared: true, leaveWithOwner: true });
const confirmOptions = [{ value: "always", label: "始终询问" }, { value: "never", label: "直接加入" }, { value: "condition", label: "满足条件时询问" }];
function setConfirmation(a: Extract<Action, { type: "meeting-bot" }>, mode: string) {
  a.confirm = mode === "always" ? true : mode === "never" ? false : { field: "meeting.invitedCount", op: "gte", value: "30" };
  touch();
}
/** Captured chats a rule can forward to: groups, and people's private chats (a group is made for those). */
const targetChats = computed(() => options.value.chats.map((c) => ({ value: c.chat_id, label: `${c.chat_mode === "p2p" ? "私聊" : "群"} · ${c.name}` })));
const ORIGIN = "__origin";
const forwardOptions = computed(() => [{ value: ORIGIN, label: "回到触发的会话（等到消息后）" }, ...targetChats.value]);
function setForwardTarget(a: Extract<Action, { type: "forward" }>, chatId: string) {
  if (chatId === ORIGIN) a.to = { chatId: "", name: "", kind: "origin" };
  else {
    const c = options.value.chats.find((x) => x.chat_id === chatId);
    a.to = { chatId, name: c?.name ?? "", kind: c?.chat_mode === "p2p" ? "p2p" : "group" };
  }
  touch();
}
function setWaitChat(a: Extract<Action, { type: "wait-message" }>, chatId: string) {
  a.chatId = chatId;
  a.name = options.value.chats.find((x) => x.chat_id === chatId)?.name ?? "";
  touch();
}
const addOptions = computed(() =>
  (Object.keys(ACTION_LABEL) as Action["type"][])
    .filter((t) => (meetingRule.value ? ["meeting-bot", "notify"].includes(t) : t !== "meeting-bot"))
    // Without a chat (a schedule, a document change) only what needs none.
    .filter((t) => !(scheduleOnly.value || docRule.value) || ["agent", "notify", "delay", "check", "script"].includes(t))
    // Forwarding needs a message to forward.
    .filter((t) => !["forward", "wait-message"].includes(t) || form.value?.trigger.event === "message")
    .map((t) => ({ value: t as string | null, label: ACTION_LABEL[t], hint: (t === "invite-bot" || t === "forward") && !options.value.botReady ? "需要先配置飞书机器人" : t === "script" && !isOwner.value ? "只有本人能保存带脚本的规则" : "" })),
);

// ---- meetings ---------------------------------------------------------------------------
/** The condition fields that make sense for this trigger: a meeting has no chat or message. */
const condFields = computed(() => {
  const keys = options.value.eventFields?.[meetingRule.value ? "meeting" : docRule.value ? "doc" : "message"];
  return keys ? Object.fromEntries(keys.map((k) => [k, options.value.fields[k]])) : options.value.fields;
});
const fieldOps = { "meeting.participantCount": ["gte", "lte", "equals"] };
const meetingSpecOptions = computed(() => [{ value: "", label: "不旁听" }, ...specOptions.value]);
/** Switching to or from the meeting trigger: keep the actions that still fit, add or drop the meeting one. */
function onTrigger() {
  const f = form.value;
  if (!f) return;
  if (f.trigger.event === "meeting") {
    f.actions = f.actions.filter((a) => a.type === "notify" || a.type === "meeting-bot");
    if (!f.actions.some((a) => a.type === "meeting-bot")) f.actions.unshift(meetingAction());
    f.trigger.waitMinutes = 0;
    f.trigger.unless = [];
  } else f.actions = f.actions.filter((a) => a.type !== "meeting-bot");
  if (f.trigger.event === "doc") {
    // A document change has no chat: the agent only reports to the owner, and nothing waits on a discussion.
    f.actions = f.actions.filter((a) => ["agent", "notify", "delay", "check", "script"].includes(a.type));
    for (const a of f.actions) if (a.type === "agent") Object.assign(a, { reply: "none", ownTopic: false });
    f.trigger.waitMinutes = 0;
    f.trigger.unless = [];
    f.trigger.docs ??= [];
  } else {
    delete f.trigger.docs;
    delete f.trigger.pollMinutes;
  }
  if (!f.actions.length) f.actions.push({ type: "agent", spec: "assistant", task: "", ownTopic: false, reply: "none" });
  touch();
}
function toggleBot(a: Extract<Action, { type: "meeting-bot" }>, id: string, on: boolean) {
  a.bots = on ? [...new Set([...a.bots, id])] : a.bots.filter((b) => b !== id);
  if (!a.bots.length) a.answer = false;
  touch();
}
type Perms = { issues: { who: string; problem: string; scopes?: string[]; link?: string; linkText?: string }[]; notes: string[]; ok: string[] };
const perms = ref<Perms | null>(null);
const checking = ref(false);
async function checkPermissions(id: string) {
  checking.value = true;
  try {
    const result = await get<Perms>(`/api/rules/${id}/permissions`);
    if (id === selectedId.value) perms.value = result;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    checking.value = false;
  }
}

// ---- trying it ------------------------------------------------------------------------
const test = ref<TestResult | null>(null);
const testing = ref(false);
const testChat = ref<string | null>(null);
const testAi = ref(false);
const chatOptions = computed(() => [{ value: null as string | null, label: "所有会话" }, ...options.value.chats.map((c) => ({ value: c.chat_id as string | null, label: c.name }))]);
async function runTest() {
  if (!form.value) return;
  testing.value = true;
  try {
    const f = form.value;
    test.value = await post<TestResult>("/api/rules/test", { rule: { name: f.name || "试运行", description: f.description || "试运行", trigger: f.trigger, conditions: f.conditions, judge: f.judge, judgeWith: f.judgeWith, actions: f.actions }, chatId: testChat.value ?? undefined, ai: testAi.value });
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    testing.value = false;
  }
}
// The model checks (AI judging, or a "check" action) can go to the decision model.
const usesModel = computed(() => !!form.value && (form.value.judge !== "code" || form.value.actions.some((a) => a.type === "check")));
const judgeWithHint = computed(() => {
  if (!form.value) return "";
  if ((form.value.judgeWith ?? "decision") === "general") return "通用模型读完规则和讨论再判断，会写理由；慢一些、贵一些。";
  const d = options.value.decision;
  return d?.ready ? `用 ${d.detail}：只给出是 / 否和概率，快、便宜；出错时按 设置 → AI → 决策 的设置处理。` : "还没有可用的决策模型（设置 → AI → 决策），现在用通用模型判断。";
});
const judgeHint = computed(() =>
  !form.value ? "" : form.value.judge === "code" ? "只看条件：便宜、可预期。" : form.value.judge === "code+ai" ? "条件先缩小范围，命中的再请模型按原话确认。" : "每条事件都请模型按原话判断（每小时最多 60 次）。建议至少加一个群名之类的条件，改成“条件 + AI”。",
);
const EXAMPLES = [
  "值班群里我被 @ 时，立刻把机器人拉进群，并优先采集这个群",
  "报警群里小王或小李发报警卡片时，在卡片下开话题交给 alert-analyst 分析，需要关注就直接 @ 值班人",
  "群名包含“答疑”的群，把机器人拉进去，之后 @ 机器人的问题交给 support-agent，回复先给我看",
  "任何群里有人提到“合同到期”就通知我",
  "我加入标题带“评审”的会议时，问我要不要把机器人拉进去，记录会议，有人问到我时提醒我",
];
function startFrom(text: string) {
  void router.replace({ query: { new: "1" } }).then(() => {
    if (form.value) form.value.description = text;
    void draft();
  });
}
</script>

<template>
  <div class="rules">
    <aside class="list-col">
      <div class="head row">
        <RuleTabs />
        <span class="spacer" />
        <button class="btn ghost sm icon" title="新建任务规则" aria-label="新建任务规则" @click="go({ new: '1' })"><Icon name="plus" :size="15" /></button>
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="5" />
        <div v-for="r in rules" v-else :key="r.id" class="li" :class="{ on: r.id === selectedId }">
          <button class="grow pick" type="button" @click="go({ id: r.id! })">
            <div class="row"><strong class="ellipsis">{{ r.name }}</strong><span v-if="r.createdBy === 'agent' && !r.enabled" class="badge">待确认</span></div>
            <div class="muted small clamp">{{ r.description }}</div>
            <div class="muted small">命中 {{ r.hits ?? 0 }} 次<template v-if="r.lastFiredAt"> · {{ relTime(r.lastFiredAt) }}</template></div>
          </button>
          <UiCheckbox :model-value="r.enabled" switch size="sm" :aria-label="`启用 ${r.name}`" @change="toggle(r)" />
        </div>
        <p v-if="!loading && !rules.length" class="muted small hint">还没有任务规则。点 ＋ 新建，或对助理说“以后值班群里我被 @ 就把机器人拉进去”。</p>
        <template v-if="wakes.length">
          <div class="group muted small" title="Agent 为自己的后续工作设的，触发或到期后自动删除">临时唤醒</div>
          <div v-for="w in wakes" :key="w.id" class="li wake" :class="{ on: w.id === selectedWake?.id }">
            <button class="grow pick" type="button" @click="go({ wake: w.id })">
              <div class="row"><span class="badge">{{ w.kind === "timed" ? "定时" : "消息" }}</span><span class="muted small ellipsis">{{ w.setBy.agent }}</span></div>
              <div class="small clamp">{{ w.note }}</div>
              <div class="muted small clamp">{{ w.kind === "timed" ? `${fmtTime(w.at!)} 唤醒` : `${w.detail} · ${fmtTime(w.expiresAt!)} 失效` }}</div>
            </button>
            <button class="btn ghost sm icon" :title="`取消唤醒：${w.note}`" @click="cancelWake(w)"><Icon name="x" :size="14" /></button>
          </div>
        </template>
        <template v-if="watches.length">
          <div class="group muted small" title="本人让助理盯着的群：消息按批交给它，到期自动停止">正在盯的群</div>
          <div v-for="w in watches" :key="w.chatId" class="li wake">
            <component :is="w.conversationId ? 'router-link' : 'div'" class="grow pick" :to="w.conversationId ? `/ask/${w.conversationId}` : undefined">
              <div class="row"><span class="badge">盯群</span><span class="ellipsis small">{{ w.name }}</span></div>
              <div v-if="w.note" class="small clamp">{{ w.note }}</div>
              <div class="muted small clamp">{{ w.spec === "assistant" ? "主助手" : w.spec }} · {{ w.batchMinutes ? `每 ${w.batchMinutes} 分钟一批` : "即时" }} · {{ w.expiresAt ? `${fmtTime(w.expiresAt)} 停止` : "直到取消" }}</div>
            </component>
            <button class="btn ghost sm icon" :title="`不再盯：${w.name}`" @click="stopWatch(w)"><Icon name="x" :size="14" /></button>
          </div>
        </template>
      </div>
    </aside>

    <main class="detail">
      <div v-if="selectedWake" class="page">
        <header class="dh row">
          <span class="badge accent">{{ selectedWake.kind === "timed" ? "定时唤醒" : "消息唤醒" }}</span>
          <strong class="grow">临时唤醒</strong>
          <button class="btn sm danger" @click="cancelWake(selectedWake)"><Icon name="x" :size="14" />取消唤醒</button>
        </header>
        <p class="muted small">Agent 为自己后续的工作设的：{{ selectedWake.kind === "timed" ? "到时间" : "等到符合条件的消息" }}就在原来的会话里接着做，触发一次或到期后自动删除。这里只能查看和取消。</p>
        <section class="block">
          <div class="block-head"><h3>要做什么</h3></div>
          <div class="note">{{ selectedWake.note }}</div>
        </section>
        <section class="block">
          <div class="block-head"><h3>什么时候</h3></div>
          <div v-if="selectedWake.kind === 'timed'" class="small">{{ fmtTime(selectedWake.at!) }}（{{ relTime(selectedWake.at!) }}）</div>
          <template v-else>
            <div class="small">{{ wakeRule?.conditionText || selectedWake.detail }}</div>
            <div class="muted small">{{ fmtTime(selectedWake.expiresAt!) }} 前没等到就失效（{{ relTime(selectedWake.expiresAt!) }}）</div>
          </template>
        </section>
        <section class="block">
          <div class="block-head"><h3>谁设的、唤醒谁</h3></div>
          <div class="small">{{ selectedWake.setBy.agent }} 设的<template v-if="selectedWake.setBy.runId"> · <router-link :to="`/runs/${selectedWake.setBy.runId}`">设它的运行</router-link></template></div>
          <div class="small">
            <template v-if="selectedWake.target.spec">唤醒 Agent 档案 {{ selectedWake.target.spec }}，结果发回原会话</template>
            <template v-else>在原会话里接着做</template>
            <template v-if="selectedWake.target.conversationId"> · <router-link :to="`/ask/${selectedWake.target.conversationId}`">打开会话</router-link></template>
          </div>
        </section>
        <section v-if="wakeRule?.firings.length" class="block">
          <div class="block-head"><h3>触发记录</h3></div>
          <div v-for="f in wakeRule.firings" :key="f.id" class="firing small">
            <div class="muted">{{ fmtTime(f.at) }}</div>
            <div>{{ f.summary }}</div>
          </div>
        </section>
      </div>

      <div v-else-if="!form" class="empty">
        <Icon name="zap" :size="34" />
        <h3>任务规则</h3>
        <p>用一句话说“遇到什么情况就做什么”：来了新消息、看到新群或到了某个时间，满足条件就交给 Agent 处理、拉机器人进群、优先采集或通知你。能写成条件的直接判断，写不成的请模型按原话判断。</p>
        <div class="examples">
          <button v-for="x in EXAMPLES" :key="x" class="example" type="button" @click="startFrom(x)">{{ x }}</button>
        </div>
        <button class="btn" @click="go({ new: '1' })"><Icon name="plus" :size="14" />新建规则</button>
      </div>

      <div v-else class="page">
        <header class="dh row">
          <input v-model="form.name" class="input title" placeholder="规则名" aria-label="规则名" @input="touch" />
          <UiCheckbox v-model="form.enabled" switch @change="touch">启用</UiCheckbox>
          <button class="btn sm primary" :disabled="saving || (!!form.id && !dirty)" @click="save">保存</button>
          <button v-if="form.id" class="btn ghost sm icon danger" title="删除" @click="remove"><Icon name="trash" :size="14" /></button>
        </header>

        <section class="block">
          <div class="block-head"><h3>规则原话</h3><span class="muted small">条件和动作都可以从这句话重新生成</span></div>
          <textarea v-model="form.description" class="input" rows="3" placeholder="例如：报警群里小王发报警卡片时，在卡片下开话题交给 alert-analyst 分析，需要关注就 @ 值班人" @input="touch" />
          <div class="row"><button class="btn sm" :disabled="drafting" @click="draft"><Icon name="sparkles" :size="13" />{{ drafting ? "生成中…" : form.id ? "按原话重新生成" : "从原话生成条件和动作" }}</button></div>
        </section>

        <section class="block">
          <div class="block-head"><h3>什么时候看</h3></div>
          <div class="row wrap">
            <UiSegmented v-model="form.trigger.event" size="sm" :options="[{ value: 'message', label: '新消息' }, { value: 'chat-new', label: '第一次看到的群' }, { value: 'schedule', label: '定时' }, { value: 'meeting', label: '我加入会议时' }, { value: 'doc', label: '文档变化' }]" aria-label="触发" @change="onTrigger" />
            <UiSegmented v-if="form.trigger.event === 'message'" v-model="form.trigger.once" size="sm" :options="[{ value: 'event', label: '每条消息' }, { value: 'chat', label: '每个群只一次' }]" aria-label="触发次数" @change="touch" />
            <input v-if="form.trigger.event === 'schedule'" v-model="form.trigger.cron" class="input sm mono cron" placeholder="0 9 * * 1-5" aria-label="cron" @input="touch" />
            <UiSelect v-if="form.trigger.event !== 'schedule' && !meetingRule" :model-value="form.spaceId ?? ''" size="sm" width="200px" :options="spaceOptions(docRule ? '所有空间的文档' : '所有空间的群')" :aria-label="docRule ? '只看哪个空间的文档' : '只看哪个空间的群'" @update:model-value="(v) => ((form!.spaceId = String(v || '')), touch())" />
            <UiSelect v-if="meetingRule" :model-value="form.spaceId ?? ''" size="sm" width="200px" :options="spaceOptions('会议记录放默认空间')" aria-label="会议记录放哪个空间" @update:model-value="(v) => ((form!.spaceId = String(v || '')), touch())" />
          </div>
          <div v-if="form.trigger.event === 'message'" class="row wrap">
            <label class="row inline small">命中后等
              <input v-model.number="form.trigger.waitMinutes" class="input sm num" type="number" inputmode="numeric" min="0" max="1440" aria-label="等待分钟" @input="touch" />
              分钟再处理</label>
            <UiCheckbox v-model="form.trigger.unless" value="owner-engaged" size="sm" @change="touch">我已在这段讨论里就跳过</UiCheckbox>
            <UiCheckbox v-model="form.trigger.unless" value="answered" size="sm" @change="touch">已有人回复就跳过</UiCheckbox>
            <UiCheckbox :model-value="!!form.trigger.fast" size="sm" title="每分钟用你的身份搜一次群里 @ 你和私聊的消息（按条件里“正文包含”的词搜），不等平常的采集" @change="(v) => ((form!.trigger.fast = v || undefined), touch())">快速检查（每分钟）</UiCheckbox>
          </div>
          <small v-if="form.trigger.event === 'message'" class="muted">“每个群只一次”适合拉机器人、开始监听这类一次就够的事。等待和跳过在动手前看一眼这段讨论：你在话题里或半小时内在群里说过话，算“已在讨论里”。</small>
          <small v-else-if="form.trigger.event === 'schedule'" class="muted">cron 写法：分 时 日 月 周，例如 0 9 * * 1-5 是工作日早上 9 点。</small>
          <small v-else-if="meetingRule" class="muted">你加入一场飞书视频会议时判断（用你的 lark-cli 登录接收入会事件）。每场会议对这条规则只触发一次；入会后十分钟内参会人变了会再判断一次。不写条件就是每场会议。</small>
          <template v-if="docRule">
            <textarea :value="(form.trigger.docs ?? []).join('\n')" class="input mono small" rows="3" placeholder="要盯的飞书文档、电子表格、多维表格或知识库页面的链接，一行一个；不填就看机器人订阅了的所有文档" aria-label="要盯的文档" @input="(e) => ((form!.trigger.docs = docLinks((e.target as HTMLTextAreaElement).value)), touch())" />
            <label class="row inline small">机器人订阅不了的，每
              <input :value="form.trigger.pollMinutes ?? 30" class="input sm num" type="number" inputmode="numeric" min="5" max="1440" aria-label="订阅不了时每隔多少分钟查一次" @input="(e) => ((form!.trigger.pollMinutes = Math.min(1440, Math.max(5, Number((e.target as HTMLInputElement).value) || 30))), touch())" />
              分钟用我的登录查一次更新</label>
            <small class="muted">机器人订阅文档后，有人编辑、改多维表格记录或字段、在评论里 @ 机器人时立即触发；连续的编辑合成一次（停下一分半钟后）。飞书只把编辑和表格变化发给文档的管理者：机器人不是管理者的，按上面的间隔用你的登录查最后修改时间，改过就读出改了什么再触发（不是即时的）。保存后下面会检查每篇是订阅上了还是定时查。</small>
          </template>
        </section>

        <section v-if="form.trigger.event !== 'schedule'" class="block">
          <div class="block-head"><h3>满足什么</h3></div>
          <div class="row wrap">
            <UiSegmented v-model="form.judge" size="sm" :options="[{ value: 'code', label: '按条件' }, { value: 'code+ai', label: '条件 + AI 确认' }, { value: 'ai', label: '交给 AI 判断' }]" aria-label="判断方式" @change="touch" />
            <small class="muted">{{ judgeHint }}</small>
          </div>
          <div v-if="usesModel" class="row wrap">
            <span class="small muted">用哪个模型判断</span>
            <UiSegmented :model-value="form.judgeWith ?? 'decision'" size="sm" :options="[{ value: 'decision', label: '决策模型优先' }, { value: 'general', label: '通用模型' }]" aria-label="用哪个模型判断" @change="(v: any) => { form!.judgeWith = v; touch(); }" />
            <small class="muted">{{ judgeWithHint }}</small>
          </div>
          <RuleConditions v-model="form.conditions" :fields="condFields" :ops="options.ops" :field-ops="fieldOps" @update:model-value="touch" />
        </section>

        <section class="block">
          <div class="block-head"><h3>做什么</h3><span class="muted small">按顺序执行</span></div>
          <div v-for="(a, i) in form.actions" :key="i" class="action">
            <div class="row">
              <strong class="small">{{ i + 1 }}. {{ ACTION_LABEL[a.type] }}</strong>
              <span class="spacer" />
              <button class="btn ghost sm icon" type="button" title="上移" :disabled="i === 0" @click="moveAction(i, -1)">↑</button>
              <button class="btn ghost sm icon" type="button" title="删除" @click="form.actions.splice(i, 1), touch()"><Icon name="x" :size="13" /></button>
            </div>
            <template v-if="a.type === 'agent'">
              <div class="row wrap">
                <UiSelect v-model="a.spec" size="sm" width="180px" :options="specOptions" placeholder="交给谁" aria-label="Agent" @change="touch" />
                <UiSelect :model-value="a.space ?? ''" size="sm" width="170px" :options="spaceOptions('默认空间')" aria-label="在哪个空间里查资料" title="Agent 在哪个空间里查资料。默认：档案固定的空间，其次是上面选的空间，再次是消息所在群的空间" @update:model-value="(v) => ((a.space = String(v || '')), touch())" />
                <UiSegmented v-if="!docRule" v-model="a.reply" size="sm" :options="scheduleOnly ? scheduleReplyOptions : agentReplyOptions" aria-label="回复方式" @change="touch" />
                <UiCheckbox v-if="!scheduleOnly && !docRule && a.reply !== 'silent'" v-model="a.ownTopic" size="sm" :disabled="a.reply === 'none'" @change="touch">在消息下开话题</UiCheckbox>
              </div>
              <div class="row wrap">
                <UiCheckbox :model-value="!!a.hideThinking" size="sm" @change="v => { a.hideThinking = v; touch(); }">隐藏思考气泡</UiCheckbox>
                <UiCheckbox :model-value="a.merge !== false" size="sm" title="同一个群里，这条规则还在处理时再次触发，复用同一 Agent 会话；回复方式在下方选择" @change="v => { a.merge = v ? undefined : false; touch(); }">处理中再次触发时并入同一会话</UiCheckbox>
                <span class="small">失败时</span>
                <UiSelect :model-value="a.failureTo ?? 'owner'" :options="[{ value: 'owner', label: '通知本人' }, { value: 'chat', label: '发到群聊' }]" size="sm" width="150px" aria-label="失败时通知谁" @update:model-value="v => { a.failureTo = v; touch(); }" />
              </div>
              <div v-if="a.merge !== false" class="stack">
                <UiSegmented :model-value="a.mergeReply ?? 'combined'" :options="[{ value: 'combined', label: '合并回复' }, { value: 'separate', label: '每次触发分别回复' }]" size="sm" aria-label="连续触发的回复方式" @update:model-value="v => { a.mergeReply = v; touch(); }" />
                <small class="muted">{{ a.mergeReply === 'separate' ? '每次触发依次处理，复用前面的调查，各自完成任务并按上面的回复方式答复。' : '后续触发交给正在处理的一轮，可以一起给出结论。' }}</small>
              </div>
              <div v-if="scheduleOnly && (a.reply !== 'none' || a.failureTo === 'chat')" class="row wrap">
                <span class="small">发到</span>
                <UiSelect :model-value="destinationValue" size="sm" width="260px" :search-at="8" :options="conversationOptions" aria-label="结果发到哪个会话" @update:model-value="(v) => ((form!.conversationId = String(v || '')), touch())" />
              </div>
              <small v-if="scheduleOnly && (a.reply !== 'none' || a.failureTo === 'chat') && !form.conversationId" class="muted">尚未指定投递目标。请选择会话或已采集的群聊；向群里发送需要机器人已在群中。</small>
              <small class="muted">{{ scheduleOnly && a.reply !== 'none' ? (a.reply === 'auto' ? "结论直接发到选定的会话。" : "它要在群里说的话先变成给你确认的草稿，你点发送才发到这个群（话题）；结论另外发给你。") : REPLY_HINT[a.reply] }}</small>
              <div v-if="!scheduleOnly && a.reply !== 'none'" class="row wrap">
                <UiCheckbox :model-value="!!a.allowUrgent" size="sm" @change="(v) => ((a.allowUrgent = v), touch())">允许加急</UiCheckbox>
                <UiCheckbox :model-value="!!a.allowPrivate" size="sm" @change="(v) => ((a.allowPrivate = v), touch())">允许只给部分人看</UiCheckbox>
                <small class="muted">什么时候用、对谁用写在要求里，没写就不用</small>
              </div>
              <div class="row wrap">
                <UiCheckbox :model-value="!!a.ai" size="sm" @change="(v) => toggleAI(a, v)">指定 AI</UiCheckbox>
                <small class="muted">{{ a.ai ? "这条规则交出去的运行用下面选的后端、模型和思考强度。" : `不指定就用档案自己的设置${specAgent(a.spec) ? `（${specAgent(a.spec)}）` : ""}，按 设置 → AI → 任务选型 可在开始前自动换成更合适的候选，出错时换兜底；模型写在要求里不会生效。` }}</small>
              </div>
              <AiDefaults v-if="a.ai" :model-value="{ agent: a.ai.profile, model: a.ai.model, effort: a.ai.effort }" :backends="options.backends ?? []" :default-backend="specAgent(a.spec)" @update:model-value="(v) => setAI(a, v)" @change="touch" />
              <div class="row wrap">
                <UiCheckbox :model-value="!!a.fullAccess" size="sm" @change="(v) => ((a.fullAccess = v || undefined), touch())">完全访问：命令不进沙箱、不经审批</UiCheckbox>
                <small class="muted">{{ a.fullAccess ? accessHint(a) : "需要联网的命令行排查（报警、值班）每次都要审批时打开；交给别的 Agent 时它也照此运行。" }}</small>
              </div>
              <textarea v-model="a.task" class="input" rows="2" placeholder="交给它的要求（触发的消息会自动附上），例如：分析报警，需要关注就 @ 值班人" @input="touch" />
            </template>
            <template v-else-if="a.type === 'watch'">
              <div class="row wrap">
                <UiSelect v-model="a.spec" size="sm" width="200px" :options="specOptions.filter(s => s.value !== 'assistant')" placeholder="选择 Agent 档案" aria-label="Agent" @change="touch" />
                <UiSegmented v-model="a.on" size="sm" :options="[{ value: 'mention', label: '@ 时' }, { value: 'all', label: '每条' }, { value: 'keyword', label: '关键词' }]" aria-label="监听哪些" @change="touch" />
                <input v-if="a.on === 'keyword'" v-model="a.pattern" class="input sm" placeholder="正则" @input="touch" />
                <UiSegmented v-model="a.reply" size="sm" :options="replyOptions" aria-label="回复方式" @change="touch" />
              </div>
            </template>
            <template v-else-if="a.type === 'meeting-bot'">
              <div class="row wrap">
                <span class="small">拉进会的机器人</span>
                <UiCheckbox v-for="b in options.bots ?? []" :key="b.id" :model-value="a.bots.includes(b.id)" size="sm" @change="(v) => toggleBot(a, b.id, v)">{{ b.name }}</UiCheckbox>
                <small v-if="!options.bots?.length" class="muted">还没有飞书机器人：只能以你的身份记录</small>
              </div>
              <small v-if="!a.bots.length" class="muted">不拉机器人时只以你的身份读会中事件做记录，别人看不到。</small>
              <div class="row wrap">
                <span class="small">入会确认</span>
                <UiSelect :model-value="typeof a.confirm === 'object' ? 'condition' : a.confirm ? 'always' : 'never'" size="sm" width="200px" :options="confirmOptions" :disabled="!a.bots.length" aria-label="入会确认方式" @update:model-value="(v) => setConfirmation(a, String(v))" />
              </div>
              <template v-if="typeof a.confirm === 'object' && a.bots.length">
                <RuleConditions :model-value="a.confirm" :fields="condFields" :ops="options.ops" :field-ops="fieldOps" @update:model-value="(v) => ((a.confirm = v ?? { all: [] }), touch())" />
                <small class="muted">满足以上条件时先发卡片问你，否则直接加入。条件数据未知时也先问你；按本次入会触发时的数据判断。</small>
              </template>
              <div class="row wrap">
                <UiCheckbox v-model="a.record" size="sm" @change="touch">保存会议记录（转写、会中聊天、进出）</UiCheckbox>
                <UiCheckbox v-model="a.importShared" size="sm" @change="touch">导入会上共享的文档</UiCheckbox>
                <UiCheckbox v-model="a.leaveWithOwner" size="sm" :disabled="!a.bots.length" @change="touch">我离会时机器人一起离开</UiCheckbox>
              </div>
              <div class="row wrap">
                <span class="small">旁听</span>
                <UiSelect v-model="a.spec" size="sm" width="180px" :options="meetingSpecOptions" aria-label="旁听的 Agent" @change="touch" />
                <UiSelect v-if="a.spec" :model-value="a.space ?? ''" size="sm" width="170px" :options="spaceOptions('默认空间')" aria-label="在哪个空间里查资料" @update:model-value="(v) => ((a.space = String(v || '')), touch())" />
                <UiCheckbox v-if="a.spec" v-model="a.answer" size="sm" :disabled="!a.bots.length" @change="touch">回答会中聊天里点名机器人的问题</UiCheckbox>
              </div>
              <small class="muted">{{ a.spec ? "每隔几分钟看一次新说的话：有人点你的名、要你表态，或有和你有关的决定、待办、风险时提醒你；会后给你一份简短纪要。" : "不旁听时只保存记录，会后整理进记忆和事项。" }}机器人入会所有参会人都能看到；会议要允许智能体加入。</small>
              <textarea v-if="a.spec" v-model="a.task" class="input" rows="2" placeholder="要它特别留意的，例如：涉及排期和人力的决定都告诉我" @input="touch" />
            </template>
            <template v-else-if="a.type === 'notify'">
              <UiCheckbox v-model="a.urgent" size="sm" @change="touch">紧急（夜间也推送）</UiCheckbox>
            </template>
            <template v-else-if="a.type === 'delay'">
              <div class="row wrap">
                <span class="small">等</span>
                <input :value="a.minutes / delayUnit(a.minutes)" class="input sm num" type="number" inputmode="numeric" min="1" aria-label="等多久" @input="(e) => setDelay(a, Number((e.target as HTMLInputElement).value), delayUnit(a.minutes))" />
                <UiSelect :model-value="delayUnit(a.minutes)" size="sm" width="96px" :options="[{ value: 1, label: '分钟' }, { value: 60, label: '小时' }, { value: 1440, label: '天' }]" aria-label="单位" @update:model-value="(u) => setDelay(a, a.minutes / delayUnit(a.minutes), Number(u))" />
                <span class="small">再做后面的动作</span>
              </div>
              <small class="muted">后面的动作按触发时的规则和事件做；规则停用或删除就不做了。</small>
            </template>
            <template v-else-if="a.type === 'check'">
              <textarea v-model="a.question" class="input" rows="2" placeholder="要模型判断的问题，例如：这次改动是否涉及上线时间或负责人？" @input="touch" />
              <small class="muted">模型看事件、讨论和前面动作的结果回答“是”或“否”；“否”就不做后面的动作，判断写进触发记录。</small>
            </template>
            <template v-else-if="a.type === 'script'">
              <div class="row wrap">
                <UiSegmented v-model="a.runtime" size="sm" :options="[{ value: 'node', label: 'Node' }, { value: 'python', label: 'Python' }, { value: 'bash', label: 'Bash' }]" aria-label="脚本语言" @change="touch" />
                <label class="row inline small">最长
                  <input v-model.number="a.timeoutSec" class="input sm num" type="number" inputmode="numeric" min="1" max="3600" aria-label="最长运行秒数" @input="touch" />
                  秒</label>
              </div>
              <textarea v-model="a.code" class="input mono small code" rows="8" spellcheck="false" :aria-label="SCRIPT_HINT[a.runtime] + ' 脚本'" @input="touch" />
              <small class="muted">在运行 omem 的这台机器上用 {{ SCRIPT_HINT[a.runtime] }} 执行。事件是 JSON：在环境变量 OMEM_EVENT 里，也从标准输入传进来，不会拼进代码。脚本拿不到 omem 的密钥和令牌，输出记在运行里，失败会通知你。{{ isOwner ? "" : "只有本人能保存带脚本的规则。" }}</small>
              <div class="row wrap">
                <span class="small">执行前</span>
                <UiSelect :model-value="a.approval.by" size="sm" width="160px" :options="approvalOptions" aria-label="谁批准" @update:model-value="(v) => ((a.approval = { ...a.approval, by: v as typeof a.approval.by }), touch())" />
                <input v-if="a.approval.by === 'person'" v-model="a.approval.person" class="input sm" placeholder="审批人的邮箱或飞书名字" aria-label="审批人" @input="touch" />
              </div>
              <textarea v-if="a.approval.by === 'ai'" v-model="a.approval.hint" class="input" rows="2" placeholder="怎么找审批人，例如：改这篇文档的人的直属负责人；找不到就我批准" @input="touch" />
              <small class="muted">{{ a.approval.by === "none" ? "不批准就直接执行：只在你确定脚本对任何触发都安全时这样选。" : a.approval.by === "ai" ? "模型从这次的事件里找出审批人，找不到时由你批准。" : "机器人私聊审批人一张卡片，列出规则、触发的事件和脚本，点“执行”才执行；3 天内没人处理就作废。" }}</small>
            </template>
            <template v-else-if="a.type === 'forward'">
              <div class="row wrap">
                <UiSelect :model-value="a.to.kind === 'origin' ? ORIGIN : a.to.chatId" size="sm" width="300px" :search-at="8" :options="forwardOptions" placeholder="转发到哪个群或私聊" aria-label="转发目标" @update:model-value="(v) => setForwardTarget(a, String(v || ''))" />
              </div>
              <input v-model="a.note" class="input" placeholder="附言（可选），会写在转发内容前面" @input="touch" />
              <small class="muted">{{ a.to.kind === "origin" ? "把前面“等某个会话的新消息”等到的那条发回给提问的人：群里回复在触发的消息下（机器人不在群里先用你的身份拉进去）；私聊则用你的身份建一个你、对方和机器人的群发进去，之后同一个人复用这个群。" : a.to.kind === "p2p" ? "机器人不能在私聊里发言：第一次转发时用你的身份建一个你、对方和机器人的群，之后都发到这个群。" : "用机器人发到这个群，带上来源和发送人；机器人不在群里时先用你的身份把它拉进去。" }}{{ options.botReady ? "" : "还没配置飞书机器人。" }}</small>
            </template>
            <template v-else-if="a.type === 'wait-message'">
              <div class="row wrap">
                <UiSelect :model-value="a.chatId" size="sm" width="300px" :search-at="8" :options="targetChats" placeholder="等哪个会话（比如验证码机器人的私聊）" aria-label="等哪个会话" @update:model-value="(v) => setWaitChat(a, String(v || ''))" />
                <label class="row inline small">最多等
                  <input v-model.number="a.minutes" class="input sm num" type="number" inputmode="numeric" min="1" max="30" aria-label="最多等几分钟" @input="touch" />
                  分钟</label>
              </div>
              <div class="row wrap">
                <input v-model="a.contains" class="input sm" placeholder="要包含的词，比如 验证码" aria-label="要包含的词" @input="touch" />
                <input v-model="a.matches" class="input sm mono" placeholder="或正则，比如 \d{4,6}" aria-label="正则" @input="touch" />
                <span class="small">没等到时</span>
                <UiSegmented :model-value="a.onTimeout" size="sm" :options="[{ value: 'notify', label: '通知我' }, { value: 'none', label: '不做' }]" aria-label="没等到时" @update:model-value="(v: any) => ((a.onTimeout = v), touch())" />
              </div>
              <small class="muted">触发后每 10 秒读一次这个会话，等触发之后的第一条符合的新消息；等到了，后面的动作处理这一条（比如“转发到 · 回到触发的会话”）。</small>
            </template>
            <p v-else-if="a.type === 'invite-bot'" class="muted small">以你的身份把 omem 的机器人加进这个群（只加机器人，不发消息）。{{ options.botReady ? "" : "还没配置飞书机器人。" }}</p>
            <p v-else class="muted small">把这个群设为与你有关：立刻采集一次，之后每次都读并交给整理（免打扰的群也读）。</p>
          </div>
          <UiSelect v-model="addPick" size="sm" width="160px" placeholder="＋ 添加动作" :options="addOptions" aria-label="添加动作" @change="addAction" />
        </section>

        <section v-if="(meetingRule || docRule) && form.id" class="block">
          <div class="block-head">
            <h3>飞书权限</h3>
            <span class="muted small">{{ docRule ? "订阅文档变化用机器人自己的应用" : "入会事件用你的 lark-cli 登录，入会和读会议用机器人自己的应用" }}</span>
            <span class="spacer" />
            <button class="btn ghost sm" :disabled="checking" @click="checkPermissions(form.id!)">{{ checking ? "检查中…" : "重新检查" }}</button>
          </div>
          <Skeleton v-if="checking && !perms" :rows="2" />
          <template v-else-if="perms">
            <div v-for="(x, i) in perms.issues" :key="`i${i}`" class="perm err small">
              <div><strong>{{ x.who }}</strong>：{{ x.problem }}<template v-if="x.scopes?.length">（<code>{{ x.scopes.join("、") }}</code>）</template></div>
              <a v-if="x.link" :href="x.link" target="_blank" rel="noopener">{{ x.linkText ?? "打开" }}</a>
            </div>
            <div v-for="(x, i) in perms.ok" :key="`o${i}`" class="ok small">✓ {{ x }}</div>
            <div v-for="(x, i) in perms.notes" :key="`n${i}`" class="muted small">注意：{{ x }}</div>
            <p v-if="!perms.issues.length" class="muted small">没有发现缺的权限。</p>
          </template>
        </section>

        <section v-if="form.trigger.event === 'message' || meetingRule" class="block">
          <div class="block-head"><h3>{{ meetingRule ? "用最近的会议试一试" : "用最近的消息试一试" }}</h3><span class="muted small">{{ meetingRule ? "只看不做：omem 记下的你最近加入的会议里哪些会命中" : "只看不做：最近三天采集到的消息里哪些会命中" }}</span></div>
          <div class="row wrap">
            <UiSelect v-if="!meetingRule" v-model="testChat" size="sm" width="220px" :options="chatOptions" :search-at="8" aria-label="会话" />
            <UiCheckbox v-if="form.judge !== 'code'" v-model="testAi" size="sm">请模型判断（抽样 5 条）</UiCheckbox>
            <button class="btn sm" :disabled="testing" @click="runTest">{{ testing ? "试运行中…" : "试一试" }}</button>
          </div>
          <template v-if="test">
            <p class="muted small">看了 {{ test.checked }} 条，命中 {{ test.matches.length }} 条。{{ test.note }}</p>
            <div v-for="m in test.matches" :key="m.messageId" class="hit small">
              <div class="row"><strong class="ellipsis">{{ m.chat }}</strong><span class="muted">· {{ m.sender }} · {{ fmtTime(m.at) }}</span></div>
              <div class="clamp">{{ m.text }}</div>
              <div class="muted">{{ m.by === "code" ? "条件" : "模型" }}：{{ m.reason }}</div>
              <div v-if="m.action">入会方式：{{ m.action }}</div>
            </div>
          </template>
        </section>

        <section v-if="form.id" class="block">
          <div class="block-head"><h3>触发记录</h3><span class="muted small">命中 {{ form.hits ?? 0 }} 次</span></div>
          <div v-for="f in firings" :key="f.id" class="firing small">
            <div class="row"><span class="muted">{{ fmtTime(f.at) }}</span><span class="badge">{{ f.judgedBy === "code" ? "条件" : f.judgedBy === "limit" ? "超额" : "模型" }}</span></div>
            <div>{{ f.summary }}</div>
            <div v-if="f.reason" class="muted">判断：{{ f.reason }}</div>
            <div v-for="(x, i) in f.results" :key="i" :class="x.ok ? 'ok' : 'err'">
              {{ x.ok ? "✓" : "✗" }} {{ ACTION_LABEL[x.action as Action["type"]] ?? x.action }}：{{ x.detail }}
              <router-link v-if="x.runId" :to="`/runs/${x.runId}`">运行</router-link>
            </div>
          </div>
          <p v-if="!firings.length" class="muted small">还没有触发过。</p>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.rules {
  display: flex;
  height: 100%;
}
.list-col {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  gap: 8px;
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
}
.hint {
  padding: 6px 10px;
}
.li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
}
.li:hover {
  background: var(--hover);
}
.group {
  padding: 14px 10px 4px;
  border-top: 1px solid var(--line);
  margin-top: 8px;
}
.wake .row {
  gap: 6px;
}
.li.on {
  background: var(--accent-soft);
}
.pick {
  border: 0;
  background: none;
  text-align: left;
  color: var(--ink);
  cursor: pointer;
  padding: 0;
  min-width: 0;
  font: inherit;
}
.grow {
  flex: 1;
  min-width: 0;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.page {
  max-width: 880px;
  padding: 16px 24px 40px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.dh {
  gap: 10px;
  flex-wrap: wrap;
}
.title {
  flex: 1;
  min-width: 160px;
  font-size: 16px;
  font-weight: 600;
}
.block {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  /* One column no wider than the block: a long row (the five triggers) scrolls inside it on a phone. */
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.block-head h3 {
  margin: 0;
  font-size: 14px;
}
.wrap {
  flex-wrap: wrap;
  gap: 8px;
}
.num {
  width: 72px;
}
.inline {
  gap: 6px;
}
.cron {
  width: 160px;
}
.action {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  display: grid;
  gap: 6px;
  background: var(--panel, var(--bg));
}
.action .code {
  line-height: 1.5;
  tab-size: 2;
  white-space: pre;
  overflow-x: auto;
}
.hit,
.firing {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  display: grid;
  gap: 2px;
}
.ok {
  color: var(--ok);
}
.perm {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}
.perm a {
  flex: none;
}
.err {
  color: var(--danger);
}
.empty {
  max-width: 620px;
  margin: 50px auto;
  text-align: center;
  color: var(--ink-2);
  padding: 0 16px;
  display: grid;
  gap: 10px;
  justify-items: center;
}
.examples {
  display: grid;
  gap: 6px;
  width: 100%;
}
.example {
  text-align: left;
  border: 1px dashed var(--line-strong, var(--line));
  border-radius: 8px;
  padding: 8px 12px;
  background: none;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.example:hover {
  border-color: var(--accent);
  color: var(--accent);
}
@media (max-width: 760px) {
  .rules {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 36vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .page {
    padding: 12px 16px 32px;
  }
}
</style>
