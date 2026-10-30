<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { del, get, post, put } from "../api";
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
  | { type: "agent"; spec: string; space?: string; task: string; ownTopic: boolean; reply: Reply | "silent"; allowUrgent?: boolean; allowPrivate?: boolean; ai?: { profile: string; model?: string; effort?: string } }
  | { type: "watch"; spec: string; on: "all" | "mention" | "keyword"; pattern?: string; reply: Reply }
  | { type: "invite-bot" }
  | { type: "capture" }
  | { type: "notify"; urgent: boolean }
  | { type: "meeting-bot"; bots: string[]; confirm: boolean | Condition; record: boolean; spec: string; space?: string; task: string; answer: boolean; importShared: boolean; leaveWithOwner: boolean };
type Rule = {
  id?: string;
  spaceId?: string;
  conversationId?: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: { event: "message" | "chat-new" | "schedule" | "meeting"; once: "event" | "chat"; cron?: string; waitMinutes: number; unless: Unless[] };
  conditions: Condition | null;
  judge: "code" | "ai" | "code+ai";
  actions: Action[];
  hits?: number;
  lastFiredAt?: string | null;
  conditionText?: string;
  createdBy?: string;
};
type Firing = { id: number; at: string; summary: string; judgedBy: string; reason: string; results: { action: string; ok: boolean; detail: string; runId?: string }[] };
type Options = { fields: Record<string, string>; eventFields?: Record<"message" | "meeting", string[]>; bots?: { id: string; name: string }[]; ops: string[]; specs: { name: string; description: string; agent?: string }[]; backends?: { id: string; name: string; installed: boolean; transport?: string; model?: string; effort?: string; probe?: any }[]; chats: { chat_id: string; name: string }[]; botReady: boolean; groups: { chat_id: string; name: string }[]; conversations: { id: string; title: string; channel: string; space_id: string; external_id: string | null }[] };
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

const blank = (): Rule => ({ name: "", description: "", enabled: false, trigger: { event: "message", once: "event", waitMinutes: 0, unless: [] }, conditions: null, judge: "code", actions: [{ type: "agent", spec: "assistant", task: "", ownTopic: false, reply: "none" }] });

async function loadList() {
  try {
    [rules.value, wakes.value, watches.value] = await Promise.all([get<Rule[]>(`/api/rules?space=${encodeURIComponent(state.space)}`), get<Wake[]>("/api/wakes").catch(() => []), get<Watch[]>("/api/watches").catch(() => [])]);
  } finally {
    loading.value = false;
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
async function loadCurrent() {
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
    firings.value = r.firings;
    form.value = { ...r };
    dirty.value = false;
    perms.value = null;
    if (r.trigger.event === "meeting") void checkPermissions(r.id!);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
onMounted(async () => {
  await Promise.all([loadList(), get<Options>("/api/rule-options").then((o) => (options.value = o)).catch(() => {})]);
  await loadCurrent();
});
watch(() => [route.query.id, route.query.new], () => void loadCurrent());
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
    const body = { spaceId: f.spaceId, conversationId: f.conversationId, name: f.name, description: f.description, enabled: f.enabled, trigger: f.trigger, conditions: f.conditions, judge: f.judge, actions: f.actions };
    const saved = f.id ? await put<Rule>(`/api/rules/${f.id}`, body) : await post<Rule>("/api/rules", body);
    dirty.value = false;
    toast("已保存", "ok");
    await loadList();
    if (!f.id) await router.replace({ query: { id: saved.id! } });
    else await loadCurrent();
    if (f.trigger.event === "meeting") void checkPermissions(saved.id!);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
async function toggle(r: Rule) {
  try {
    await put(`/api/rules/${r.id}`, { spaceId: r.spaceId, conversationId: r.conversationId, name: r.name, description: r.description, enabled: !r.enabled, trigger: r.trigger, conditions: r.conditions, judge: r.judge, actions: r.actions });
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
const ACTION_LABEL: Record<Action["type"], string> = { agent: "交给 Agent", watch: "持续监听这个群", "invite-bot": "拉机器人进群", capture: "优先采集这个群", notify: "通知我", "meeting-bot": "拉机器人入会" };
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
    : type === "meeting-bot" ? meetingAction()
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
const meetingAction = (): Action => ({ type: "meeting-bot", bots: options.value.bots?.length ? [options.value.bots[0].id] : [], confirm: true, record: true, spec: "", task: "", answer: false, importShared: true, leaveWithOwner: true });
const confirmOptions = [{ value: "always", label: "始终询问" }, { value: "never", label: "直接加入" }, { value: "condition", label: "满足条件时询问" }];
function setConfirmation(a: Extract<Action, { type: "meeting-bot" }>, mode: string) {
  a.confirm = mode === "always" ? true : mode === "never" ? false : { field: "meeting.invitedCount", op: "gte", value: "30" };
  touch();
}
const addOptions = computed(() =>
  (Object.keys(ACTION_LABEL) as Action["type"][])
    .filter((t) => (meetingRule.value ? ["meeting-bot", "notify"].includes(t) : t !== "meeting-bot"))
    .filter((t) => !scheduleOnly.value || t === "agent" || t === "notify")
    .map((t) => ({ value: t as string | null, label: ACTION_LABEL[t], hint: t === "invite-bot" && !options.value.botReady ? "需要先配置飞书机器人" : "" })),
);

// ---- meetings ---------------------------------------------------------------------------
/** The condition fields that make sense for this trigger: a meeting has no chat or message. */
const condFields = computed(() => {
  const keys = options.value.eventFields?.[meetingRule.value ? "meeting" : "message"];
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
    perms.value = await get<Perms>(`/api/rules/${id}/permissions`);
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
    test.value = await post<TestResult>("/api/rules/test", { rule: { name: f.name || "试运行", description: f.description || "试运行", trigger: f.trigger, conditions: f.conditions, judge: f.judge, actions: f.actions }, chatId: testChat.value ?? undefined, ai: testAi.value });
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    testing.value = false;
  }
}
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
            <UiSegmented v-model="form.trigger.event" size="sm" :options="[{ value: 'message', label: '新消息' }, { value: 'chat-new', label: '第一次看到的群' }, { value: 'schedule', label: '定时' }, { value: 'meeting', label: '我加入会议时' }]" aria-label="触发" @change="onTrigger" />
            <UiSegmented v-if="form.trigger.event === 'message'" v-model="form.trigger.once" size="sm" :options="[{ value: 'event', label: '每条消息' }, { value: 'chat', label: '每个群只一次' }]" aria-label="触发次数" @change="touch" />
            <input v-if="form.trigger.event === 'schedule'" v-model="form.trigger.cron" class="input sm mono cron" placeholder="0 9 * * 1-5" aria-label="cron" @input="touch" />
            <UiSelect v-if="form.trigger.event !== 'schedule' && !meetingRule" :model-value="form.spaceId ?? ''" size="sm" width="200px" :options="spaceOptions('所有空间的群')" aria-label="只看哪个空间的群" @update:model-value="(v) => ((form!.spaceId = String(v || '')), touch())" />
            <UiSelect v-if="meetingRule" :model-value="form.spaceId ?? ''" size="sm" width="200px" :options="spaceOptions('会议记录放默认空间')" aria-label="会议记录放哪个空间" @update:model-value="(v) => ((form!.spaceId = String(v || '')), touch())" />
          </div>
          <div v-if="form.trigger.event === 'message'" class="row wrap">
            <label class="row inline small">命中后等
              <input v-model.number="form.trigger.waitMinutes" class="input sm num" type="number" inputmode="numeric" min="0" max="1440" aria-label="等待分钟" @input="touch" />
              分钟再处理</label>
            <UiCheckbox v-model="form.trigger.unless" value="owner-engaged" size="sm" @change="touch">我已在这段讨论里就跳过</UiCheckbox>
            <UiCheckbox v-model="form.trigger.unless" value="answered" size="sm" @change="touch">已有人回复就跳过</UiCheckbox>
          </div>
          <small v-if="form.trigger.event === 'message'" class="muted">“每个群只一次”适合拉机器人、开始监听这类一次就够的事。等待和跳过在动手前看一眼这段讨论：你在话题里或半小时内在群里说过话，算“已在讨论里”。</small>
          <small v-else-if="form.trigger.event === 'schedule'" class="muted">cron 写法：分 时 日 月 周，例如 0 9 * * 1-5 是工作日早上 9 点。</small>
          <small v-else-if="meetingRule" class="muted">你加入一场飞书视频会议时判断（用你的 lark-cli 登录接收入会事件）。每场会议对这条规则只触发一次；入会后十分钟内参会人变了会再判断一次。不写条件就是每场会议。</small>
        </section>

        <section v-if="form.trigger.event !== 'schedule'" class="block">
          <div class="block-head"><h3>满足什么</h3></div>
          <div class="row wrap">
            <UiSegmented v-model="form.judge" size="sm" :options="[{ value: 'code', label: '按条件' }, { value: 'code+ai', label: '条件 + AI 确认' }, { value: 'ai', label: '交给 AI 判断' }]" aria-label="判断方式" @change="touch" />
            <small class="muted">{{ judgeHint }}</small>
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
                <UiSegmented v-model="a.reply" size="sm" :options="scheduleOnly ? scheduleReplyOptions : agentReplyOptions" aria-label="回复方式" @change="touch" />
                <UiCheckbox v-if="!scheduleOnly && a.reply !== 'silent'" v-model="a.ownTopic" size="sm" :disabled="a.reply === 'none'" @change="touch">在消息下开话题</UiCheckbox>
              </div>
              <div v-if="scheduleOnly && a.reply !== 'none'" class="row wrap">
                <span class="small">发到</span>
                <UiSelect :model-value="destinationValue" size="sm" width="260px" :search-at="8" :options="conversationOptions" aria-label="结果发到哪个会话" @update:model-value="(v) => ((form!.conversationId = String(v || '')), touch())" />
              </div>
              <small v-if="scheduleOnly && a.reply !== 'none' && !form.conversationId" class="muted">尚未指定投递目标。请选择会话或已采集的群聊；向群里发送需要机器人已在群中。</small>
              <small class="muted">{{ scheduleOnly && a.reply !== 'none' ? (a.reply === 'auto' ? "结论直接发到选定的会话。" : "它要在群里说的话先变成给你确认的草稿，你点发送才发到这个群（话题）；结论另外发给你。") : REPLY_HINT[a.reply] }}</small>
              <div v-if="!scheduleOnly && a.reply !== 'none'" class="row wrap">
                <UiCheckbox :model-value="!!a.allowUrgent" size="sm" @change="(v) => ((a.allowUrgent = v), touch())">允许加急</UiCheckbox>
                <UiCheckbox :model-value="!!a.allowPrivate" size="sm" @change="(v) => ((a.allowPrivate = v), touch())">允许只给部分人看</UiCheckbox>
                <small class="muted">什么时候用、对谁用写在要求里，没写就不用</small>
              </div>
              <div class="row wrap">
                <UiCheckbox :model-value="!!a.ai" size="sm" @change="(v) => toggleAI(a, v)">指定 AI</UiCheckbox>
                <small class="muted">{{ a.ai ? "这条规则交出去的运行用下面选的后端、模型和思考强度。" : `不指定就用档案自己的设置${specAgent(a.spec) ? `（${specAgent(a.spec)}）` : ""}；模型写在要求里不会生效。` }}</small>
              </div>
              <AiDefaults v-if="a.ai" :model-value="{ agent: a.ai.profile, model: a.ai.model, effort: a.ai.effort }" :backends="options.backends ?? []" :default-backend="specAgent(a.spec)" @update:model-value="(v) => setAI(a, v)" @change="touch" />
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
            <p v-else-if="a.type === 'invite-bot'" class="muted small">以你的身份把 omem 的机器人加进这个群（只加机器人，不发消息）。{{ options.botReady ? "" : "还没配置飞书机器人。" }}</p>
            <p v-else class="muted small">把这个群设为与你有关：立刻采集一次，之后每次都读并交给整理（免打扰的群也读）。</p>
          </div>
          <UiSelect v-model="addPick" size="sm" width="160px" placeholder="＋ 添加动作" :options="addOptions" aria-label="添加动作" @change="addAction" />
        </section>

        <section v-if="meetingRule && form.id" class="block">
          <div class="block-head">
            <h3>飞书权限</h3>
            <span class="muted small">入会事件用你的 lark-cli 登录，入会和读会议用机器人自己的应用</span>
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
